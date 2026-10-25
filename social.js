/* ============================================================
 * 视唱练耳 · 社交页（局域网练习项目，第四十轮新增）
 * ------------------------------------------------------------
 * 职责：设备身份（随机昵称 + 颜色圆点）、公共留言板、
 *       轮询拉取新留言、离线时留言先存本机队列、连上后自动上传。
 * 依赖：无（不碰 chord_recognition.js 的任何状态；接口不通时整页安静降级）。
 * 部署：前端由 Nginx 静态服务，接口走同源 /api/（Nginx 反代到 Node :3000）。
 *       在 GitHub Pages 等非局域网环境打开时，/api/ping 永远不通 →
 *       显示「未连接」，留言进本机队列，不会报错。
 *
 * ★ 可整体摘除：删掉本文件 + index.html 里的四块（i-social 图标、
 *   顶栏第三个按钮、#view-social 骨架、.soc-* CSS）+ 引入行即可，零残留。
 * ============================================================ */
(function () {
    'use strict';
    if (typeof document === 'undefined') return; // Node 侧 require 容错（与主模块同款守卫）

    /* ---------- 昵称随机池：古今中外音乐家 + 音乐术语 + 乐器，混搭 ---------- */
    const POOL_COMPOSERS = [
        '巴赫', '亨德尔', '海顿', '莫扎特', '贝多芬', '舒伯特', '舒曼', '勃拉姆斯',
        '肖邦', '李斯特', '门德尔松', '柴可夫斯基', '德彪西', '拉威尔', '萨蒂',
        '拉赫玛尼诺夫', '斯克里亚宾', '马勒', '维瓦尔第', '帕赫贝尔', '帕格尼尼',
        '罗西尼', '威尔第', '比才', '德沃夏克', '格里格', '西贝柳斯', '圣桑', '古诺',
        '约翰·施特劳斯', '冼星海', '聂耳', '贺绿汀', '阿炳', '黄自', '丁善德', '朱践耳'
    ];
    const POOL_TERMS = [
        '快板', '慢板', '行板', '柔板', '急板', '赋格', '卡农', '咏叹调', '回旋曲',
        '变奏曲', '前奏曲', '练习曲', '夜曲', '小夜曲', '奏鸣曲', '幻想曲', '托卡塔',
        '序曲', '间奏曲', '摇篮曲', '进行曲', '圆舞曲', '玛祖卡', '萨拉班德', '吉格',
        '利切卡尔', '康塔塔', '颤音', '波音', '倚音', '琶音', '泛音', '共鸣', '转调',
        '离调', '半音', '固定调', '首调', '终止式', '属七', '导音', '断奏', '连奏',
        '渐强', '渐弱'
    ];
    const POOL_INSTRUMENTS = [
        '小提琴', '中提琴', '大提琴', '低音提琴', '竖琴', '长笛', '双簧管', '单簧管',
        '大管', '圆号', '小号', '长号', '大号', '定音鼓', '小军鼓', '三角铁', '钢琴',
        '管风琴', '羽管键琴', '手风琴', '吉他', '曼陀林', '尤克里里', '古琴', '古筝',
        '琵琶', '二胡', '扬琴', '竹笛', '洞箫', '唢呐', '笙', '编钟', '木琴',
        '马林巴', '钢片琴'
    ];
    /* 标识色池：一组明快、互相拉得开的颜色（按设备随机取一个，终身不变） */
    const POOL_COLORS = [
        '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#10b981',
        '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
        '#a855f7', '#ec4899', '#f43f5e', '#d97706'
    ];

    /* ---------- 本机存储键 ---------- */
    const LS_ID = 'soc_device_id';
    const LS_PROFILE = 'soc_profile';
    const LS_QUEUE = 'soc_queue';
    const LS_LAST = 'soc_last_id';

    /* ---------- 轮询/重试节奏 ---------- */
    const POLL_MS = 4000;        // 在线时拉新留言的间隔
    const PING_ONLINE_MS = 20000;   // 在线时保活探测间隔
    const PING_OFFLINE_MS = 5000;   // 离线时重连探测间隔

    /* ---------- 小工具 ---------- */
    function lsGet(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        } catch (e) { return fallback; }
    }
    function lsSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function randomName() {
        // 六成「术语的乐器」（如：赋格的管风琴），四成直接用音乐家名
        return Math.random() < 0.6
            ? pick(POOL_TERMS) + '的' + pick(POOL_INSTRUMENTS)
            : pick(POOL_COMPOSERS);
    }
    function fmtTime(ts) {
        const d = new Date(ts);
        const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const now = new Date();
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    }

    /* ---------- 状态 ---------- */
    const state = {
        deviceId: lsGet(LS_ID, null),
        profile: lsGet(LS_PROFILE, null),   // { name, color }
        queue: lsGet(LS_QUEUE, []),          // [{ clientId, text, ts }] 待上传留言
        lastId: lsGet(LS_LAST, 0),           // 已见过的最大留言 id（增量拉取）
        online: false,
        registered: false,                    // 本次会话是否已向服务器同步过身份
        flushing: false
    };

    /* ---------- DOM ---------- */
    const els = {};
    function q(id) { return document.getElementById(id); }

    /* ============================================================
     * 身份：首次访问生成 deviceId + 昵称 + 颜色（全部本机完成，
     * 离线也能起名字；连上服务器后再把资料报备上去）。
     * ============================================================ */
    function ensureIdentity() {
        if (!state.deviceId) {
            state.deviceId = uuid();
            lsSet(LS_ID, state.deviceId);
        }
        if (!state.profile) {
            state.profile = { name: randomName(), color: pick(POOL_COLORS) };
            lsSet(LS_PROFILE, state.profile);
        }
    }

    /* 把本机最新资料报备给服务器（幂等 upsert：改名后的补报也走这里） */
    async function syncIdentity() {
        const r = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: state.deviceId,
                name: state.profile.name,
                color: state.profile.color
            })
        });
        if (!r.ok) throw new Error('register http ' + r.status);
        const j = await r.json();
        if (j && j.ok && j.device) {
            state.profile = { name: j.device.name, color: j.device.color };
            lsSet(LS_PROFILE, state.profile);
            paintIdentity();
        }
        state.registered = true;
    }

    /* ============================================================
     * 连接管理：ping 循环 + 可见性判断。
     * 页面切到后台时一律不发请求（iOS 上省电，也不刷服务器日志）。
     * ============================================================ */
    let pingTimer = null;
    let pollTimer = null;

    function visible() { return document.visibilityState === 'visible'; }

    async function ping() {
        if (!visible()) return;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            const r = await fetch('/api/ping?cb=' + Date.now(), { signal: ctrl.signal });
            clearTimeout(t);
            if (!r.ok) throw new Error('ping http ' + r.status);
            if (!state.online) setOnline(true);
            if (!state.registered) {
                try { await syncIdentity(); } catch (e) {}
            }
        } catch (e) {
            if (state.online) setOnline(false);
        }
    }

    function setOnline(on) {
        state.online = on;
        paintNet();
        if (on) {
            startPolling();
            flushQueue();        // 一上线先把攒的留言发出去
        } else {
            stopPolling();
        }
    }

    function startPingLoop() {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (!state.online) ping();               // 离线 → 快速重试
            else if (visible() && !pollTimer) ping(); // 在线但轮询意外停了 → 补探测
        }, PING_OFFLINE_MS);
        // 在线保活：低频独立定时器
        setInterval(() => { if (state.online && visible()) ping(); }, PING_ONLINE_MS);
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => { if (visible()) pollMessages().catch(() => {}); }, POLL_MS);
        pollMessages().catch(() => {});
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /* ============================================================
     * 留言：拉取（增量）+ 发送（本机队列兜底）
     * ============================================================ */
    async function pollMessages() {
        const r = await fetch('/api/messages?after=' + encodeURIComponent(state.lastId));
        if (!r.ok) throw new Error('messages http ' + r.status);
        const j = await r.json();
        if (!j || !j.ok) throw new Error('messages bad payload');
        const list = (j.messages || []);
        for (const m of list) upsertMessage(m);
        if (list.length) {
            state.lastId = list[list.length - 1].id;
            lsSet(LS_LAST, state.lastId);
        }
    }

    /* 服务器的一条留言 → 渲染。若本机已有同 clientId 的"待上传"条目，就地升级它 */
    function upsertMessage(m) {
        const pending = els.list.querySelector('.soc-msg[data-cid="' + m.clientId + '"]');
        if (pending) pending.remove();
        appendMessage({
            cid: m.clientId,
            name: m.name || '（未注册设备）',
            color: m.color || '#9aa1b0',
            text: m.text,
            ts: m.ts,
            mine: m.deviceId === state.deviceId,
            pending: false
        });
    }

    function appendMessage(m) {
        const row = document.createElement('div');
        row.className = 'soc-msg' + (m.mine ? ' is-mine' : '') + (m.pending ? ' is-pending' : '');
        row.dataset.cid = m.cid;

        const dot = document.createElement('span');
        dot.className = 'soc-msg__dot';
        dot.style.background = m.color;

        const body = document.createElement('div');
        body.className = 'soc-msg__body';

        const meta = document.createElement('div');
        meta.className = 'soc-msg__meta';
        const name = document.createElement('b');
        name.textContent = m.name;
        const badge = document.createElement('span');
        badge.className = 'soc-msg__mine';
        badge.textContent = m.mine ? '我' : '';
        if (!m.mine) badge.style.display = 'none';
        const time = document.createElement('time');
        time.textContent = fmtTime(m.ts);
        const pend = document.createElement('span');
        pend.className = 'soc-msg__pending';
        pend.textContent = m.pending ? '待上传' : '';
        if (!m.pending) pend.style.display = 'none';
        meta.appendChild(name); meta.appendChild(badge); meta.appendChild(pend); meta.appendChild(time);

        const text = document.createElement('div');
        text.className = 'soc-msg__text';
        text.textContent = m.text;

        body.appendChild(meta); body.appendChild(text);
        row.appendChild(dot); row.appendChild(body);
        els.list.appendChild(row);
        els.list.scrollTop = els.list.scrollHeight;
    }

    function sendMessage() {
        const text = (els.input.value || '').trim();
        if (!text) return;
        els.input.value = '';
        const item = { clientId: uuid(), text: text, ts: Date.now() };
        state.queue.push(item);
        lsSet(LS_QUEUE, state.queue);
        // 乐观渲染：先在本机显示"待上传"，连上后由轮询升级成正式消息
        appendMessage({
            cid: item.clientId, name: state.profile.name, color: state.profile.color,
            text: item.text, ts: item.ts, mine: true, pending: true
        });
        paintQueue();
        flushQueue();
    }

    /* 把本机队列逐条 POST 出去；失败就停（下次上线 / 下次发送再续传） */
    async function flushQueue() {
        if (!state.online || state.flushing || !state.queue.length) return;
        state.flushing = true;
        try {
            while (state.queue.length && state.online) {
                const item = state.queue[0];
                const r = await fetch('/api/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deviceId: state.deviceId,
                        clientId: item.clientId,
                        text: item.text
                    })
                });
                if (!r.ok) throw new Error('send http ' + r.status);
                const j = await r.json();
                if (!j || !j.ok) throw new Error('send bad payload');
                state.queue.shift();
                lsSet(LS_QUEUE, state.queue);
                paintQueue();
            }
            pollMessages().catch(() => {}); // 发完了立刻拉一轮，让"待上传"尽快转正
        } catch (e) {
            if (state.online) setOnline(false);
        } finally {
            state.flushing = false;
        }
    }

    /* ============================================================
     * 渲染：身份卡 / 连接徽标 / 队列提示 / 改名
     * ============================================================ */
    function paintIdentity() {
        els.myDot.style.background = state.profile.color;
        els.myName.textContent = state.profile.name;
    }
    function paintNet() {
        els.net.classList.toggle('is-online', state.online);
        els.netText.textContent = state.online ? '已连接' : '未连接 · 连上家里 Wi-Fi 后自动同步';
        els.queueHint.textContent = state.online
            ? ''
            : (state.queue.length ? '离线中 · 本机已存 ' + state.queue.length + ' 条待上传' : '');
    }
    function paintQueue() {
        paintNet();
    }

    /* 改名：点昵称 → 原地变输入框 → 回车/失焦确认（空值取消） */
    function beginRename() {
        if (els.myName.querySelector('input')) return;
        const old = state.profile.name;
        const input = document.createElement('input');
        input.className = 'soc-rename';
        input.type = 'text';
        input.maxLength = 24;
        input.value = old;
        els.myName.textContent = '';
        els.myName.appendChild(input);
        input.focus();
        input.select();

        let done = false;
        const commit = async () => {
            if (done) return;
            done = true;
            const v = (input.value || '').trim();
            if (v && v !== old) {
                state.profile.name = v;
                lsSet(LS_PROFILE, state.profile);
                if (state.online) {
                    try { await syncIdentity(); } catch (e) {}
                }
            }
            paintIdentity();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { done = true; paintIdentity(); }
        });
        input.addEventListener('blur', commit);
    }

    /* ============================================================
     * 入口
     * ============================================================ */
    function init() {
        els.myDot = q('soc-my-dot');
        els.myName = q('soc-my-name');
        els.net = q('soc-net');
        els.netText = q('soc-net-text');
        els.list = q('soc-list');
        els.input = q('soc-input');
        els.send = q('soc-send');
        els.queueHint = q('soc-queue-hint');
        if (!els.list) return; // 骨架不存在（异常情况）时静默退出

        ensureIdentity();
        paintIdentity();
        paintNet();

        // 首屏：先拉最近一批留言（不管在不在服务器上，失败就当离线）
        pollMessages()
            .then(() => { /* 有网，交给 ping 循环维持 */ })
            .catch(() => {});

        els.myName.addEventListener('click', beginRename);
        els.send.addEventListener('click', sendMessage);
        els.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.online) {
                pollMessages().catch(() => {});
            }
        });

        startPingLoop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* 调试 / 验收出口（只读 + 手动触发） */
    window.SocialUI = {
        _state: () => state,
        ping: () => ping(),
        poll: () => pollMessages(),
        flush: () => flushQueue(),
        onShow: () => { ping(); }
    };
})();
