/* ============================================================
 * 视唱练耳 · 局域网社交后端（自学前后端练习项目）
 * ------------------------------------------------------------
 * 职责：只提供 /api/ 开头的 JSON 接口，不渲染 HTML。
 *       页面等静态文件全部由 Nginx 负责，Nginx 把 /api/ 转发到本服务。
 * 存储：SQLite（就是一个文件 data.sqlite，备份 = 复制该文件）。
 * 运行：node server.js   （生产环境由 systemd 拉起，见 shichanglianer.service）
 * ============================================================ */

'use strict';

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;

/* ---------- 数据库 ----------
 * 默认 data.sqlite（WAL 模式）；SOCIAL_DB=':memory:' 时用内存库（自动化冒烟用，重启即清）。 */
const DB_FILE = process.env.SOCIAL_DB || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_FILE);
if (DB_FILE !== ':memory:') db.pragma('journal_mode = WAL'); // 读写并发更顺滑，练手阶段用默认也行

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    device_id  TEXT PRIMARY KEY,   -- 设备唯一标识（前端首次访问时随机生成，存在 localStorage）
    name       TEXT NOT NULL,      -- 昵称（前端从随机池生成，可改）
    color      TEXT NOT NULL,      -- 用户标识小圆点的颜色（#rrggbb）
    created_at INTEGER NOT NULL     -- 注册时间戳（毫秒）
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  TEXT UNIQUE NOT NULL, -- 客户端生成的消息唯一 id：离线队列重传时靠它去重
    device_id  TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
`);

/* ---------- 常用语句（prepare 一次，反复执行） ---------- */
const stUpserUser = db.prepare(`
    INSERT INTO users (device_id, name, color, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, color = excluded.color`);
const stGetUser   = db.prepare('SELECT device_id AS id, name, color FROM users WHERE device_id = ?');
const stInsMsg    = db.prepare(`
    INSERT OR IGNORE INTO messages (client_id, device_id, text, created_at)
    VALUES (?, ?, ?, ?)`);
const stMsgById   = db.prepare('SELECT id FROM messages WHERE client_id = ?');
const stListAfter = db.prepare(`
    SELECT m.id, m.client_id AS clientId, m.device_id AS deviceId,
           m.text, m.created_at AS ts, u.name, u.color
    FROM messages m LEFT JOIN users u ON u.device_id = m.device_id
    WHERE m.id > ?
    ORDER BY m.id ASC
    LIMIT ?`);
const stListRecent = db.prepare(`
    SELECT m.id, m.client_id AS clientId, m.device_id AS deviceId,
           m.text, m.created_at AS ts, u.name, u.color
    FROM messages m LEFT JOIN users u ON u.device_id = m.device_id
    ORDER BY m.id DESC
    LIMIT ?`);

/* ---------- 应用 ---------- */
const app = express();
app.use(express.json({ limit: '16kb' }));

// 访问日志：练习阶段看得到"谁在什么时候请求了什么"就够排查了
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

function isStr(v, max) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/** 健康检查：前端靠它判断"是否连上了局域网服务器" */
app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, name: '视唱练耳社交', time: Date.now() });
});

/**
 * 注册 / 同步设备身份。
 * 昵称与颜色由前端随机池生成后带来（离线也能先生成），重复调用 = 用最新资料覆盖
 * （因此改名后离线补报也走这个接口，天然幂等）。
 */
app.post('/api/register', (req, res) => {
    const { deviceId, name, color } = req.body || {};
    if (!isStr(deviceId, 64) || !isStr(name, 24) || !isStr(color, 9)) {
        return res.status(400).json({ ok: false, error: 'bad request' });
    }
    stUpserUser.run(deviceId, name.trim(), color, Date.now());
    res.json({ ok: true, device: stGetUser.get(deviceId) });
});

/** 只改昵称（设备必须已注册过） */
app.post('/api/profile', (req, res) => {
    const { deviceId, name } = req.body || {};
    if (!isStr(deviceId, 64) || !isStr(name, 24)) {
        return res.status(400).json({ ok: false, error: 'bad request' });
    }
    const info = db.prepare('UPDATE users SET name = ? WHERE device_id = ?').run(name.trim(), deviceId);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'unknown device' });
    res.json({ ok: true, device: stGetUser.get(deviceId) });
});

/**
 * 拉留言（增量）：
 *   ?after=已见过的最大 id → 返回比它新的留言（正序）
 *   首次不传 after（或传 0） → 返回最近 100 条（正序返回）
 */
app.get('/api/messages', (req, res) => {
    const after = Number(req.query.after) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const rows = after > 0 ? stListAfter.all(after, limit) : stListRecent.all(limit).reverse();
    res.json({ ok: true, messages: rows, serverTime: Date.now() });
});

/** 发留言：clientId 由前端生成（UUID），INSERT OR IGNORE 保证离线重传不会发重 */
app.post('/api/messages', (req, res) => {
    const { deviceId, clientId, text } = req.body || {};
    if (!isStr(deviceId, 64) || !isStr(clientId, 64) || !isStr(text, 500)) {
        return res.status(400).json({ ok: false, error: 'bad request' });
    }
    const info = stInsMsg.run(clientId, deviceId, text.trim(), Date.now());
    const row = stMsgById.get(clientId);
    res.json({ ok: true, id: row ? row.id : null, duplicate: info.changes === 0 });
});

/* 兜底：未知的 /api 路径一律 404 JSON，而不是 Nginx 的 HTML 404 */
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

app.listen(PORT, () => {
    console.log(`社交后端已启动：http://127.0.0.1:${PORT}  （由 Nginx 反代 /api/ 到这里）`);
});
