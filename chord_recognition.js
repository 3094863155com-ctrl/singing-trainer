// ============================================================
// chord_recognition.js —— 「和弦听辨」模块（与 index active.html 主体隔离）
//
// 设计目标（仿 harmony_melody.js 风格）：
//   1. 自包含：调式拼写、和弦进行、配声、记谱全部内部实现
//   2. 接口最小：只暴露 window.ChordRecognition
//   3. 音频能力复用：采样加载 / WAV 编码 由宿主通过 window.ChordHost 只读提供
//   4. 只播放、不判分：给出一段和弦连接，纯听 + 看谱
//
// 音源：爱丽丝钢琴（Alicia's Keys）采样，命名 音源/和弦钢琴/piano_<midi>.mp3
//       采样由 tools/build_pitch_sweep.py + REAPER + Kontakt 渲染得到
// ============================================================

(function (global) {
    'use strict';

    // ------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------

    // 12 个大调（本轮只随机大调；用户已确认不涉及离调）
    const MAJOR_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'];

    const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

    const SAMPLE_DIR = '音源/和弦钢琴/';
    const SAMPLE_MIDI_LO = 36;   // C2
    const SAMPLE_MIDI_HI = 84;   // C6

    // 配声音域：单行高音谱表的舒适区。
    // 低音锚点只用 C4 / C5 两个八度 —— 若允许 C3，最低音会掉到 4 条下加线以下，谱面很难看。
    const VOICE_LO = 57;         // A3，约 2 条下加线
    const VOICE_HI = 84;         // C6

    // 罗马数字（与大调形态一致：Ⅰ ⅱ ⅲ Ⅳ Ⅴ ⅵ ⅶ°）
    const ROMAN_MAJOR = ['Ⅰ', 'ⅱ', 'ⅲ', 'Ⅳ', 'Ⅴ', 'ⅵ', 'ⅶ°'];
    const DEGREE_CHOICES = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ'];

    // 转位数字（上标/下标）
    const SUP = { 6: '⁶', 7: '⁷' };
    const SUB = { 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆' };

    const SETTINGS_KEY = 'chordTrainerSettings';

    // ---- 奏法（连奏程度）----
    // 每个和弦音"按住"的时长 = 一拍 × LEGATO。钢琴采样本身就在自然衰减，
    // 只要不人为把它压下去，按住就能得到连贯的声音。
    //   ★ 用户 2026-10-06 拍板：固定 1.0（按满一拍、到下一拍才换）。
    //     设置页那个可拖动的「连奏」滑块已删除，不再提供断奏 / 更连贯两档。
    const LEGATO = 1.00;
    const CHORD_RELEASE = 0.12;   // 松手淡出时长（秒），避免"咔"的切断声

    const DEFAULT_SETTINGS = {
        length: 8,
        tempo: 70,
        allowInversion: false,
        // 是否允许出现 6₄（四六和弦 = 三和弦第二转位，五音在低音）
        // 默认 false：所有级数都不出 6₄（传统和声里 6₄ 属装饰性用法，不作为独立和弦频繁出现）
        // 只在「转位」开启时才可能被选到 —— 关着转位本来就全原位，没有 6₄。
        allowSecondInv: false,
        // 配声模式：
        //   'fourpart' = 四部和声（SATB，大谱表，每个和弦 4 个音，按和声学规则重复音）
        //   'triad'    = 原模式（单行高音谱表，三和弦 3 个音 / 七和弦 4 个音）
        voicingMode: 'fourpart',
        // 连续播放（原「自动连播」，界面 2026-10-06 改名）：
        // 一段播完 → 停约 1.5 秒 → 自动换新的一段（调性重新随机）接着播，无限进行。
        // 任何手动操作（停止 / 播放 / 换一段 / 点小节 / 改参数 / 切视图）都会打断接力。
        // ★ localStorage 里的键名仍叫 autoContinue —— 保存键一改，老用户的配置就丢了。
        autoContinue: false,
        // 随身听模式（默认关）：**每小节的最后一拍不再弹柱式和弦，只弹这个和弦的根音**。
        // 用途是"不看屏幕也能对答案"：最后一拍给根音，听出根音是几级 = 这个和弦是几级。
        // 三种播放方式统一生效（柱式/分解/单音的末拍都换成根音单音）。
        portable: false,
        // 参与的级数（Ⅰ 永远参与，端点强制）
        degrees: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
        // 各级出现七和弦的概率（%）
        seventhProb: { 1: 0, 2: 40, 3: 0, 4: 10, 5: 70, 6: 0, 7: 30 },
        // 「使用用户数据优化题库」：按历史错误率给级数加权出题。
        //   默认 false —— 关着的时候出题路径与以前**逐字节一致**（回归脚本靠这条）。
        //   打开后错得多的级数出现概率更高，正确率回升就自动降回基线。见 degreeWeight()。
        adaptiveFromStats: false,
        // 按住卡片时显示什么（用户 2026-10-06 拍板，两档切换）：
        //   'roman' = 现状：罗马数字和弦标记（含转位数字）+ 和弦音名 + 调性底行 + 左上角第几小节
        //   'bass'  = 只给「这个和弦的低音在调内的简谱级数」+ 左上角第几小节，底色换中性灰
        //  ★ 这个开关**只影响页面迷你播放器里那张 canvas**（按住卡片看到的那张）。
        //    锁屏 / 控制中心 / 灵动岛的封面走 coverBlobUrl → drawCover(不带 opts)，
        //    恒为 'roman'，不受这里影响（用户明确要求）。
        revealMode: 'roman',
        // 强调低音（用户 2026-10-07）：把**每小节的最低音**（谱面最下面那个音）单独提亮，
        //   帮听辨时抓住低声部。数值 = 低音增益要提升的百分比：
        //     0   = 完全不强调（**默认**，此时混音路径与改造前逐字节一致）
        //     100 = 低音 ×(1 + BASS_EMPH_MAX)
        //   ★ 只作用于主播放那段离线渲染的音频；听辨辅助窗里试听的和弦保持原样（用户拍板）。
        //   ★ 实现在 renderChordAudio 的混音循环里按"该小节最低音"提增益 ——
        //     刻意不动 buildChordSchedule，和声排程回归基线（triad sha256）才守得住。
        bassEmphasis: 0
    };

    // 强调低音的上限倍数：100% 时低音 = 原增益 ×(1 + 这个数)。
    //   2.0 → 3 倍。再高会明显盖住其它声部（而且峰值归一化会把整体音量压下去）。
    const BASS_EMPH_MAX = 2.0;

    // ------------------------------------------------------------
    // 调式拼写（支持 E# / B# / Cb / Fb —— 现有 noteNameIndex 不支持）
    // ------------------------------------------------------------

    // 'F#' -> { letterIndex: 3, tonicAcc: 1, tonicPc: 6 }
    function parseKey(key) {
        const letter = key[0];
        const rest = key.slice(1);
        const acc = rest === '#' ? 1 : (rest === 'b' ? -1 : 0);
        const pc = ((LETTER_PC[letter] + acc) % 12 + 12) % 12;
        return { letterIndex: LETTERS.indexOf(letter), tonicAcc: acc, tonicPc: pc };
    }

    // 大调音阶：7 个 { letter, acc, pc, degree }
    function buildScale(key) {
        const { letterIndex, tonicAcc, tonicPc } = parseKey(key);
        const scale = [];
        for (let i = 0; i < 7; i++) {
            const letter = LETTERS[(letterIndex + i) % 7];
            const pc = (tonicPc + MAJOR_STEPS[i]) % 12;
            let acc;
            if (i === 0) {
                acc = tonicAcc;                       // 主音升降由调名直接给出（F# -> F#）
            } else {
                acc = pc - LETTER_PC[letter];
                while (acc > 6) acc -= 12;
                while (acc < -6) acc += 12;
            }
            scale.push({ letter, acc, pc, degree: i + 1 });
        }
        return scale;
    }

    // 调号映射：letter -> acc（用于判断是否需要临时记号）
    function keySignatureMap(scale) {
        const m = {};
        for (const d of scale) {
            if (d.acc !== 0) m[d.letter] = d.acc;
        }
        return m;
    }

    function accidentalOf(letter, acc, keySig) {
        const sig = Object.prototype.hasOwnProperty.call(keySig, letter) ? keySig[letter] : 0;
        if (acc === sig) return null;
        if (acc === 0) return 'n';
        return acc > 0 ? '#' : 'b';
    }

    function pitchName(letter, acc) {
        return letter + (acc > 0 ? '#' : (acc < 0 ? 'b' : ''));
    }

    // midi -> { letter, acc, octave }（和弦音一定落在音阶内，故必能命中）
    function midiToSpelled(midi, scale) {
        const pc = ((midi % 12) + 12) % 12;
        const octave = Math.floor(midi / 12) - 1;
        const deg = scale.find((d) => d.pc === pc);
        if (deg) return { letter: deg.letter, acc: deg.acc, octave };
        // 兜底（理论上不会走到）：按升号拼写
        return { letter: LETTERS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc)] || 'C', acc: 0, octave };
    }

    // ------------------------------------------------------------
    // 和弦进行生成
    // ------------------------------------------------------------

    function pickRandomMajorKey() {
        return MAJOR_KEYS[Math.floor(Math.random() * MAJOR_KEYS.length)];
    }

    function chordTonePcs(scale, degree, seventh) {
        const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
        return steps.map((s) => scale[(degree - 1 + s) % 7].pc);
    }

    // 生成候选配声：各（允许的）转位 × 若干八度位置，升序柱式，收敛到 [VOICE_LO, VOICE_HI]
    // 生成某个级数下的所有可用配声候选（各转位 × 八度 4~5）
    //   allowInversion  : 是否允许转位（false 时只有原位）
    //   allowSecondInv  : 是否允许 6₄（三和弦第二转位）。false 时三和弦只保留原位与 6
    //                     注意：只作用于三和弦；七和弦的 4₃ / 4₂ 不是 6₄，不受影响
    function buildCandidates(scale, degree, seventh, allowInversion, allowSecondInv) {
        const pcs = chordTonePcs(scale, degree, seventh);
        const n = pcs.length;
        let invList = allowInversion ? Array.from({ length: n }, (_, i) => i) : [0];
        if (allowSecondInv === false) {
            invList = invList.filter((inv) => !(inv === 2 && !seventh));
        }
        const out = [];
        const seen = new Set();

        for (const inv of invList) {
            for (let oct = 4; oct <= 5; oct++) {
                let arr = [];
                let prev = null;
                for (const pc of pcs) {
                    let m = pc + (oct + 1) * 12;
                    if (prev !== null) {
                        while (m <= prev) m += 12;
                    }
                    arr.push(m);
                    prev = m;
                }
                if (inv > 0) {
                    const moved = arr.slice(inv).concat(arr.slice(0, inv).map((x) => x + 12));
                    moved.sort((a, b) => a - b);
                    arr = moved;
                }
                if (arr[0] < VOICE_LO || arr[arr.length - 1] > VOICE_HI) continue;
                const key = inv + ':' + arr.join(',');
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ midis: arr, inv });
            }
        }
        return out;
    }

    // 声部连接代价（越小越平稳）
    // 规则：声部总位移最小 / 平行五八度惩罚 / 低音大跳惩罚 / 原位轻微加权 / 收尾回原位
    function voicingCost(cand, prevMidis, allowInversion, isLast) {
        let cost = 0;
        const b = cand.midis;

        if (prevMidis && prevMidis.length) {
            const a = prevMidis;
            const m = Math.min(a.length, b.length);
            for (let i = 0; i < m; i++) cost += Math.abs(b[i] - a[i]);
            cost += Math.abs(b.length - a.length) * 4;   // 声部数变化（三和弦↔七和弦）

            // 低音大跳
            const leap = Math.abs(b[0] - a[0]);
            if (leap > 7) cost += (leap - 7) * 1.5;

            // 平行五度 / 平行八度（仅开转位时约束 —— 全原位时无法规避）
            // 权重刻意压低（8）：作为"择优时的倾向"，而不是压倒性禁令。
            // 三声部密集排列下，连续原位和弦的外声部必然构成平行五度（6→D 各声部+2），
            // 若权重过高（试过 25），优化器会几乎总用转位来躲，原位只剩 41%，听感偏怪。
            if (allowInversion) {
                for (let i = 0; i < m; i++) {
                    for (let j = i + 1; j < m; j++) {
                        const ip = (((a[j] - a[i]) % 12) + 12) % 12;
                        const ic = (((b[j] - b[i]) % 12) + 12) % 12;
                        if (ip === ic && (ip === 0 || ip === 7)) {
                            const dp = a[j] - a[i];
                            const dc = b[j] - b[i];
                            if (Math.sign(dp) === Math.sign(dc)) cost += 8;
                        }
                    }
                }
            }
        } else {
            // 首和弦：靠近 C4，避免一上来就很高/很低
            cost += Math.abs(b[0] - 60) * 0.4;
        }

        // 原位轻微加权：让原位出现得更频繁，但平稳的转位仍会被选中
        if (cand.inv === 0) cost -= 7;
        // 收尾必须回原位
        if (isLast && cand.inv !== 0) cost += 100;

        return cost;
    }

    // 为一个和弦挑最佳配声（在最优附近随机，保留变化）
    function chooseVoicing(scale, degree, seventh, prevMidis, allowInversion, isLast, allowSecondInv) {
        const cands = buildCandidates(scale, degree, seventh, allowInversion, allowSecondInv);
        if (cands.length === 0) {
            // 兜底：取根三五原位
            const pcs = chordTonePcs(scale, degree, seventh);
            let arr = [];
            let prev = null;
            for (const pc of pcs) {
                let m = pc + 60;
                if (prev !== null) {
                    while (m <= prev) m += 12;
                }
                arr.push(m);
                prev = m;
            }
            return { midis: arr, inv: 0 };
        }
        const scored = cands.map((c) => ({
            c,
            cost: voicingCost(c, prevMidis, allowInversion, isLast)
        }));
        scored.sort((x, y) => x.cost - y.cost);
        const best = scored[0].cost;
        const pool = scored.filter((s) => s.cost <= best + 2.5).map((s) => s.c);
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // ============================================================
    // 四部和声模式（SATB）—— 与原模式完全独立的一套配声
    //   1. 每个和弦恒为 4 个音（三和弦按和声学规则重复一个音，七和弦 4 音不重复）
    //   2. midis 保持升序，索引固定：[0]=B 低音 [1]=T 次中音 [2]=A 中音 [3]=S 高音
    //      （与「midis[0] 是最低音」一致 → 单音播放直接取 midis[0]，两种模式通用）
    //   3. 重复音、排列法、声部进行都遵循四部和声规则
    // ============================================================

    // 参考音域（MIDI），索引 0..3 = B / T / A / S
    const FOUR_RANGES = [
        [41, 60],   // B 低音   ：F2 ~ C4
        [48, 65],   // T 次中音 ：C3 ~ F4（上限收在 F4，少几条加线）
        [55, 72],   // A 中音   ：G3 ~ C5
        [60, 81],   // S 高音   ：C4 ~ A5
    ];
    const FOUR_CENTERS = [50, 57, 64, 71];   // 各声部音域中心，用于"向中心靠拢"

    // 相邻声部间距上限（半音）：S-A、A-T、T-B
    const FOUR_GAP = { sa: 12, at: 12, tb: 19 };

    // 上方三声部（T/A/S）的音位全排列：perm[k] = 放在第 k 个上方声部的音位索引
    const PERM3 = [
        [0, 1, 2], [0, 2, 1], [1, 0, 2],
        [1, 2, 0], [2, 0, 1], [2, 1, 0]
    ];

    // 四部软代价值的权重
    // ---- 设计依据（教材口径见下）----
    //  1) 池宽 poolWidth=2.5 < 内声部每半音 innerMove=3.0：
    //     内声部只要比"最优解"多动 1 个半音就被挤出随机池。
    //     旧版池宽是硬编码 3.0，**恰好等于内声部走小三度的代价** —— 于是
    //     "内声部保持" 与 "内声部跳小三度" 被判等价、等概率随机抽中，
    //     这就是内声部不平稳的直接来源。
    //  2) 代价顺序：保持(-3) < 级进1(1.5) < 级进2(4.5) < 三度(9) < 四度以上(≥21)，
    //     与教材"三度及三度以内 = 平稳进行，四度及以上 = 跳进"对齐。
    //  3) 级进奖励只给上方三声部；低音保留 4/5/8 度跳进的自由（低音常作四五度跳进）。
    const P4 = {
        bassMove: 0.5,       // 低音：最自由
        outerMove: 1.0,      // 高音 S（外声部）
        innerMove: 3.0,      // 内声部 T/A：每半音（=池宽量级，显著重于外声部）
        outerLeap: 2.0,      // S 跳进（d>4）每半音追加
        innerLeap: 6.0,      // T/A 跳进（d>4）每半音追加 —— 内声部跳进代价极高
        bassLeap: 1.0,       // 低音 d>7 后每半音追加
        stepReward: -1.5,    // 级进（1~2 半音）奖励，只给上方三声部
        parallel: 60,        // 平行五/八度（主要由过滤器硬拦，这里兜底）
        hidden: 40,          // 隐伏五/八度（外声部同向且高声部跳进）
        overlap: 200,        // 声部超越（硬错误 → 大权重兜底）
        crossing: 200,       // 同和弦内交叉（结构上恒为 0，保留键名）
        commonTone: -3,      // 共同音保持在同一声部 → 加分
        resolveOk: -4,
        resolveBad: 15,
        similarAll: 1.5,     // 四部同向轻度惩罚（1.5 << 内声部一步 3.0，不会把内声部逼成大跳）
        rangeCenter: 0.25,
        outOfRange: 4,       // 越出声部标准音域的每半音惩罚
        rootBonus: -4,
        endNonRoot: 100,
        poolWidth: 2.5       // 随机池宽（旧版硬编码 3.0 = 一个内声部小三度的代价，必须收窄）
    };

    // 和弦音（带角色与原音级），供重复音判定使用
    // 返回 [{letter, acc, pc, role, scaleDegree}]，role ∈ root/third/fifth[/seventh]
    function chordToneSpelled(scale, degree, seventh) {
        const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
        const roles = seventh
            ? ['root', 'third', 'fifth', 'seventh']
            : ['root', 'third', 'fifth'];
        return steps.map((s, i) => {
            const d = scale[(degree - 1 + s) % 7];
            return { letter: d.letter, acc: d.acc, pc: d.pc, role: roles[i], scaleDegree: d.degree };
        });
    }

    // 三和弦该重复哪个音 → 返回 0=根音 / 1=三音 / 2=五音；-1 = 无合法重复音
    //   原位正三和弦（Ⅰ Ⅳ Ⅴ）  → 根音
    //   原位副三和弦（Ⅱ Ⅲ Ⅵ Ⅶ）→ 三音（其三是调性正音级）
    //   减三和弦 ⅶ°            → 三音（根音是导音、五音与根音成三全音，都不可重复）
    //   第一转位（6）           → 根音；根音是导音时改重复五音
    //   第二转位（6₄）          → 五音（=低音）
    //   七和弦（4 个音）        → 不重复
    function doubledToneIndex(tones, degree, inversion) {
        if (tones.length === 4) return -1;              // 七和弦 4 音全保留
        const deg = (i) => tones[i].scaleDegree;
        if (inversion === 2) return deg(2) === 7 ? -1 : 2;          // 6₄：重复五音
        if (inversion === 1) {                                       // 6：优先根音
            if (deg(0) !== 7) return 0;
            return deg(2) === 7 ? -1 : 2;
        }
        const isPrimary = (degree === 1 || degree === 4 || degree === 5);
        const idx = isPrimary ? 0 : 1;                               // 原位
        return deg(idx) === 7 ? -1 : idx;                            // 绝不重复导音
    }

    // 生成四部候选：枚举「转位 × 低音八度 × 上方三声部八度」，逐条硬过滤
    //   relax 0=严格 1=放宽间距 2=音域±2 3=音域±4
    function buildFourPartCandidates(scale, degree, seventh, allowInversion, allowSecondInv, relax) {
        relax = relax || 0;
        const tones = chordToneSpelled(scale, degree, seventh);
        const n = tones.length;

        let invList = allowInversion ? Array.from({ length: n }, (_, i) => i) : [0];
        if (allowSecondInv === false) invList = invList.filter((inv) => !(inv === 2 && !seventh));

        // relax：0 严格 / 1 放宽间距 / 2 音域±2 / 3 音域±4 / 4 间距±4 / 5 间距±8
        //        6 = 深度枚举（仅供"回溯修补"在极罕见死锁时兜底，音源有 ±24 半音移调兜底）
        const pad = relax >= 6 ? 6 : (relax >= 3 ? 4 : (relax === 2 ? 2 : 0));
        const gapUp = relax === 0 ? 0
            : (relax >= 6 ? 12 : (relax >= 5 ? 8 : (relax >= 4 ? 4 : 2)));
        const rangeOf = (i) => [FOUR_RANGES[i][0] - pad, FOUR_RANGES[i][1] + pad];

        const out = [];
        const seen = new Set();

        for (const inv of invList) {
            const dbl = doubledToneIndex(tones, degree, inv);
            if (!seventh && dbl < 0) continue;

            const bassTone = tones[inv % n];
            let upperTones;
            if (seventh) {
                upperTones = tones.filter((_, i) => i !== inv);
            } else {
                const content = tones.concat([tones[dbl]]);          // 4 个音位（含重复音）
                const rest = content.slice();
                rest.splice(rest.findIndex((t) => t.pc === bassTone.pc), 1);
                upperTones = rest;                                    // 剩 3 个给 T/A/S
            }

            for (let bo = 0; bo < 9; bo++) {
                const bassMidi = bassTone.pc + 12 * (bo + 1);
                const [bLo, bHi] = rangeOf(0);
                if (bassMidi < bLo || bassMidi > bHi) continue;

                // opts[ti][vk] = 第 ti 个上方音放在第 vk 个上方声部（0=T, 1=A, 2=S）
                //                且高于低音、落在该声部音域内时，可用的 midi 列表
                const opts = upperTones.map((t) =>
                    [1, 2, 3].map((vk) => {
                        const arr = [];
                        const [lo, hi] = rangeOf(vk);
                        for (let o = 0; o < 9; o++) {
                            const m = t.pc + 12 * (o + 1);
                            if (m <= bassMidi || m < lo || m > hi) continue;
                            arr.push(m);
                        }
                        return arr;
                    })
                );

                // ★ 关键：枚举"哪个和弦音去哪个上方声部"的 3! 种排列。
                //   旧版把 upperTones[0] 固定给 T、[1] 给 A、[2] 给 S，只枚举八度，
                //   于是每个和弦往往只剩 2~6 个候选（例如 B 大调的 V7 全音域只有 2 个），
                //   连"避开声部超越/平行"的余地都没有 —— 这才是四部配声不平稳的根因。
                //   排列音位正是四部和声写作的核心动作（就近解决、共同音保持）。
                for (const perm of PERM3) {
                    const o0 = opts[perm[0]][0];
                    const o1 = opts[perm[1]][1];
                    const o2 = opts[perm[2]][2];
                    if (!o0.length || !o1.length || !o2.length) continue;

                    for (const t0 of o0) {
                        if (t0 - bassMidi > FOUR_GAP.tb + gapUp) continue;
                        for (const t1 of o1) {
                            if (t1 <= t0) continue;
                            if (t1 - t0 > FOUR_GAP.at + gapUp) continue;
                            for (const t2 of o2) {
                                if (t2 <= t1) continue;
                                if (t2 - t1 > FOUR_GAP.sa + gapUp) continue;
                                const arr = [bassMidi, t0, t1, t2];
                                const key = inv + ':' + arr.join(',');
                                if (seen.has(key)) continue;
                                seen.add(key);
                                out.push({
                                    midis: arr,
                                    inv,
                                    doubledRole: seventh ? null : tones[dbl].role,
                                    doubledPc: seventh ? null : tones[dbl].pc
                                });
                            }
                        }
                    }
                }
            }
        }
        return out;
    }

    // 单声部运动代价：i = 0 B / 1 T / 2 A / 3 S，d = 半音位移
    //   教材口径：三度及以内 = 平稳进行（一度/二度级进/三度小跳）；四度及以上 = 跳进。
    //   内声部（T/A）应"能保持就保持、否则走最小距离，通常不需要大于四度"。
    function voiceMotionCost(i, d) {
        let c;
        if (i === 0) {                                   // B 低音：最自由，允许 4/5/8 度跳进
            c = d * P4.bassMove;
            if (d > 7) c += (d - 7) * P4.bassLeap;
        } else if (i === 3) {                            // S 高音：外声部，可适度跳进
            c = d * P4.outerMove;
            if (d > 4) c += (d - 4) * P4.outerLeap;
            if (d >= 1 && d <= 2) c += P4.stepReward;    // 级进奖励
        } else {                                         // T(1) / A(2)：内声部，最贵
            c = d * P4.innerMove;
            if (d > 4) c += (d - 4) * P4.innerLeap;
            if (d >= 1 && d <= 2) c += P4.stepReward;    // 级进奖励
        }
        return c;
    }

    // 四部专用软代价（与原 voicingCost 完全独立，互不影响）
    function fourPartCost(cand, prevMidis, isLast, ctx) {
        let cost = 0;
        const b = cand.midis;

        if (prevMidis && prevMidis.length === 4) {
            const a = prevMidis;

            // 1) 声部运动：内声部（T/A）显著重于外声部（S），低音最自由
            //    旧版对 i=1,2,3 一视同仁（同用 upperMove=1.0），内声部没有额外约束，
            //    是"内声部不平稳"的根因之一。
            for (let i = 0; i < 4; i++) {
                cost += voiceMotionCost(i, Math.abs(b[i] - a[i]));
            }

            // 平行五/八度（判定口径见 hasParallel 的注释：只查相邻声部+外声部、
            //   音程按实际半音数只认 5度/同度/八度）。
            for (const [i, j] of PARALLEL_PAIRS) {
                const dp = a[j] - a[i];
                const dc = b[j] - b[i];
                if (Math.sign(dp) !== Math.sign(dc)) continue;
                const ap = Math.abs(dp);
                if (ap !== Math.abs(dc)) continue;
                if (ap === 7 || ap === 0 || ap === 12) cost += P4.parallel;
            }

            // 隐伏五/八度：两外声部 S、B 同向进行到纯五/纯八
            //   教材口径：只在【高声部为跳进】时才算错误；高声部级进 **不构成** 隐伏五八度。
            //   旧版写成 (|dS|>2 || |dB|>2)，只要任一声部跳进就算 → 过严，会误伤正常连接。
            {
                const dS = b[3] - a[3];
                const dB = b[0] - a[0];
                const dci = b[3] - b[0];
                const dpi = a[3] - a[0];
                const ci = Math.abs(dci);
                if (dS !== 0 && dB !== 0 && Math.sign(dS) === Math.sign(dB)
                    && (ci === 7 || ci === 0 || ci === 12) && ci !== Math.abs(dpi)
                    && Math.abs(dS) > 2) {
                    cost += P4.hidden;
                }
            }

            // 声部超越（跨和弦）：后一和弦的低声部高于前一和弦相邻高声部，
            //   或后一和弦的高声部低于前一和弦相邻低声部。
            //   注意：这两支**实际都是"超越"判定**（真正的"和弦内交叉"由
            //   buildFourPartCandidates 的严格升序硬过滤结构性保证，恒为 0）。
            //   现在主要由 hasOverlap 做硬过滤，这里只是大权重兜底。
            for (let i = 0; i < 3; i++) {
                if (b[i] > a[i + 1]) cost += P4.crossing;
                if (b[i + 1] < a[i]) cost += P4.overlap;
            }

            // 共同音保持在同一部 → 加分
            for (let i = 0; i < 4; i++) {
                if (b[i] === a[i]) cost += P4.commonTone;
            }

            // 四部同向（四个声部全部同向上行或下行）轻度惩罚。
            //   权重远小于"内声部走一步"(3.0)与"内声部跳进"(≥21)，
            //   所以优化器不会为了省这 1.5 分而把内声部逼成大跳。
            {
                let up = 0, down = 0;
                for (let i = 0; i < 4; i++) {
                    const dd = b[i] - a[i];
                    if (dd > 0) up++; else if (dd < 0) down++;
                }
                if (up === 4 || down === 4) cost += P4.similarAll;
            }

            // 导音解决：外声部（S/B）必须上行级进到主音；
            //   内声部（A/T）允许上行到主音 或 **下行三度** 到属音（教材口径）。
            if (ctx) {
                for (let i = 0; i < 4; i++) {
                    const pc = (((a[i] % 12) + 12) % 12);
                    if (pc !== ctx.leadingPc) continue;
                    const npc = (((b[i] % 12) + 12) % 12);
                    const mv = b[i] - a[i];
                    const isInner = (i === 1 || i === 2);
                    const upToTonic = (npc === ctx.tonicPc && mv > 0 && mv <= 2);
                    const innerDownThird = isInner && (mv === -3 || mv === -4);
                    if (upToTonic || innerDownThird) cost += P4.resolveOk;
                    else cost += P4.resolveBad;
                }
                // 前和弦七音应下行解决
                if (ctx.prevSeventhPc != null) {
                    for (let i = 0; i < 4; i++) {
                        const pc = (((a[i] % 12) + 12) % 12);
                        if (pc !== ctx.prevSeventhPc) continue;
                        const mv = b[i] - a[i];
                        if (mv === -1 || mv === -2) cost += P4.resolveOk;
                        else cost += P4.resolveBad;
                    }
                }
            }
        } else {
            // 首和弦：低音靠近 C3、高音靠近 C5，别一上来就极端
            cost += Math.abs(b[0] - 48) * 0.3 + Math.abs(b[3] - 72) * 0.3;
        }

        // 向各声部音域中心靠拢（压掉加线过多的极端摆位）
        for (let i = 0; i < 4; i++) cost += Math.abs(b[i] - FOUR_CENTERS[i]) * P4.rangeCenter;

        // 排列"上密下疏中不空"：只在放宽阶梯真的放开了间距上限时才生效，
        //   标准音域下恒为 0 → 不影响原有行为；一旦靠"放宽间距"才找到候选，
        //   仍优先挑更紧凑的那个，避免选出中间空散的排列。
        //   权重刻意给得不低：一旦某小节摆成"空散"排列（例如 A-T 拉开 16 个半音），
        //   下一小节就极可能凑不出"无超越"的候选（级联失败），所以要从源头堵住。
        cost += Math.max(0, (b[2] - b[1]) - 12) * 3.0;   // A-T 超过八度
        cost += Math.max(0, (b[3] - b[2]) - 12) * 3.0;   // S-A 超过八度
        cost += Math.max(0, (b[1] - b[0]) - 19) * 2.0;   // T-B 超过十二度

        // 越界惩罚：为躲开平行五八度偶尔要用到放宽音域的候选，
        // 这里让"越界越少"的候选在同池中胜出，尽量贴回标准音域。
        for (let i = 0; i < 4; i++) {
            if (b[i] < FOUR_RANGES[i][0]) cost += (FOUR_RANGES[i][0] - b[i]) * P4.outOfRange;
            else if (b[i] > FOUR_RANGES[i][1]) cost += (b[i] - FOUR_RANGES[i][1]) * P4.outOfRange;
        }

        if (cand.inv === 0) cost += P4.rootBonus;
        if (isLast && cand.inv !== 0) cost += P4.endNonRoot;

        return cost;
    }

    // 平行五/八度检测（与 fourPartCost 同口径）
    //   只查相邻声部 T-B / A-T / S-A 与外声部 S-B；只认 5度(7)、同度(0)、八度(12)
    const PARALLEL_PAIRS = [[0, 1], [1, 2], [2, 3], [0, 3]];
    function hasParallel(a, b) {
        for (const [i, j] of PARALLEL_PAIRS) {
            const dp = a[j] - a[i];
            const dc = b[j] - b[i];
            if (Math.sign(dp) !== Math.sign(dc)) continue;
            const ap = Math.abs(dp);
            if (ap !== Math.abs(dc)) continue;
            if (ap === 7 || ap === 0 || ap === 12) return true;
        }
        return false;
    }

    // 声部超越（overlapping）检测 —— 教材口径：
    //   两个和弦连接中，某一声部跳进过大而"超过了相邻声部的音"：
    //     ① 后一和弦的低声部高于【前一和弦相邻高声部】的原位
    //     ② 后一和弦的高声部低于【前一和弦相邻低声部】的原位
    //   注意与"声部交叉（crossing）"的区别：交叉指**同一个和弦内部**排列倒错，
    //   那已被 buildFourPartCandidates 的严格升序硬过滤结构性杜绝。
    //   相邻声部对：(B,T) (T,A) (A,S)。教材：两种情况"一般是不允许出现的"。
    function hasOverlap(a, b) {
        for (let i = 0; i < 3; i++) {
            if (b[i] > a[i + 1]) return true;
            if (b[i + 1] < a[i]) return true;
        }
        return false;
    }

    // 内声部（T/A）单次移动的上限：cap 为半音数，Infinity = 不限
    function innerLeapOk(a, b, cap) {
        if (!isFinite(cap)) return true;
        return Math.abs(b[1] - a[1]) <= cap && Math.abs(b[2] - a[2]) <= cap;
    }

    // 四个声部是否都落在标准音域内（教材硬规则："各声部不要超越音域"）
    function inStandardRange(m) {
        for (let i = 0; i < 4; i++) {
            if (m[i] < FOUR_RANGES[i][0] || m[i] > FOUR_RANGES[i][1]) return false;
        }
        return true;
    }

    // 兜底：极端情况（4 级放宽后仍无候选）也要产出 4 个音，绝不返回空
    function fallbackFourPart(scale, degree, seventh) {
        const tones = chordToneSpelled(scale, degree, seventh);
        const dbl = doubledToneIndex(tones, degree, 0);
        const idx = dbl < 0 ? 0 : dbl;
        const content = seventh ? tones.slice() : tones.concat([tones[idx]]);

        let bass = tones[0].pc + 12 * 4;                       // 约 C3
        while (bass < FOUR_RANGES[0][0]) bass += 12;
        while (bass > FOUR_RANGES[0][1]) bass -= 12;

        const rest = content.slice();
        rest.splice(rest.findIndex((t) => t.pc === tones[0].pc), 1);
        const arr = [bass];
        let prev = bass;
        for (const t of rest) {
            let m = t.pc + 12 * Math.floor(bass / 12);
            while (m <= prev) m += 12;
            arr.push(m);
            prev = m;
        }
        arr.sort((x, y) => x - y);
        return {
            midis: arr,
            inv: 0,
            doubledRole: seventh ? null : tones[idx].role,
            doubledPc: seventh ? null : tones[idx].pc
        };
    }

    // 放宽阶梯：[枚举放宽级别 relax, 内声部跳进上限 cap(半音), 是否要求落在标准音域]
    //   ★ 优先级（从严到宽）：
    //      ① 无平行五八度 ② 无超越 ③ 各声部不越出音域 ④ 内声部平稳 ⑤ 排列紧凑
    //      这四条里 ①②③ 在教材里都是"硬错误"，所以 ③ 也放到最后才让。
    //   ⚠️ 为什么"越界"必须最后才让：越界会产生**级联失败** —— 例如前一小节
    //      把次中音摆到 A2（比常规音域低 3 个半音），下一小节就再没有"不超越"的
    //      低音可用了（低音必须 ≤ 前一小节的次中音），于是被迫让出超越。
    //      所以宁可让内声部偶尔走四度（教材明确允许"三音跳进"），也不要越界。
    //   relax 语义（见 buildFourPartCandidates）：0 严格 / 1 放宽间距 / 2 音域±2 / 3 音域±4 / 4 间距±4 / 5 间距±8
    const FOUR_LADDER = [
        [0, 4, true],            // 最严：严格音域 + 内声部 ≤ 大三度（= "三度及以内"= 平稳进行）
        [1, 4, true],
        [4, 4, true],            // 间距上限 +4（音域仍不越界）
        [5, 4, true],            // 间距上限 +8
        [5, 5, true],            // 内声部放宽到纯四度
        [5, 7, true],            // 再到纯五度（教材的"三音跳进"上限）
        [5, Infinity, true],     // 内声部不再限制
        [5, 4, false],           // ← 到这里才允许越出音域（±4，间距上限 +8）
        [5, 5, false],
        [5, 7, false],
        [5, Infinity, false]
    ];

    // 决策路径计数（只用于自测统计触发率，不影响配声结果）
    const FOURPART_STATS = {
        cleanStep: new Array(FOUR_LADDER.length).fill(0),  // 在第几号阶梯上命中"最严规则集"
        fbNoCap: 0,                 // 退到「无平行 + 无超越」（舍掉内声部跳进上限）
        fbNoOverlap: 0,             // 再退到「只保证无平行」
        fbAny: 0,                   // 再退到任意候选
        fallback: 0,                // 最后兜底 fallbackFourPart
        firstChord: 0
    };

    // 挑四部配声：relax（音域放宽）是外层、规则集（从严到宽）是内层。
    //   即"放宽音域"永远优先于"放宽声部规则" —— 音域越界比声部超越轻得多。
    //   规则集：① 无平行五八度 + 无超越 + 内声部跳进 ≤ cap
    //          ② 无平行 + 无超越   ③ 只保证无平行   ④ 任意
    function chooseFourPartVoicing(scale, degree, seventh, prevMidis, allowInversion, isLast, allowSecondInv, ctx) {
        const pick = (cands) => {
            const scored = cands.map((c) => ({ c, cost: fourPartCost(c, prevMidis, isLast, ctx) }));
            scored.sort((x, y) => x.cost - y.cost);
            const best = scored[0].cost;
            const pool = scored.filter((s) => s.cost <= best + P4.poolWidth).map((s) => s.c);
            return pool[Math.floor(Math.random() * pool.length)];
        };
        const build = (relax) => buildFourPartCandidates(
            scale, degree, seventh, allowInversion, allowSecondInv, relax
        );

        const needClean = !!(prevMidis && prevMidis.length === 4);

        // 首和弦（无前和弦）：取最严 relax 里能找到的候选即可
        if (!needClean) {
            FOURPART_STATS.firstChord++;
            for (let relax = 0; relax <= 3; relax++) {
                const cands = build(relax);
                if (cands.length) return pick(cands);
            }
            FOURPART_STATS.fallback++;
            return fallbackFourPart(scale, degree, seventh);
        }

        const a = prevMidis;
        let fbNoCap = null;         // 无平行 + 无超越
        let fbNoOverlap = null;     // 只保证无平行
        let fbAny = null;           // 任何候选

        for (let step = 0; step < FOUR_LADDER.length; step++) {
            const relax = FOUR_LADDER[step][0];
            const cap = FOUR_LADDER[step][1];
            const needInRange = FOUR_LADDER[step][2];
            const cands = build(relax);
            if (!cands.length) continue;

            // 【最严规则集】无平行 + 无超越 (+ 不越界) + 内声部跳进 ≤ cap
            const clean = cands.filter((c) =>
                !hasParallel(a, c.midis)
                && !hasOverlap(a, c.midis)
                && (!needInRange || inStandardRange(c.midis))
                && innerLeapOk(a, c.midis, cap)
            );
            if (clean.length) {
                FOURPART_STATS.cleanStep[step]++;
                return pick(clean);
            }

            // 记录兜底池（取最先命中、即音域最窄的那一级）
            if (!fbNoCap) {
                const t = cands.filter((c) => !hasParallel(a, c.midis) && !hasOverlap(a, c.midis));
                if (t.length) fbNoCap = t;
            }
            if (!fbNoOverlap) {
                const t = cands.filter((c) => !hasParallel(a, c.midis));
                if (t.length) fbNoOverlap = t;
            }
            if (!fbAny) fbAny = cands;
        }

        // 兜底顺序：先舍"跳进上限" → 再舍"无超越" → 最后舍"无平行"
        if (fbNoCap) { FOURPART_STATS.fbNoCap++; return pick(fbNoCap); }
        if (fbNoOverlap) { FOURPART_STATS.fbNoOverlap++; return pick(fbNoOverlap); }
        if (fbAny) { FOURPART_STATS.fbAny++; return pick(fbAny); }
        FOURPART_STATS.fallback++;
        return fallbackFourPart(scale, degree, seventh);
    }

    // 把一个候选写回 chord 对象（midis / notes / doubledRole 同步）
    function applyFourPartCandidate(chord, cand, scale) {
        chord.midis = cand.midis;
        chord.notes = cand.midis.map((m) => midiToSpelled(m, scale));
        chord.doubledRole = cand.doubledRole || null;
    }

    // 局部回溯修补「声部超越」
    //   为什么需要它：配声是"逐和弦贪心"的，而"声部超越"是**跨和弦**约束。
    //   偶尔会死锁：上一小节把某声部摆到极端位置（甚至越出音域）→ 下一小节在可用
    //   音域里根本找不到不超越的候选。这时与其让出超越，不如回头把**上一小节换一个
    //   摆位**（转位、重复音都不变，只是排列不同），使两个小节同时干净。
    //   只做两遍前向扫描；改动 (m-1, m) 若影响到 (m, m+1)，下一遍会再处理。
    function repairFourPartOverlaps(scale, chords, allowSecondInv) {
        let fixed = 0;
        for (let pass = 0; pass < 2; pass++) {
            let changedThisPass = 0;
            for (let m = 1; m < chords.length; m++) {
                const prev = chords[m - 1];
                const cur = chords[m];
                if (!hasOverlap(prev.midis, cur.midis)) continue;

                // 候选池：保持各自的转位与重复音不变，只换排列
                const buildFor = (chord, relax) => buildFourPartCandidates(
                    scale, chord.degree, !!chord.seventh, true, allowSecondInv, relax
                ).filter((c) => c.inv === chord.inversion);

                const before = (m >= 2) ? chords[m - 2].midis : null;
                const after = (m + 1 < chords.length) ? chords[m + 1].midis : null;

                const search = (candsPrev, candsCur, strict) => {
                    let best = null;
                    for (const x of candsPrev) {
                        if (before && (hasOverlap(before, x.midis) || hasParallel(before, x.midis))) continue;
                        for (const y of candsCur) {
                            if (hasOverlap(x.midis, y.midis) || hasParallel(x.midis, y.midis)) continue;
                            // 改了第 m 小节就可能和第 m+1 小节形成新的平行/超越，必须一并校验
                            if (strict && after
                                && (hasOverlap(y.midis, after) || hasParallel(y.midis, after))) continue;
                            const cost = fourPartCost(x, before, false, null)
                                + fourPartCost(y, x.midis, false, null);
                            if (!best || cost < best.cost) best = { cost: cost, x: x, y: y };
                        }
                    }
                    return best;
                };

                // 先用常规枚举找"与前后两小节都干净"的解；找不到再退：① 只保证本处干净
                //   ② 换用深度枚举（音域再放宽，音源会自动移调发声）
                let hit = null;
                for (const relax of [5, 6]) {
                    const candsPrev = buildFor(prev, relax);
                    const candsCur = buildFor(cur, relax);
                    if (!candsPrev.length || !candsCur.length) continue;
                    hit = search(candsPrev, candsCur, true) || search(candsPrev, candsCur, false);
                    if (hit) break;
                }
                if (!hit) continue;
                applyFourPartCandidate(prev, hit.x, scale);
                applyFourPartCandidate(cur, hit.y, scale);
                fixed++;
                changedThisPass++;
            }
            if (!changedThisPass) break;
        }
        return fixed;
    }

    function romanOf(degree, seventh, inversion) {
        const base = ROMAN_MAJOR[degree - 1] || '';
        if (!seventh) {
            if (inversion === 1) return base + SUP[6];
            if (inversion === 2) return base + SUP[6] + SUB[4];
            return base;
        }
        if (inversion === 1) return base + SUP[6] + SUB[5];
        if (inversion === 2) return base + SUB[4] + SUB[3];
        if (inversion === 3) return base + SUB[4] + SUB[2];
        return base + SUP[7];
    }

    // 生成一段和弦连接：Ⅰ 开头、Ⅰ 结尾；中间从勾选的级数里随机
    function generateChordProgression(settings) {
        const key = pickRandomMajorKey();
        const scale = buildScale(key);
        const keySig = keySignatureMap(scale);
        const N = settings.length;

        const picked = [];
        for (let d = 1; d <= 7; d++) {
            if (settings.degrees[d]) picked.push(d);
        }
        if (picked.indexOf(1) === -1) picked.push(1);   // 端点必须有 Ⅰ

        // 级数序列
        const seq = new Array(N).fill(1);
        seq[0] = 1;
        seq[N - 1] = 1;
        // 「使用用户数据优化题库」（设置里那个开关）：
        //   开了 → 按历史错误率给级数加权（错得多的多出一点）；
        //   关着 → 原样均匀随机。★ 关着的时候连 Math.random() 的消耗次数都不能变，
        //   否则和声回归快照（sha256）会漂。
        const useAdaptive = !!settings.adaptiveFromStats;
        let prevDegree = 1;
        for (let i = 1; i <= N - 2; i++) {
            const pool = picked.filter((d) => d !== prevDegree);
            const list = pool.length ? pool : picked;
            const d = useAdaptive
                ? weightedPick(list)
                : list[Math.floor(Math.random() * list.length)];
            seq[i] = d;
            prevDegree = d;
        }
        // 终止感：倒数第二小节用 Ⅴ（若 Ⅴ 参与且长度够）
        if (N >= 4 && picked.indexOf(5) !== -1) {
            seq[N - 2] = 5;
        }

        // 逐和弦配声
        const chords = [];
        let prevMidis = null;
        const fourPart = (settings.voicingMode === 'fourpart');
        // 四部专用上下文：导音 pc 用于"必须上行解决"的判定
        const ctx = {
            scale,
            leadingPc: scale[6].pc,
            tonicPc: scale[0].pc,
            prevSeventhPc: null
        };

        for (let i = 0; i < N; i++) {
            const degree = seq[i];
            const isFirst = (i === 0);
            const isLast = (i === N - 1);
            // 首尾强制三和弦原位（调性明确、收束干净）
            const seventh = (isFirst || isLast)
                ? false
                : (Math.random() * 100 < (settings.seventhProb[degree] || 0));
            const allowInv = settings.allowInversion && !isFirst && !isLast;

            const v = fourPart
                ? chooseFourPartVoicing(
                    scale, degree, seventh, prevMidis, allowInv, isLast, settings.allowSecondInv, ctx
                )
                : chooseVoicing(
                    scale, degree, seventh, prevMidis, allowInv, isLast, settings.allowSecondInv
                );
            prevMidis = v.midis;
            // 记录本和弦七音 pc，供下一和弦判断"七音是否下行解决"
            ctx.prevSeventhPc = seventh ? chordToneSpelled(scale, degree, true)[3].pc : null;

            const notes = v.midis.map((m) => midiToSpelled(m, scale));
            chords.push({
                degree,
                seventh,
                inversion: v.inv,
                midis: v.midis,
                notes,
                roman: romanOf(degree, seventh, v.inv),
                doubledRole: v.doubledRole || null,
                voices4: fourPart
            });
        }

        // 四部模式：贪心配声偶尔会因上一小节的极端摆位而"死锁"出超越 →
        // 做一次局部回溯修补（只换排列，不动转位与重复音）
        if (fourPart) repairFourPartOverlaps(scale, chords, settings.allowSecondInv);

        return { key, scale, keySig, chords, voicingMode: fourPart ? 'fourpart' : 'triad' };
    }

    // 按给定级数序列配声（错题练习专用：错误组合 + Ⅰ 胶水）。
    //   配声循环与 generateChordProgression 的 916-964 行同构 —— 但**绝对不动本体**，
    //   否则和声回归基线（triad 快照 sha256）会漂。
    //   返回结构与 generateChordProgression 完全一致，
    //   所以谱面 / 封面 / 播放 / 长按 / 左滑 / 报错定位全部零改动复用。
    //   配声函数对相邻重复级数无感（"不与上一个相同"只在本体的级数挑选循环里），
    //   胶水构造也保证了不会出现相邻同度（见 buildPracticeSequence）。
    function generateProgressionFromSequence(key, seq, settings) {
        const scale = buildScale(key);
        const keySig = keySignatureMap(scale);
        const N = seq.length;
        const chords = [];
        let prevMidis = null;
        const fourPart = (settings.voicingMode === 'fourpart');
        // 四部专用上下文：导音 pc 用于"必须上行解决"的判定
        const ctx = {
            scale,
            leadingPc: scale[6].pc,
            tonicPc: scale[0].pc,
            prevSeventhPc: null
        };
        for (let i = 0; i < N; i++) {
            const degree = seq[i];
            const isFirst = (i === 0);
            const isLast = (i === N - 1);
            // 首尾强制三和弦原位（错题段两端都是 Ⅰ 胶水 —— 正好当调性锚点）
            const seventh = (isFirst || isLast)
                ? false
                : (Math.random() * 100 < (settings.seventhProb[degree] || 0));
            const allowInv = settings.allowInversion && !isFirst && !isLast;
            const v = fourPart
                ? chooseFourPartVoicing(
                    scale, degree, seventh, prevMidis, allowInv, isLast, settings.allowSecondInv, ctx
                )
                : chooseVoicing(
                    scale, degree, seventh, prevMidis, allowInv, isLast, settings.allowSecondInv
                );
            prevMidis = v.midis;
            ctx.prevSeventhPc = seventh ? chordToneSpelled(scale, degree, true)[3].pc : null;
            chords.push({
                degree,
                seventh,
                inversion: v.inv,
                midis: v.midis,
                notes: v.midis.map((m) => midiToSpelled(m, scale)),
                roman: romanOf(degree, seventh, v.inv),
                doubledRole: v.doubledRole || null,
                voices4: fourPart
            });
        }
        if (fourPart) repairFourPartOverlaps(scale, chords, settings.allowSecondInv);
        return { key, scale, keySig, chords, voicingMode: fourPart ? 'fourpart' : 'triad' };
    }

    // ------------------------------------------------------------
    // 谱面渲染
    //   两种配声模式共用一套几何与两遍绘制框架，按 data.voicingMode 分支：
    //     'triad'    → 单行高音谱表（每小节 1 个全音符柱式和弦）—— 原行为，逐字保留
    //     'fourpart' → 大谱表（高音+低音两行，SATB 写法），上谱表 = A+S，下谱表 = B+T
    //   记谱始终是「每小节 1 个全音符柱式和弦」；实际弹奏方式见 buildChordSchedule
    // ------------------------------------------------------------

    function renderChordSheet(data) {
        const container = document.getElementById('chord-sheet-music');
        if (!container) return;
        container.innerHTML = '';

        const Vex = global.VexFlow;
        if (!Vex) {
            container.innerHTML = '<div style="color:#c00;padding:20px">VexFlow 未加载</div>';
            return;
        }

        const { key, keySig, chords } = data;
        const fourPart = (data.voicingMode === 'fourpart');
        const beatsPerMeasure = 4;
        // 全音符每小节只占很窄一格，一行放 4 小节（16 小节 = 4 行，8 小节 = 2 行）
        const measuresPerLine = 4;

        const SCALE = 2.0;
        const canvasWidth = 1400;
        const width = Math.round(canvasWidth / SCALE);
        // 大谱表要竖着放两个五线谱，行高约为单行谱的 1.7 倍
        const lineHeight = fourPart ? 260 : 150;
        const topPad = 50;
        // 高亮带整行高 = lineHeight，最后一行需容下 bandTop + lineHeight（238 / 132），留 2px 余量
        const lastRowHeight = fourPart ? 240 : 136;
        const GRAND_GAP = 90;                       // 高音谱表 y → 低音谱表 y
        const CLEF_KEY_WIDTH = fourPart ? 85 : 80;

        const totalMeasures = chords.length;
        const totalLines = Math.ceil(totalMeasures / measuresPerLine);
        const sheetHeight = topPad + (totalLines - 1) * lineHeight + lastRowHeight;

        const availableWidth = width - 40;
        const unit = (availableWidth - CLEF_KEY_WIDTH) / measuresPerLine;

        // ---- 每小节的几何（两遍绘制共用，保证完全一致） ----
        const geom = [];
        for (let m = 0; m < totalMeasures; m++) {
            const line = Math.floor(m / measuresPerLine);
            const measureInLine = m % measuresPerLine;
            const isFirstInLine = (measureInLine === 0);
            const y = topPad + line * lineHeight;
            let x = 20;
            for (let i = 0; i < measureInLine; i++) {
                x += unit + (i === 0 ? CLEF_KEY_WIDTH : 0);
            }
            geom.push({
                x: x,
                y: y,
                isFirstInLine: isFirstInLine,
                staveWidth: unit + (isFirstInLine ? CLEF_KEY_WIDTH : 0)
            });
        }

        const accClass = Vex.Accidental || Vex.Flow.Accidental;

        // ============ 单行高音谱表（原模式，逻辑未改动） ============
        function drawSingleMeasure(ctx, g, m, shifts) {
            const x = g.x;
            const staveWidth = g.staveWidth;
            const isFirstInLine = g.isFirstInLine;

            const stave = new Vex.Stave(x, g.y, staveWidth);
            stave.setContext(ctx);
            if (isFirstInLine) {
                stave.addClef('treble').addKeySignature(key);
                if (m === 0) stave.setTimeSignature('4/4');
            }
            if (m === totalMeasures - 1) {
                stave.setEndBarType(Vex.Barline.type.END);
            }
            stave.draw();

            const chord = chords[m];
            const keys = chord.notes.map((n) => `${pitchName(n.letter, n.acc)}/${n.octave}`);
            const avgMidi = chord.midis.reduce((a, b) => a + b, 0) / chord.midis.length;
            const stemDir = avgMidi > 71 ? -1 : 1;

            // 每小节 1 个全音符柱式和弦（4/4 拍 = 一个全音符）
            // 全音符没有符干，谱面干净；临时记号照常加在最左
            const note = new Vex.StaveNote({ keys: keys, duration: '1n' });
            chord.notes.forEach((n, idx) => {
                const acc = accidentalOf(n.letter, n.acc, keySig);
                if (acc) note.addModifier(new accClass(acc), idx);
            });
            note.setStemDirection(stemDir);
            const noted = [note];

            const voice = new Vex.Voice({ num_beats: beatsPerMeasure, beat_value: 4 });
            voice.setStrict(true);
            voice.addTickables(noted);

            const formatterWidth = isFirstInLine
                ? (x + staveWidth) - stave.getNoteStartX() - 30
                : staveWidth - 30;
            const formatter = new Vex.Formatter();
            formatter.format([voice], formatterWidth);

            // 本小节的"音符可用区"中心（首小节要扣掉谱号/调号/拍号占位）
            const areaLeft = stave.getNoteStartX();
            const areaRight = x + staveWidth - 14;
            const centerX = (areaLeft + areaRight) / 2;
            const glyphW = (typeof note.getGlyphWidth === 'function')
                ? note.getGlyphWidth() : 16;

            // 第二遍：把和弦平移到小节中央（第一遍量出的自然落点 + 已知偏移量）
            if (shifts) {
                try { note.setXShift(shifts[m]); } catch (e) { /* 居中失败不影响出谱 */ }
            }

            voice.draw(ctx, stave);

            // 这个 VexFlow 构建里横向位置要 draw() 之后才确定，也是必须量两遍的原因
            let naturalAbs = NaN;
            try { naturalAbs = note.getAbsoluteX(); } catch (e) { /* ignore */ }
            const measured = { naturalAbs: naturalAbs, centerX: centerX, glyphW: glyphW };

            // 罗马数字级数标注（谱表下方，居中于本小节的和弦）
            ctx.save();
            ctx.setFont('Arial', 14, '');
            ctx.setFillStyle('#555');
            const labelY = stave.getYForLine(4) + 46;
            const estW = chord.roman.length * 8;
            ctx.fillText(chord.roman, centerX - estW / 2, labelY);
            ctx.restore();

            return measured;
        }

        // ============ 大谱表 SATB（四部和声模式） ============
        function drawFourPartMeasure(ctx, g, m, shifts) {
            const x = g.x;
            const staveWidth = g.staveWidth;
            const isFirstInLine = g.isFirstInLine;
            const isLast = (m === totalMeasures - 1);

            const treble = new Vex.Stave(x, g.y, staveWidth);
            const bass = new Vex.Stave(x, g.y + GRAND_GAP, staveWidth);
            treble.setContext(ctx);
            bass.setContext(ctx);

            if (isFirstInLine) {
                treble.addClef('treble').addKeySignature(key);
                bass.addClef('bass').addKeySignature(key);
                if (m === 0) {
                    // 拍号两个谱表都要记（标准大谱表写法）。只记上谱表的话，
                    // 该行的下谱表音符起始会比上谱表早 33 个单位。
                    treble.setTimeSignature('4/4');
                    bass.setTimeSignature('4/4');
                }
            }
            if (isLast) {
                treble.setEndBarType(Vex.Barline.type.END);
                bass.setEndBarType(Vex.Barline.type.END);
            }
            // 高音谱号与低音谱号字宽差 ~0.5 → 把下谱表的音符起始对齐到上谱表，
            // 保证 A/S 与 B/T 落在同一 x。★只在「本小节内」对齐：
            //   绝不能跨小节取 Max 再回灌到所有小节 —— 那样每个小节的音符都会被
            //   挤到同一个 x（8 个小节叠在一起），已踩过这个坑。
            try { bass.setNoteStartX(treble.getNoteStartX()); } catch (e) { /* ignore */ }
            treble.draw();
            bass.draw();

            const chord = chords[m];
            const notes = chord.notes;                 // 升序：[0]=B [1]=T [2]=A [3]=S
            const keyOf = (n) => `${pitchName(n.letter, n.acc)}/${n.octave}`;

            // 上谱表记 A + S，下谱表记 B + T。
            // 全音符没有符干，所以"两个声部合成一个和弦"与分开画在视觉上完全等价，
            // 合成一个 StaveNote 更稳（少一层 formatter，不会出现上下错位）。
            // ★ 必须显式声明 clef：StaveNote 默认按高音谱表算 y，不传的话低音声部
            //   会整体下移 60 个单位（多出一串加线）。已用受控实验取证。
            const upper = new Vex.StaveNote({
                keys: [keyOf(notes[2]), keyOf(notes[3])], duration: '1n', clef: 'treble'
            });
            const lower = new Vex.StaveNote({
                keys: [keyOf(notes[0]), keyOf(notes[1])], duration: '1n', clef: 'bass'
            });
            [[upper, notes[2], 0], [upper, notes[3], 1],
             [lower, notes[0], 0], [lower, notes[1], 1]].forEach(([nt, n, idx]) => {
                const acc = accidentalOf(n.letter, n.acc, keySig);
                if (acc) nt.addModifier(new accClass(acc), idx);
            });
            upper.setStemDirection(1);    // 高音声部符干向上（全音符不可见，留给后续扩展）
            lower.setStemDirection(-1);   // 低音声部符干向下

            const vU = new Vex.Voice({ num_beats: beatsPerMeasure, beat_value: 4 });
            vU.setStrict(true);
            vU.addTickables([upper]);
            const vL = new Vex.Voice({ num_beats: beatsPerMeasure, beat_value: 4 });
            vL.setStrict(true);
            vL.addTickables([lower]);

            const formatterWidth = isFirstInLine
                ? (x + staveWidth) - treble.getNoteStartX() - 30
                : staveWidth - 30;
            const formatter = new Vex.Formatter();
            formatter.joinVoices([vU]);
            formatter.joinVoices([vL]);
            // 两个声部一起 format → 共享 tick context → 上下谱表的 x 完全一致
            formatter.format([vU, vL], formatterWidth);

            const areaLeft = treble.getNoteStartX();
            const areaRight = x + staveWidth - 14;
            const centerX = (areaLeft + areaRight) / 2;
            const glyphW = (typeof upper.getGlyphWidth === 'function')
                ? upper.getGlyphWidth() : 16;

            if (shifts) {
                try {
                    upper.setXShift(shifts[m]);
                    lower.setXShift(shifts[m]);      // 两个谱表用同一偏移，保持垂直对齐
                } catch (e) { /* ignore */ }
            }

            vU.draw(ctx, treble);
            vL.draw(ctx, bass);

            let naturalAbs = NaN;
            try { naturalAbs = upper.getAbsoluteX(); } catch (e) { /* ignore */ }

            // 左侧竖线：只在每行第一个小节画一次，让行的左端与行内其它小节线一致。
            //   （这里原本还画一个"大括号"BRACE —— 形似一张弓 —— 用户 2026-10-06 要求去掉。）
            if (isFirstInLine) {
                try {
                    const line = new Vex.StaveConnector(treble, bass);
                    line.setType(Vex.StaveConnector.type.SINGLE_LEFT);
                    line.setContext(ctx).draw();
                } catch (e) { /* ignore */ }
            }

            // 罗马数字级数标注：放在低音谱表下方（两谱表中间的位置会被音符占满）
            // 34 = 低音谱表底线往下 34 个单位；最低音 F2 的加线在 +5，不会撞上。
            // 想让级数离谱表更远/更近，就改这个 34。
            ctx.save();
            ctx.setFont('Arial', 14, '');
            ctx.setFillStyle('#555');
            const labelY = bass.getYForLine(4) + 34;
            const estW = chord.roman.length * 8;
            ctx.fillText(chord.roman, centerX - estW / 2, labelY);
            ctx.restore();

            return {
                naturalAbs: naturalAbs,
                centerX: centerX,
                glyphW: glyphW
            };
        }

        // ---- 一遍绘制；shifts 为 null 时是"量算遍"，返回每小节的自然落点 ----
        function drawSheet(shifts) {
            const renderer = new Vex.Renderer(container, Vex.Renderer.Backends.SVG);
            renderer.resize(canvasWidth, Math.round(sheetHeight * SCALE));

            const ctx = renderer.getContext();
            ctx.scale(SCALE, SCALE);
            ctx.setFont('Arial', 10, '').setBackgroundFillStyle('#fdfaf0');

            const measured = [];
            for (let m = 0; m < totalMeasures; m++) {
                measured.push(fourPart
                    ? drawFourPartMeasure(ctx, geom[m], m, shifts)
                    : drawSingleMeasure(ctx, geom[m], m, shifts));
            }
            return measured;
        }

        try {
            // pass 1：量出每小节全音符的自然落点
            const measured = drawSheet(null);
            // pass 2：算出"移正到小节中心"所需偏移，清空重画
            const shifts = measured.map((r) => {
                if (!isFinite(r.naturalAbs)) return 0;
                return r.centerX - (r.naturalAbs + r.glyphW / 2);
            });
            container.innerHTML = '';
            drawSheet(shifts);

            // ---- 每小节挂一个"命中 + 高亮"矩形 ----
            //   必须在 drawSheet 之后追加（上面的 innerHTML='' 会清空第一遍的 SVG）。
            //   坐标用逻辑坐标（与 SVG viewBox 同一坐标系，和音符一致）→ 不需要任何
            //   clientX → viewBox 的换算。fill-opacity=0 时靠 pointer-events:all 仍可点击。
            sheetGeom = geom;
            measureRects = [];
            const hitSvg = container.querySelector('svg');
            if (hitSvg) {
                // 带高 = 整整一行（= lineHeight）：上一行带底 = 下一行带顶，相邻行严丝合缝，
                // 与每小节外面的黑色细框底边对齐；判定区就是这个 rect 本身，自动同步。
                const bandTop = fourPart ? -22 : -18;
                const bandH = lineHeight;
                for (let m = 0; m < totalMeasures; m++) {
                    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    r.setAttribute('x', String(geom[m].x));
                    r.setAttribute('y', String(geom[m].y + bandTop));
                    r.setAttribute('width', String(geom[m].staveWidth));
                    r.setAttribute('height', String(bandH));
                    // 微圆角；描边=每小节外面那圈"包裹框"（浅灰细线），填充=点亮时的色块
                    r.setAttribute('rx', '6');
                    r.setAttribute('fill', HL_FILL);
                    r.setAttribute('fill-opacity', '0');
                    r.setAttribute('stroke', HL_STROKE);
                    r.setAttribute('stroke-width', HL_SW);
                    r.setAttribute('pointer-events', 'all');
                    r.setAttribute('style', 'cursor:pointer');
                    r.dataset.measure = String(m);
                    hitSvg.appendChild(r);
                    measureRects.push(r);
                }
                // 重绘不丢状态：若正在播放，把高亮恢复回去
                if (highlightedMeasure >= 0 && highlightedMeasure < measureRects.length) {
                    measureRects[highlightedMeasure].setAttribute('fill-opacity', HL_OP);
                }
            }

            // 手机竖屏：按 viewBox 比例显式设高（与视唱页同一处理）
            const svgEl = container.querySelector('svg');
            if (svgEl) {
                const vb = svgEl.getAttribute('viewBox');
                if (vb) {
                    const p = vb.split(/\s+/);
                    const vbW = parseFloat(p[2]);
                    const vbH = parseFloat(p[3]);
                    if (vbW > 0 && vbH > 0) {
                        requestAnimationFrame(() => fitSheetSvgHeight(svgEl, vbW, vbH));
                    }
                }
            }
        } catch (err) {
            console.error('和弦谱面渲染出错:', err);
            container.innerHTML = `<div style="color:red;padding:20px;">五线谱渲染出错: ${err.message}</div>`;
        }
    }

    // 手机竖屏下 SVG 的显式高度补偿（渲染完 / 谱表页展开时都要补一次 ——
    // 若渲染发生在不可见容器里，这里量到宽度 0 会静默跳过，靠 CSS height:auto 兜底）
    function fitSheetSvgHeight(svgEl, vbW, vbH) {
        if (window.innerWidth > 768) { svgEl.style.height = ''; return; }
        const w = svgEl.getBoundingClientRect().width;
        if (w > 0) svgEl.style.height = (w * vbH / vbW) + 'px';
    }

    // ------------------------------------------------------------
    // 音频：时间表 / 采样解析 / 离线混音
    // ------------------------------------------------------------

    // 随身听模式要用的"这个和弦的根音"（单音）。
    //   不能直接取 midis[0] —— 那是最低音，转位时它不是根音（比如 Ⅰ⁶ 的低音是 3）。
    //   做法：该级数在调内的根音 pc（scale[degree-1].pc），取离和弦最低音最近的那个八度；
    //   相差超过三全音（> 6 半音）就往下取一个八度，免得根音听着比整个和弦还高。
    //   scale 拿不到时退回最低音（不会出错，只是转位时提示音不够精确）。
    function chordRootMidi(chord, scale) {
        const d = chord.degree;
        if (!scale || !scale[d - 1] || !chord.midis || !chord.midis.length) return chord.midis[0];
        const rootPc = scale[d - 1].pc;
        const bass = chord.midis[0];
        let off = (((rootPc - (bass % 12)) % 12) + 12) % 12;
        if (off > 6) off -= 12;
        return bass + off;
    }

    // 一小节 1 个和弦，每拍弹 1 下（四分音符柱式）
    // 播放排程
    //   mode 'block'     柱式：一小节 4 拍，每拍 1 下（各声部同时发声）—— 原有行为，默认值
    //   mode 'arpeggio'  分解：一小节 16 个十六分音符，和弦音（低→高）循环滚动
    //   mode 'bass'      单音：每小节只弹一次最低音，长音铺满整小节
    // 事件结构 { time, midis, dur }；分解/单音会额外带 hold / gain，用来覆盖包络默认值。
    //
    // opts.portable（随身听模式，默认 false）：
    //   **每小节的最后一拍只弹这个和弦的根音**，三种方式统一 ——
    //   柱式换掉第 4 拍、分解换掉末拍那一组十六分、单音本来整小节就一颗（换成根音）。
    //   用户 2026-10-06："不用看屏幕，听到最后一个根音就知道这个和弦是几级"。
    //   ★ portable 为 false 时走的是与改造前**一模一样**的分支（逐字节不变），守和声回归基线。
    function buildChordSchedule(chords, tempo, mode, opts) {
        mode = mode || 'block';
        const o = opts || {};
        const portable = !!o.portable;
        const scale = o.scale || null;
        const beatDur = 60 / tempo;
        const events = [];

        for (let m = 0; m < chords.length; m++) {
            const chord = chords[m];
            const base = m * 4 * beatDur;
            // 随身听模式要用的根音。关着的时候连算都不算，不引入任何数值差异。
            const root = portable ? chordRootMidi(chord, scale) : 0;

            if (mode === 'arpeggio') {
                const six = beatDur / 4;              // 十六分音符时长
                // 单行谱三和弦（3 音）：重复低音凑成四音分解，且低音放在本组的**最后一个**、
                //   高八度出现 —— 例：[低, 中, 高]（记作 351）→ [低, 中, 高, 低+12]（3513）。
                //   一小节 16 个十六分音符 = 4 组，k = 0,4,8,12 正好各占一拍，节拍不乱。
                // 4 音的和弦（七和弦 / 四部和声）本来就够四个位置 → 原样低→高循环。
                const pattern = (chord.midis.length === 3)
                    ? [chord.midis[0], chord.midis[1], chord.midis[2], chord.midis[0] + 12]
                    : chord.midis;
                const pn = pattern.length;
                // 随身听：末拍那一组（k = 12..15）不排十六分，改成一颗根音按住一整拍 ——
                //   前半小节照旧滚，最后一拍"落地"给根音，听感上就是一句收束。
                const kb = portable ? 12 : 16;
                for (let k = 0; k < kb; k++) {
                    events.push({
                        time: base + k * six,
                        midis: [pattern[k % pn]],     // 从低音起，逐音上行，循环
                        dur: six,
                        // 每个音按住一整拍：钢琴采样本身在长衰减，密排会自然叠成
                        // "踏板式"的连贯琶音；若按十六分硬切会丢掉尾音、变得干瘪。
                        hold: beatDur,
                        // 同一音在一拍内出现 4 次，同相叠加会明显偏响，这里压一半。
                        gain: 0.5
                    });
                }
                if (portable) {
                    events.push({
                        time: base + 3 * beatDur,
                        midis: [root],
                        dur: beatDur,
                        hold: beatDur,
                        gain: 0.5                  // 与分解的其余音同响度
                    });
                }
            } else if (mode === 'bass') {
                events.push({
                    // midis 升序 → [0] 就是最低音；随身听模式下换成根音
                    midis: [portable ? root : chord.midis[0]],
                    time: base,
                    dur: 4 * beatDur                  // 长音＝整小节；hold 交给 legato 决定
                });
            } else {
                for (let b = 0; b < 4; b++) {
                    // 保持原来的表达式写法（不做 base + b*beat 的等价重构）：
                    // 浮点下两者会有末位差异，这里是"原行为逐字节不变"的保险。
                    const lastBeat = portable && b === 3;
                    events.push({
                        time: (m * 4 + b) * beatDur,
                        midis: lastBeat ? [root] : chord.midis,
                        dur: beatDur
                    });
                }
            }
        }
        return events;
    }

    function pianoFilename(midi) {
        return 'piano_' + midi + '.mp3';
    }

    // 在缓存里找最接近 midi 的采样；返回 { buffer, rate }
    function resolveSample(midi) {
        const host = global.ChordHost;
        if (!host || !host.bufferCache) return null;
        const cache = host.bufferCache;

        if (cache.has(pianoFilename(midi))) {
            return { buffer: cache.get(pianoFilename(midi)), rate: 1 };
        }
        for (let off = 1; off <= 24; off++) {
            for (const cand of [midi - off, midi + off]) {
                if (cand < SAMPLE_MIDI_LO || cand > SAMPLE_MIDI_HI) continue;
                const fn = pianoFilename(cand);
                if (cache.has(fn)) {
                    return { buffer: cache.get(fn), rate: Math.pow(2, (midi - cand) / 12) };
                }
            }
        }
        return null;
    }

    function preloadChordSamples(onProgress) {
        const host = global.ChordHost;
        if (!host) return Promise.resolve(0);

        const names = [];
        for (let m = SAMPLE_MIDI_LO; m <= SAMPLE_MIDI_HI; m++) names.push(pianoFilename(m));

        let done = 0;
        let ok = 0;
        const tasks = names.map((fn) =>
            host.getAudioBuffer(fn, SAMPLE_DIR + encodeURIComponent(fn)).then((buf) => {
                done++;
                if (buf) ok++;
                if (onProgress) onProgress(`加载钢琴采样 ${done}/${names.length}…`);
            })
        );
        return Promise.all(tasks).then(() => ok);
    }

    // 混音后归一化：柱式和弦是 3~4 个音同时起振，峰值叠加很容易超过 1.0 被削顶
    // （削顶 = 刺耳的失真）。这里统一把峰值拉到 −1 dBFS，既保证不削顶，也让每段音量一致。
    function normalizeBuffer(ctx, buffer, target) {
        const nch = buffer.numberOfChannels;
        const len = buffer.length;
        let peak = 0;
        for (let c = 0; c < nch; c++) {
            const d = buffer.getChannelData(c);
            for (let i = 0; i < len; i++) {
                const v = d[i] < 0 ? -d[i] : d[i];
                if (v > peak) peak = v;
            }
        }
        if (peak < 1e-6) return buffer;                 // 全静音（采样缺失），原样返回
        let gain = target / peak;
        if (gain > 3) gain = 3;                          // 限制最大提升，避免把底噪放大
        if (Math.abs(gain - 1) < 0.02) return buffer;

        const out = ctx.createBuffer(nch, len, buffer.sampleRate);
        for (let c = 0; c < nch; c++) {
            const src = buffer.getChannelData(c);
            const dst = out.getChannelData(c);
            for (let i = 0; i < len; i++) {
                const v = src[i] * gain;
                dst[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
            }
        }
        return out;
    }

    // 强调低音：把滑块 0..100 换算成"低音增益要提升的比例"。0 = 关闭（返回 0，混音路径不变）。
    function bassEmphasisFactor() {
        const v = Number(settings.bassEmphasis) || 0;
        const k = Math.max(0, Math.min(100, v)) / 100;
        return (k > 0) ? k * BASS_EMPH_MAX : 0;
    }

    async function renderChordAudio(chords, tempo, onProgress, mode) {
        mode = mode || 'block';
        const report = (t) => { if (onProgress) onProgress(t); };
        const host = global.ChordHost;
        if (!host) throw new Error('音频桥接不可用');

        report('构建时间表…');
        // 随身听模式：末拍只给根音。scale 用来算"这个级数的根音是哪个音"。
        const events = buildChordSchedule(chords, tempo, mode, {
            scale: data && data.scale,
            portable: !!settings.portable
        });

        const legato = LEGATO;
        // 事件自带 hold 时用它（分解模式固定一拍），否则按连奏算 —— 柱式/单音行为不变
        const holdOf = (e) => (e.hold != null) ? e.hold : e.dur * legato;
        const slot = (e) => e.time + holdOf(e) + CHORD_RELEASE;

        let total = 0;
        events.forEach((e) => { total = Math.max(total, slot(e)); });
        total += 1.6;   // 尾音余量

        const sampleRate = 44100;
        const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const offlineCtx = new OfflineCtx(2, Math.ceil(total * sampleRate), sampleRate);

        report('混音中…');
        let missing = 0;
        // ★ 强调低音（用户 2026-10-07）：按"这个事件落在哪一小节"取该小节的**最低音**
        //   （chords[m].midis 已升序 → [0] 就是谱面最下面那个音），只给它一个人提增益。
        //   ★ 刻意只在混音这一步做，**不动 buildChordSchedule** —— 排程回归基线（triad
        //     sha256）靠的就是排程逐字节不变。emphK = 0 时下行代码与改造前完全等价。
        const emphK = bassEmphasisFactor();
        const measureSpan = 4 * (60 / tempo);
        const bassMidiOf = (e) => {
            if (emphK <= 0 || !chords.length) return -1;
            const m = Math.max(0, Math.min(chords.length - 1, Math.floor(e.time / measureSpan)));
            const c = chords[m];
            return (c && c.midis && c.midis.length) ? c.midis[0] : -1;
        };
        for (const e of events) {
            const g = (e.gain != null) ? e.gain : 1.0;
            const bassMidi = bassMidiOf(e);
            for (const midi of e.midis) {
                const s = resolveSample(midi);
                if (!s) { missing++; continue; }

                const src = offlineCtx.createBufferSource();
                src.buffer = s.buffer;
                src.playbackRate.value = s.rate;

                const gain = offlineCtx.createGain();
                src.connect(gain);
                gain.connect(offlineCtx.destination);

                // 低音那颗提亮；其余音照旧（最后整段做峰值归一化 → 相对差保留，不会削顶）
                const gg = (emphK > 0 && midi === bassMidi) ? g * (1 + emphK) : g;

                // 连奏包络：4ms 起音 → 按住（hold）→ 短淡出。
                // 注意：这里**不再**人为做指数衰减 —— 之前的写法把这颗音从 0dB 强压到 -80dB，
                // 比钢琴自身的衰减快十几倍，听着就是"弹一下就没了"。现在让采样自己衰减。
                const t = e.time;
                const hold = holdOf(e);           // 按住多久（秒）
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(gg, t + 0.004);
                gain.gain.setValueAtTime(gg, t + hold);
                gain.gain.linearRampToValueAtTime(0, t + hold + CHORD_RELEASE);

                src.start(t);
                src.stop(t + hold + CHORD_RELEASE + 0.05);
            }
        }
        if (missing > 0) {
            console.warn('和弦音频：有 ' + missing + ' 个音找不到采样（音源/和弦钢琴/ 是否已渲染？）');
        }

        const mixed = await offlineCtx.startRendering();

        report('编码 WAV…');
        let out = mixed;
        const hostCtx = host.audioContext;
        if (hostCtx && typeof hostCtx.createBuffer === 'function') {
            out = normalizeBuffer(hostCtx, mixed, 0.89);   // −1 dBFS
        }
        return host.audioBufferToWav(out);
    }

    // 现场起 BufferSource 播一小撮音（不走离线渲染），供听辩辅助窗用。
    //   style 'arp'   上行「和弦分解」：**如实按和弦里的音个数**、原序（低 → 高）——
    //                 三和弦 3 个音、七和弦 4 个音，**不再把低音翻高八度重复一遍**
    //                 （用户 2026-10-06：三和弦模式下不需要重复低音），每音间隔 0.325s。
    //                 ★ 只改这里；主播放的「分解和弦」排程（buildChordSchedule）保持原样。
    //   style 'block' 柱式：全音同时、只弹一下
    //   style 'note'  单音（点辅助窗右侧的简谱数字试听）：包络同柱式，只响一个音
    //   音源全部登记进 mpAid.sources，关窗/重放前可随时 stop()。采样缺失只 warn 不抛。
    //
    //   ★ 解锁必须"同步"发生（2026-10-06 修「上滑与窗里按钮都没声」）：
    //     ① initAudio() 与 resume() 都**不要 await** —— 它们内部本身是同步的
    //        （new AudioContext() / resume() 都是同步调用），一旦 await 就跳出用户手势的
    //        同步调用栈，iOS 会拒绝这次 resume → "看着在排程、其实一个音都不响"。
    //     ② 状态判断用 `!== 'running'`：iOS 除 'suspended' 还有 Safari 私有的
    //        'interrupted'（主 <audio> 播放/暂停之后常落到这个态），只认前者就永远不解锁。
    //     ③ audioContext 的判空要放在 initAudio() **之后**（旧版写在前面，顺序反了）。
    //   ★ 这里只是"尽力解锁"。真正稳的解锁点在真·激活事件里：
    //     见 bindStageGesture 的 pointerdown（unlockAudioNow）与 finish() 的 pointerup 补放。
    //   返回 { ok, ctxState, scheduled } 供验收断言（"有没有真的排上程"）。
    async function playInstantChord(midis, style) {
        const host = global.ChordHost;
        if (!host) return { ok: false, reason: 'no-host', scheduled: 0 };
        // 同步解锁（绝不 await）：initAudio + resume 都在用户手势的同步栈里跑。
        //   走 unlockAudioNow 是为了复用「宿主有自愈版就用自愈版」这条逻辑。
        unlockAudioNow();
        const ctx = host.audioContext;
        if (!ctx) return { ok: false, reason: 'no-ctx', scheduled: 0 };

        const isBlock = (style === 'block' || style === 'note');
        // 和弦分解 = 原序播放和弦里的每个音，有几个响几个（三和弦 3 个、七和弦 4 个）。
        const pattern = isBlock ? null : midis.slice();
        const GAP = 0.325;                 // 和弦分解每音间隔
        const notes = isBlock
            ? midis.map((m) => ({ midi: m, at: 0, hold: Math.min(0.8, 60 / settings.tempo), gain: 0.45 }))
            : pattern.map((m, i) => ({ midi: m, at: i * GAP, hold: 0.3, gain: 0.5 }));

        let scheduled = 0;
        let missing = 0;
        for (const n of notes) {
            const s = resolveSample(n.midi);
            if (!s) { missing++; continue; }
            const src = ctx.createBufferSource();
            src.buffer = s.buffer;
            src.playbackRate.value = s.rate;
            const gain = ctx.createGain();
            src.connect(gain); gain.connect(ctx.destination);
            const t = ctx.currentTime + n.at;
            // 包络与 renderChordAudio 一致：4ms 起音 → 按住 → 短淡出
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(n.gain, t + 0.004);
            gain.gain.setValueAtTime(n.gain, t + n.hold);
            gain.gain.linearRampToValueAtTime(0, t + n.hold + CHORD_RELEASE);
            src.start(t);
            src.stop(t + n.hold + CHORD_RELEASE + 0.05);
            if (mpAid) mpAid.sources.push(src);
            scheduled++;
        }
        if (missing > 0) {
            console.warn('听辩辅助：有 ' + missing + ' 个音找不到采样（音源/和弦钢琴/ 是否已加载？）');
        }
        // 点音名可以连点（用户要"叠着响，像弹琴"）→ 声源会累积，偶尔剪掉最老的几个
        if (mpAid && mpAid.sources.length > 40) {
            const old = mpAid.sources.splice(0, 16);
            old.forEach((s) => { try { s.stop(); } catch (e) {} });
        }
        const ok = (ctx.state === 'running' && scheduled > 0);
        // 记下这一声的音高（验收要断言"点哪个音名就发哪个音高"，光看 scheduled 不够）
        mpAidLast = { style: style, ok: ok, ctxState: ctx.state,
                      scheduled: scheduled, midis: midis.slice() };
        return { ok: ok, ctxState: ctx.state, scheduled: scheduled };
    }

    // 在**真·用户激活事件**里把 AudioContext 解锁好（同步，不 await）。
    //   为什么要单独有这么一手：下滑那声琶音是在 `pointermove` 里播的，而 pointermove
    //   **不是**用户激活事件（pointerdown / pointerup / touchend / click / keydown 才是），
    //   在那里调 resume() 会被 iOS 拒绝。长按下滑的开头必有一个 pointerdown —— 在那一刻
    //   就把上下文唤醒，等 160ms 后手指滑上去时它已经是 running，直接排程就出声。
    //   initAudio()/resume() 都是同步完成幂等的，重复调用无副作用。
    //   ★ 第十六轮追加：如果宿主提供了 ensureAudioLive（自愈版），优先用它 ——
    //     它在 resume 之后还会异步复核，实在起不来就原地重建上下文（切后台回来没声的解法）。
    function unlockAudioNow() {
        const host = global.ChordHost;
        if (!host) return;
        try {
            if (typeof host.ensureAudioLive === 'function') { host.ensureAudioLive(); return; }
            if (!host.audioContext) host.initAudio();
            const ctx = host.audioContext;
            // ★ resume() 返回 Promise，失败时**必须** catch —— 否则会产生未捕获 rejection
            //   （验收里有"无未捕获异常"这一条，也会污染控制台）。
            if (ctx && ctx.state !== 'running') {
                try { ctx.resume().catch(() => {}); } catch (e) {}
            }
        } catch (e) {}
    }

    // ------------------------------------------------------------
    // 配置持久化（与视唱页完全隔离）
    // ------------------------------------------------------------

    let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

    function loadSettings() {
        let raw;
        try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) { return; }
        if (!raw) return;
        let s;
        try { s = JSON.parse(raw); } catch (e) { return; }
        if (!s || typeof s !== 'object') return;

        if (s.length === 8 || s.length === 16) settings.length = s.length;
        if (typeof s.tempo === 'number' && s.tempo >= 40 && s.tempo <= 120) settings.tempo = s.tempo;
        if (typeof s.allowInversion === 'boolean') settings.allowInversion = s.allowInversion;
        if (typeof s.allowSecondInv === 'boolean') settings.allowSecondInv = s.allowSecondInv;
        if (s.voicingMode === 'triad' || s.voicingMode === 'fourpart') settings.voicingMode = s.voicingMode;
        if (typeof s.autoContinue === 'boolean') settings.autoContinue = s.autoContinue;
        if (typeof s.portable === 'boolean') settings.portable = s.portable;
        if (typeof s.adaptiveFromStats === 'boolean') settings.adaptiveFromStats = s.adaptiveFromStats;
        // ★ 白名单登记：枚举值一定要显式收，否则 localStorage 里存着也会被悄悄丢掉。
        if (s.revealMode === 'roman' || s.revealMode === 'bass') settings.revealMode = s.revealMode;
        // 强调低音（0..100，整数；老配置里没有这个键就是默认 0）
        if (typeof s.bassEmphasis === 'number' && isFinite(s.bassEmphasis)) {
            settings.bassEmphasis = Math.max(0, Math.min(100, Math.round(s.bassEmphasis)));
        }
        // 连奏已固定 1.0（用户 2026-10-06 拍板，滑块已删）：localStorage 里的旧值一律忽略
        if (s.degrees && typeof s.degrees === 'object') {
            for (let d = 1; d <= 7; d++) {
                if (typeof s.degrees[d] === 'boolean') settings.degrees[d] = s.degrees[d];
            }
        }
        if (s.seventhProb && typeof s.seventhProb === 'object') {
            for (let d = 1; d <= 7; d++) {
                const v = parseInt(s.seventhProb[d]);
                if (!isNaN(v)) settings.seventhProb[d] = Math.max(0, Math.min(100, v));
            }
        }
        settings.degrees[1] = true;   // 端点强制
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
        catch (e) { console.warn('和弦设置保存失败:', e); }
    }

    // ============================================================
    // 听辨统计（数据库页的数据源 + 出题加权的依据）
    //
    //   两个 scope：
    //     statsAll     = 历史总计（只有用户点「清空历史」才归零）
    //     statsSession = 本轮（点「清空本轮」归零，重新计数）
    //   每份结构相同：
    //     confusion: { 实际级数: { 你听成的级数: 次数 } }  —— 键 "0" = "没听出来"
    //     combos:    { "前2|前1|它": { seen, wrong } }     —— 上下文三和弦组合
    //     seen:      { 级数: 听过次数 }                    —— 错误率的分母（出题加权要用）
    //     wrong:     { 级数: 报错次数 }                    —— 错误率的分子
    //     totals:    { heard, reports }
    //
    //   ★ 为什么必须统计 seen：只记报错的话连"错误率"的分母都没有，
    //     "错的多出一点、正确了降回来"就无从谈起。
    //   ★ 每条报错的明细不落盘，只在内存 mpReports 里留最近若干条。
    //   ★ combos 以"级数三元组"为 key，天然最多 7^3 = 343 种，不会爆炸；
    //     另设 MAX_COMBOS 兜底，将来加了转位/七和弦维度也不会失控。
    // ============================================================

    const STATS_KEY = 'chordTrainerStats';
    const STATS_SESSION_KEY = 'chordTrainerStatsSession';
    const STATS_VERSION = 1;
    const MAX_COMBOS = 2000;

    function emptyStats() {
        return {
            v: STATS_VERSION,
            updatedAt: 0,
            confusion: {},
            combos: {},
            seen: {},
            wrong: {},
            totals: { heard: 0, reports: 0 }
        };
    }

    function normalizeStats(o) {
        const out = emptyStats();
        if (!o || typeof o !== 'object' || o.v !== STATS_VERSION) return out;
        if (o.confusion && typeof o.confusion === 'object') out.confusion = o.confusion;
        if (o.combos && typeof o.combos === 'object') out.combos = o.combos;
        if (o.seen && typeof o.seen === 'object') out.seen = o.seen;
        if (o.wrong && typeof o.wrong === 'object') out.wrong = o.wrong;
        if (o.totals && typeof o.totals === 'object') {
            out.totals.heard = Number(o.totals.heard) || 0;
            out.totals.reports = Number(o.totals.reports) || 0;
        }
        out.updatedAt = Number(o.updatedAt) || 0;
        return out;
    }

    function readStats(key) {
        let raw;
        try { raw = localStorage.getItem(key); } catch (e) { return emptyStats(); }
        if (!raw) return emptyStats();
        try { return normalizeStats(JSON.parse(raw)); } catch (e) { return emptyStats(); }
    }

    let statsAll = emptyStats();
    let statsSession = emptyStats();

    // 超过上限就把长尾丢掉。淘汰排序 **wrong 优先**（从没错过 → seen 升序）：
    //   榜单和错题练习只看 wrong>0 的键，先淘汰"从未出错"的窗口，保护已积累的错误数据。
    function trimCombos(scope) {
        const keys = Object.keys(scope.combos);
        if (keys.length <= MAX_COMBOS) return;
        keys.sort((a, b) => ((scope.combos[a].wrong || 0) - (scope.combos[b].wrong || 0))
            || ((scope.combos[a].seen || 0) - (scope.combos[b].seen || 0)));
        const drop = keys.length - MAX_COMBOS;
        for (let i = 0; i < drop; i++) delete scope.combos[keys[i]];
    }

    let statsFlushTimer = null;
    let statsFlushAt = 0;

    function flushStats() {
        if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null; }
        trimCombos(statsAll);
        trimCombos(statsSession);
        statsAll.updatedAt = Date.now();
        statsSession.updatedAt = statsAll.updatedAt;
        try {
            localStorage.setItem(STATS_KEY, JSON.stringify(statsAll));
            localStorage.setItem(STATS_SESSION_KEY, JSON.stringify(statsSession));
        } catch (e) { /* 隐私模式 / 配额满：不影响练习 */ }
    }

    // 写盘节流：报错排一次短的；仅仅"听过"排一次长的。
    //   避免每小节都 setItem（卡顿 + 耗电）。
    function markStatsDirty(delayMs) {
        const d = delayMs || 800;
        const at = Date.now() + d;
        if (statsFlushTimer && statsFlushAt <= at) return;
        if (statsFlushTimer) clearTimeout(statsFlushTimer);
        statsFlushAt = at;
        statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, d);
    }

    function loadStats() {
        statsAll = readStats(STATS_KEY);
        statsSession = readStats(STATS_SESSION_KEY);
    }

    // 某一小节"完整听完了" → 计入 seen 与错误组合榜的分母。
    //   口径是**播完才算**：在 setMeasureHighlight 里，当高亮从 m 跳到 m+1 时记 m。
    //   （"进入就算"在点小节跳转 / seek / 连播换段时会误计，而且会让"永远第一小节的 Ⅰ"被高估。）
    function recordHeard(m) {
        if (practiceMode) return;   // 错题练习的正确率不计入数据库
        if (!data || m < 0 || m >= data.chords.length) return;
        const d = data.chords[m].degree;
        const scopes = [statsAll, statsSession];
        for (let i = 0; i < scopes.length; i++) {
            const s = scopes[i];
            s.seen[d] = (s.seen[d] || 0) + 1;
            s.totals.heard = (s.totals.heard || 0) + 1;
            // 错误组合榜的分母：以当前小节结尾、长度 2/3/4 的窗口各 +1 次 seen。
            //   （只记"出现过"，报错时才有资格谈"错了几次"。）
            for (let L = 2; L <= 4; L++) {
                if (m < L - 1) break;
                const w = [];
                for (let j = m - L + 1; j <= m; j++) w.push(data.chords[j].degree);
                const k = w.join('|');
                const c = s.combos[k] || (s.combos[k] = { seen: 0, wrong: 0 });
                c.seen++;
            }
        }
        markStatsDirty(3000);
    }

    // 一次报错 → 混淆矩阵 + 该级错误次数 + 错误组合榜（长度 2/3/4 的窗口各计一次错）
    //   ★ 方向性：窗口按时间顺序拼 key（…前和弦 → 出错和弦），逆向 ≠ 正向。
    function recordReport(rec) {
        if (practiceMode) return;   // 错题练习不计入数据库
        const guessedKey = (rec.guessed == null) ? '0' : String(rec.guessed);
        const actualKey = String(rec.actual);
        const scopes = [statsAll, statsSession];
        for (let i = 0; i < scopes.length; i++) {
            const s = scopes[i];
            if (!s.confusion[actualKey]) s.confusion[actualKey] = {};
            s.confusion[actualKey][guessedKey] = (s.confusion[actualKey][guessedKey] || 0) + 1;
            s.wrong[actualKey] = (s.wrong[actualKey] || 0) + 1;
            s.totals.reports = (s.totals.reports || 0) + 1;
            const hist = [
                (rec.prev3 && rec.prev3[0] != null) ? rec.prev3[0] : null,
                (rec.prev3 && rec.prev3[1] != null) ? rec.prev3[1] : null,
                (rec.prev3 && rec.prev3[2] != null) ? rec.prev3[2] : null,
                rec.actual
            ];
            for (let L = 2; L <= 4; L++) {
                const w = hist.slice(4 - L);
                if (w.some((x) => x == null)) continue;   // 段首历史不足，该长度的窗口不成立
                const k = w.join('|');
                const c = s.combos[k] || (s.combos[k] = { seen: 0, wrong: 0 });
                c.wrong++;
            }
        }
        markStatsDirty(800);
    }

    // 切后台 / 关页面时补一次，免得 debounce 还没到就丢数据
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && statsFlushTimer) flushStats();
        });
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => { if (statsFlushTimer) flushStats(); });
    }

    // ------------------------------------------------------------
    // 出题加权（设置里的「使用用户数据优化题库」，默认关）
    //   err = (错次数 + K*P0) / (听次数 + K)          —— Beta 平滑：只错过一两次不会猛加权
    //   w   = clamp(1 + GAIN*(err - P0), WMIN, WMAX)  —— 有上下限，不会退化成只练一个级数
    //   冷启动（没数据）→ err = P0 → w = 1，与均匀随机完全一致。
    //   正确率回升 → err 回落 → w 自动降回基线（这就是"正确了就降回来"）。
    // ------------------------------------------------------------
    const ADAPT_P0 = 0.15;    // 基线错误率
    const ADAPT_K = 8;        // 先验强度（伪计数）：越大越保守
    const ADAPT_GAIN = 3;
    const ADAPT_WMIN = 0.5;
    const ADAPT_WMAX = 2.5;

    function degreeWeight(d, counts) {
        const n = counts.seen[d] || 0;
        const e = counts.wrong[d] || 0;
        const err = (e + ADAPT_K * ADAPT_P0) / (n + ADAPT_K);
        let w = 1 + ADAPT_GAIN * (err - ADAPT_P0);
        if (w < ADAPT_WMIN) w = ADAPT_WMIN;
        if (w > ADAPT_WMAX) w = ADAPT_WMAX;
        return w;
    }

    // 权重用"历史 + 本轮"的合并计数（历史样本更稳）
    function mergedCounts() {
        const seen = {}, wrong = {};
        for (let d = 1; d <= 7; d++) {
            seen[d] = (statsAll.seen[d] || 0) + (statsSession.seen[d] || 0);
            wrong[d] = (statsAll.wrong[d] || 0) + (statsSession.wrong[d] || 0);
        }
        return { seen: seen, wrong: wrong };
    }

    // 按权重从 list 里抽一个级数（list 已过滤掉"与上一个相同"的那个）
    function weightedPick(list) {
        const c = mergedCounts();
        const w = [];
        let sum = 0;
        for (let i = 0; i < list.length; i++) {
            const x = degreeWeight(list[i], c);
            w.push(x);
            sum += x;
        }
        let r = Math.random() * sum;
        for (let i = 0; i < list.length; i++) {
            r -= w[i];
            if (r <= 0) return list[i];
        }
        return list[list.length - 1];
    }

    // ============================================================
    // 错题练习：从错误组合榜挑组合 → 用 Ⅰ 级和弦当胶水串起来连着播
    // ============================================================

    // 取错题候选（历史 + 本轮合并）：wrong ≥ MIN_PRACTICE_WRONG、按 wrong 降序。
    //   ★ 只去"连续后缀"不去前缀 —— 方向性重要，Ⅴ→Ⅲ 和 Ⅲ→Ⅴ 是两回事；
    //     已选了长组合 [1,5,3] 就不再单练 [5,3]（后缀语境已被长组合覆盖）。
    const MIN_PRACTICE_WRONG = 2;

    function topPracticeCombos(maxCount) {
        const merged = {};
        [statsAll, statsSession].forEach((s) => {
            Object.keys(s.combos).forEach((k) => {
                const v = s.combos[k];
                if (!v || !v.wrong) return;
                if (!merged[k]) merged[k] = { seen: 0, wrong: 0 };
                merged[k].seen += (v.seen || 0);
                merged[k].wrong += v.wrong;
            });
        });
        const list = Object.keys(merged)
            .map((k) => ({ d: k.split('|').map((x) => parseInt(x, 10)), wrong: merged[k].wrong }))
            .filter((c) => c.wrong >= MIN_PRACTICE_WRONG && c.d.every((x) => x >= 1 && x <= 7))
            .sort((a, b) => (b.wrong - a.wrong) || (b.d.length - a.d.length));
        const picked = [];
        for (let i = 0; i < list.length && picked.length < maxCount; i++) {
            const c = list[i].d;
            const isSuffix = picked.some((p) => {
                if (p.length <= c.length) return false;
                return p.slice(p.length - c.length).every((x, j) => x === c[j]);
            });
            if (!isSuffix) picked.push(c);
        }
        return picked;
    }

    // 组合序列 → 级数序列：Ⅰ 胶水。相邻同度在这里从构造上被杜绝
    //   （前一个和弦是 Ⅰ 或组合自带 Ⅰ 开头时就不再额外插 Ⅰ）。
    function buildPracticeSequence(combos) {
        const seq = [];
        combos.forEach((c) => {
            if (!seq.length) {
                if (c[0] !== 1) seq.push(1);
                seq.push.apply(seq, c);
            } else if (seq[seq.length - 1] === 1 && c[0] === 1) {
                // 上段末尾已是 Ⅰ、本组合开头又带 Ⅰ：开头 Ⅰ 兼任胶水，跳过不重复
                seq.push.apply(seq, c.slice(1));
            } else if (seq[seq.length - 1] !== 1 && c[0] !== 1) {
                seq.push(1);
                seq.push.apply(seq, c);
            } else {
                // 已有一端是 Ⅰ，直接接上即可
                seq.push.apply(seq, c);
            }
        });
        if (seq[seq.length - 1] !== 1) seq.push(1);
        return seq;
    }

    // 错题练习的一段：随机调 + 随机顺序（Fisher-Yates）混合前几个错误组合。
    function practiceProgression() {
        const combos = topPracticeCombos(5);
        if (!combos.length) return null;
        for (let i = combos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = combos[i]; combos[i] = combos[j]; combos[j] = t;
        }
        return generateProgressionFromSequence(pickRandomMajorKey(), buildPracticeSequence(combos), settings);
    }

    // ------------------------------------------------------------
    // UI 与状态
    // ------------------------------------------------------------

    let data = null;              // { key, scale, keySig, chords }
    // 错题练习模式：出题换成"错误组合 + Ⅰ 胶水"，正确率不计入数据库，不设报错。
    let practiceMode = false;
    let mpStageView = 'card';     // 播放器舞台当前页：'card'（级数卡片）| 'sheet'（五线谱）
    let chordAudioEl = null;
    let blobUrl = null;
    let isRendering = false;

    // ---- 谱面点击跳转播放 + 播放位置高亮 ----
    //   音频是"整段离线渲染成一个 WAV"，所以"点某个小节"本质上就是给进度条设时间
    //   （audioEl.currentTime），不需要重新渲染。
    let sheetGeom = [];           // 每小节的几何（由 renderChordSheet 落盘）
    let measureRects = [];        // 每小节的命中/高亮 <rect>
    let highlightedMeasure = -1;  // 当前高亮的小节索引（-1 = 无）

    // 每小节热区 rect 上"两件互不相干的事"，别再混（用户 2026-10-06 纠正过一次）：
    //   fill / fill-opacity   = 点亮时的**色块**（铺满整行的暖琥珀）
    //   stroke / stroke-width = 每小节外面那圈**包裹框**（浅灰细线，淡到"能分辨出就行"）
    //   ★ stroke 必须**显式**写在 rect 上：不写就会继承 VexFlow 根 <svg> 的
    //     stroke=black / stroke-width=1（SVGContext 构造器把它写在根 <svg> 上，
    //     而 stroke 是可继承属性）→ 每小节默认自带一圈黑框。
    //     用户说的"每小节外面包裹的那个框（触发区的轮廓）"就是它。
    const HL_FILL = '#d97706';    // 点亮填充：琥珀（恢复第十轮那版的颜色）
    const HL_OP = '0.08';         // 填充深浅 ← 只改这一个数就能整体调浓淡
    const HL_STROKE = '#c9ccd4';  // 包裹框描边：冷浅灰 ← 只改这一个数就能调框的深浅
    const HL_SW = '1';            // 包裹框线宽（想更清楚可 1.2）
    let lastPlayMode = 'block';   // 记住上次按的播放键（点小节时沿用它）
    let blobData = null;          // 已渲染音频对应的 data（判断能否直接 seek）
    let blobMode = null;          // 已渲染音频对应的播放方式（柱式/分解/单音）
    let seeking = false;          // seek 期间不要因 pause 事件清掉高亮

    // ---- 自动连播 ----
    //   一段播完 → 停约 AUTO_CONTINUE_GAP_MS → 自动生成新的一段接着播，无限接力。
    //   接力用「代数」判定是否还有效：任何让当前播放作废的动作（停止 / 手动播放 /
    //   换一段 / 点小节 / 改速度 / 切视图）都会把代数 +1，在途的接力发现代数变了就放弃。
    let autoTimer = null;         // 段间停顿定时器
    let autoBreak = 0;            // 打断代数：用户动手就 +1
    let autoRunning = false;      // 接力自身执行中（此期间的 stop 不算"用户打断"）

    // 段间停顿：从"上一段结束"算起，隔这么久去生成下一段。
    //   实际静音时长 = 这个值 + 生成/渲染耗时。实测（8 小节 / 四部和声 / 柱式）：
    //   1050 → 静音约 1.5 秒（渲染额外吃掉约 0.45 秒）。16 小节或分解和弦渲染更久，
    //   静音会到 1.8 秒左右。听着觉得太长/太短，就改这一个数。
    const AUTO_CONTINUE_GAP_MS = 1050;
    const autoStats = { chains: 0, lastEndedAt: 0 };   // 自测用：接力了几次

    // ---- 底部迷你播放器（手持练习用）----
    //   收起 = 一颗胶囊（只有「换一段」）；展开 = 铺满一屏的练习界面。
    //   它和音频是**解耦**的：mpMeasure 是"面板上正在看的小节"，
    //   暂停后依然保留（页面上那条高亮会被清掉，但面板还停在原处，方便作答）。
    let mpMeasure = 0;            // 面板当前**显示**的小节（冻结时停在冻结点）
    let mpLiveMeasure = 0;        // 实时小节：永远跟随播放（冻结期间照常更新）
    // ★ 第十六轮：暂停态用「上一个 / 下一个」切过和弦之后，下次按播放键要**从这个新小节起播**。
    //   记的就是"待重定位到的小节"，-1 = 没有待重定位（正常原地续播）。
    let mpPauseJumpTo = -1;
    let mpExpanded = false;       // 展开中？
    let mpRevealing = false;      // 是否处于"按住揭示"（默认遮住，按住才显示）
    let mpFreeze = null;          // 长按那一刻的冻结快照（null = 未冻结）
    let mpSeg = 0;                // 段落代数：doGenerate 时 +1（防止冻结跨段串号）
    let mpGesture = null;         // 长按手势记录（null = 无手势）
    let mpReports = [];           // 报错明细（内存，上限 MP_REPORTS_MAX；聚合统计另有持久化）
    let mpErrorCtx = null;        // 报错浮窗那一刻的快照，防作答时小节已漂移
    // 「换一段」之后要不要顺手接着播？迷你播放器的定位是连续刷题 → 默认接着播。
    // 想让它跟页面上那颗「下一首」一样"只生成不播"，把这个常量改成 false 即可。
    const MP_AUTOPLAY_AFTER_GENERATE = true;

    // ---- 长按手势的旋钮（手感全靠这几个数）----
    const MP_HOLD_MS = 160;       // 按住多久算"长按"（到点才揭示答案，防误触剧透）
    const MP_SLOP_PX = 12;        // 长按阈值到达前的容差：超过就当成滑动/误触，取消本次
    const MP_DOWN_PX = 56;        // 按住之后往下滑多少算"要听辩辅助"（2026-10-07 与上滑对调）
    const MP_UP_PX = 56;          // 按住之后往上滑多少算"要报错"（与下滑对称）
    // 水平方向只有一个轴：左右互通 —— 台阶锚点跟着"最后停下的位置"走，
    //   所以左滑几格之后不用把手指拉回原位，相对当前停留点再右滑够一格就是前进。
    //   垂直方向相反：一旦判成上下就锁死，不再切水平（上下各自是一次性动作）。
    const MP_STEP_PX = 48;        // 每滑过这么多算走一格（往左退一个 / 往右进一个）
    const MP_REPORTS_MAX = 500;   // 内存里留存的明细上限

    // ---- 进度轮询（高亮 + 锁屏封面跟随）----
    let progressRaf = 0;          // requestAnimationFrame 句柄
    let lastPosPush = 0;          // 上次推锁屏进度的时刻（setPositionState 限流用）

    let els = null;

    function cacheEls() {
        els = {
            length: document.getElementById('chord-length'),
            tempo: document.getElementById('chord-tempo'),
            tempoVal: document.getElementById('chord-tempo-val'),
            voicingMode: document.getElementById('chord-voicing-mode'),
            // 播放方式改成了连体椭圆滑块（原 generate / play / playArp / playBass / stop 五个键已删）
            playSeg: document.getElementById('chord-play-seg'),
            // 按住卡片显示什么：两档连体椭圆滑块（roman / bass）
            revealSeg: document.getElementById('chord-reveal-seg'),
            // 强调低音：滑块 + 右侧读数
            bassEmph: document.getElementById('chord-bass-emph'),
            bassEmphVal: document.getElementById('chord-bass-emph-val'),
            // 两颗椭圆开关（都是 button[role=switch]，不是 checkbox —— 用户 2026-10-06 拍板）
            autoContinue: document.getElementById('chord-auto-continue'),
            portable: document.getElementById('chord-portable'),
            grid: document.getElementById('degree-grid'),
            inversion: document.getElementById('chord-inversion'),
            secondInv: document.getElementById('chord-second-inv'),
            adaptive: document.getElementById('chord-adaptive'),
            info: document.getElementById('chord-info'),
            renderInfo: document.getElementById('chord-render-info'),
            hint: document.getElementById('chord-key-hint'),
            sheetMusic: document.getElementById('chord-sheet-music'),
            // ---- 底部迷你播放器 ----
            mp: document.getElementById('chord-mp'),
            mpBar: document.getElementById('chord-mp-bar'),
            mpExpand: document.getElementById('chord-mp-expand'),
            mpPlayPauseMin: document.getElementById('chord-mp-playpause-min'),
            mpRingBar: document.getElementById('chord-mp-ring-bar'),
            mpGenerateMin: document.getElementById('chord-mp-generate-min'),
            mpSheet: document.getElementById('chord-mp-sheet'),
            mpClose: document.getElementById('chord-mp-close'),
            mpPlayPause: document.getElementById('chord-mp-playpause'),
            mpSheetToggle: document.getElementById('chord-mp-sheet-toggle'),
            mpStage: document.getElementById('chord-mp-stage'),
            mpSheetPage: document.getElementById('chord-mp-sheet-page'),
            mpCover: document.getElementById('chord-mp-cover'),
            mpCoverHidden: document.getElementById('chord-mp-cover-hidden'),
            mpPrev: document.getElementById('chord-mp-prev'),
            mpNext: document.getElementById('chord-mp-next'),
            mpGenerate: document.getElementById('chord-mp-generate'),
            mpExitPractice: document.getElementById('chord-mp-exit-practice'),
            mpHint: document.getElementById('chord-mp-hint'),
            mpError: document.getElementById('chord-mp-error'),
            mpErrorGrid: document.getElementById('chord-mp-error-grid'),
            mpErrorNone: document.getElementById('chord-mp-error-none'),
            mpAid: document.getElementById('chord-mp-aid'),
            mpAidBlock: document.getElementById('chord-mp-aid-block'),
            mpAidTones: document.getElementById('chord-mp-aid-tones'),
            // ---- 数据库页（听辨统计）----
            dbMatrix: document.getElementById('db-matrix'),
            dbTop: document.getElementById('db-top'),
            dbCombos: document.getElementById('db-combos'),
            dbTotalWrong: document.getElementById('db-total-wrong'),
            dbTotalHeard: document.getElementById('db-total-heard'),
            dbWrongRate: document.getElementById('db-wrong-rate'),
            dbScopeAll: document.getElementById('db-scope-all'),
            dbScopeRound: document.getElementById('db-scope-round'),
            dbClearRound: document.getElementById('db-clear-round'),
            dbClearAll: document.getElementById('db-clear-all'),
            dbPractice: document.getElementById('db-practice'),
            dbPracticeStatus: document.getElementById('db-practice-status')
        };
    }

    function buildDegreeGrid() {
        if (!els.grid) return;
        els.grid.innerHTML = '';
        for (let d = 1; d <= 7; d++) {
            const card = document.createElement('div');
            card.className = 'degree-card';
            card.dataset.degree = String(d);

            const nameLabel = document.createElement('label');
            nameLabel.className = 'degree-name';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.role = 'pick';
            cb.dataset.degree = String(d);
            cb.checked = !!settings.degrees[d];
            cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--accent);';
            if (d === 1) { cb.checked = true; cb.disabled = true; }
            const span = document.createElement('span');
            span.textContent = DEGREE_CHOICES[d - 1];
            nameLabel.appendChild(cb);
            nameLabel.appendChild(span);

            const prob = document.createElement('input');
            prob.type = 'range';
            prob.className = 'degree-prob';
            prob.dataset.role = 'prob';
            prob.dataset.degree = String(d);
            prob.min = '0';
            prob.max = '100';
            prob.step = '5';
            prob.value = String(settings.seventhProb[d] || 0);

            const val = document.createElement('span');
            val.className = 'degree-prob-val';
            val.dataset.role = 'probVal';
            val.dataset.degree = String(d);
            val.textContent = (settings.seventhProb[d] || 0) + '%';

            const hint = document.createElement('span');
            hint.className = 'degree-hint';
            hint.textContent = '七和弦概率';

            card.appendChild(nameLabel);
            card.appendChild(prob);
            card.appendChild(val);
            card.appendChild(hint);
            els.grid.appendChild(card);

            syncCard(d);
        }
    }

    function syncCard(d) {
        if (!els.grid) return;
        const card = els.grid.querySelector(`.degree-card[data-degree="${d}"]`);
        if (card) card.classList.toggle('off', !settings.degrees[d] && d !== 1);
    }

    function renderInfoText(text, isError) {
        if (!els.info) return;
        els.info.textContent = text;
        els.info.style.color = isError ? '#c0392b' : '';
    }

    // 高亮某一小节（-1 = 清除）。矩形是 SVG 逻辑坐标，直接改 fill-opacity 即可。
    //
    //   ★ 这里只管**页面上的高亮**。锁屏封面走的是另一条线（setCoverMeasure，
    //   可以带提前量），两者故意拆开 —— 见 ART_LEAD_MS 的说明。
    function setMeasureHighlight(m) {
        if (m === highlightedMeasure) return;
        const prev = highlightedMeasure;
        if (prev >= 0 && measureRects[prev]) {
            measureRects[prev].setAttribute('fill-opacity', '0');
        }
        highlightedMeasure = m;
        if (m >= 0 && measureRects[m]) {
            measureRects[m].setAttribute('fill-opacity', HL_OP);
            // 播放器里的谱表页展开时，让当前小节自动滚进视野（克制：仅在小节变化时触发）
            if (mpStageView === 'sheet' && mpExpanded && els && els.mpSheetPage) {
                const scroller = els.mpSheetPage;
                const r = measureRects[m].getBoundingClientRect();
                const box = scroller.getBoundingClientRect();
                if (r.top < box.top + 24 || r.bottom > box.bottom - 24) {
                    measureRects[m].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            }
        }
        // 统计口径：**上一小节"完整播完"才算听过**。
        //   条件是"连续前进一格 + 没在 seek + 真的在播"—— 点小节跳转 / 拖进度条 /
        //   暂停续播都会破坏连续性，所以不会被误计（详见 recordHeard 的注释）。
        if (prev >= 0 && m === prev + 1 && !seeking
            && chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended) {
            recordHeard(prev);
        }
        // 迷你播放器（展开着的那张级数大图）跟着走
        if (m >= 0) mpOnMeasure(m);
    }

    // 每小节的时长（秒）：一小节 4 拍
    function measureDuration() {
        return 4 * (60 / settings.tempo);
    }

    // ------------------------------------------------------------
    // 进度跟随（高亮 + 锁屏封面）
    //
    //   用 requestAnimationFrame 每帧问一次"现在第几小节"：小节切换点能抓到 16ms 精度，
    //   锁屏封面基本是踩着拍子换的。
    //   原先只挂 timeupdate（浏览器约 4 次/秒 = 250ms 一跳），平均要慢 ~125ms、
    //   最坏 ~250ms 才换封面 —— 用户实测到的"慢 200ms 左右"就是它。
    //
    //   timeupdate 保留作兜底：后台标签页里 rAF 会被浏览器停掉，那时靠它继续推。
    //
    //   两条线的分工（注意别把哪个改回去了）：
    //     页面高亮  = 精确 currentTime
    //     锁屏封面  = currentTime + ART_LEAD_MS（提前一点推，补系统的换图开销）
    // ------------------------------------------------------------
    function updateProgress(force) {
        if (!data || !chordAudioEl) return;
        // ★ 第十六轮：暂停态用「上一个/下一个」手动切过和弦 → 面板位置由用户说了算，
        //   别让这条按 currentTime 的回调把显示拉回暂停点（那会让"切过去又自己跳回来"）。
        if (mpPauseJumpTo >= 0 && !mpIsPlaying()) return;
        const dur = measureDuration();
        const last = data.chords.length - 1;
        // 页面高亮：精确跟随（不提前）
        const m = Math.min(last, Math.floor(chordAudioEl.currentTime / dur));
        setMeasureHighlight(m);
        // 锁屏封面：带一点提前量（见 ART_LEAD_MS），把系统侧那几十毫秒的滞后补回来
        const mc = Math.min(last, Math.floor((chordAudioEl.currentTime + coverLeadSeconds()) / dur));
        setCoverMeasure(mc);
        // 收起条播放键的外圈进度：每帧重画一次 —— 它是连续值（currentTime / 整段时长），
        //   所以看起来是"无极挪动"。不重画的话它会停在小节边界上（用户 2026-10-06 反馈）。
        mpPaintProgress();
        // 锁屏进度条（可拖动）也要跟着走。但没必要每秒推 60 次，限流到 4 次/秒。
        const now = Date.now();
        if (force || now - lastPosPush >= 250) {
            lastPosPush = now;
            const host = global.ChordHost;
            if (host && host.updateMediaPosition) host.updateMediaPosition(chordAudioEl);
        }
    }

    function progressLoop() {
        progressRaf = 0;
        if (!chordAudioEl || chordAudioEl.paused || chordAudioEl.ended) return;
        updateProgress(false);
        progressRaf = requestAnimationFrame(progressLoop);
    }

    function startProgressLoop() {
        if (progressRaf) return;
        lastPosPush = 0;
        progressRaf = requestAnimationFrame(progressLoop);
    }

    function stopProgressLoop() {
        if (progressRaf) {
            cancelAnimationFrame(progressRaf);
            progressRaf = 0;
        }
    }

    // ------------------------------------------------------------
    // 自动连播：一段播完 → 停一下 → 自动换新的一段接着播，无限接力
    // ------------------------------------------------------------

    // 作废所有在途的接力（定时器 / 尚未开播的那一步）。
    //   接力用"代数"判定有效性：这里 +1，在途的接力发现代数变了就放弃自己。
    function cancelAutoNext() {
        autoBreak++;
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }

    // 一段播完时调用。注意退出条件：用户可能在这段时间里动手（取消勾选 / 按停止 /
    // 手动播放 / 点小节 / 切视图），那些动作都会把 autoBreak +1 → 这里就放弃接力。
    function scheduleAutoNext() {
        if (practiceMode) return;    // 错题练习播完即停：自动连播会生成普通题混入统计口径
        if (!settings.autoContinue) return;
        cancelAutoNext();                        // 清掉可能残留的上一次接力（同时抬高代数）
        const brk = autoBreak;
        showAutoInfo('连续播放：马上换新的一段…', 'i-repeat');
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (brk !== autoBreak) return;
            if (!settings.autoContinue || isRendering || !data) return;
            autoAdvance(brk);
        }, AUTO_CONTINUE_GAP_MS);
    }

    // 换新的一段并接着播。
    //   doGenerate 内部会走 stopChordPlayback —— 那是"接力自己引起的停止"，
    //   不该把接力掐死，所以整段用 autoRunning 罩住。
    async function autoAdvance(brk) {
        const mode = lastPlayMode || 'block';
        autoRunning = true;
        try {
            await doGenerate(true);
        } finally {
            autoRunning = false;
        }
        if (brk !== autoBreak || !settings.autoContinue) return;
        autoStats.chains++;
        await doPlay(mode, 0, true);
    }

    function showAutoInfo(text, iconId) {
        if (!els.renderInfo) return;
        els.renderInfo.style.display = 'block';
        if (iconId) els.renderInfo.innerHTML = iconSvg(iconId) + text;
        else els.renderInfo.textContent = text;
    }

    function bindAudioProgress() {
        if (!chordAudioEl || chordAudioEl.__crBound) return;
        chordAudioEl.__crBound = true;

        // 谁在播谁就是活跃元素：和弦页一开播，锁屏按钮（含上一首/下一首=上/下一小节）
        // 就切到它身上；视唱页一开播又会切回去。这样两边永远不打架。
        chordAudioEl.addEventListener('play', () => {
            const host = global.ChordHost;
            if (host && host.reclaimMedia) host.reclaimMedia(chordAudioEl, chordMediaHooks);
            if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
            startProgressLoop();     // 每帧跟随（timeupdate 太粗，封面会慢半拍）
            mpSyncPlayIcon();
        });

        // 兜底：后台标签页 rAF 被停掉时，靠 timeupdate 继续推（粗一点但不断）
        chordAudioEl.addEventListener('timeupdate', () => updateProgress(false));

        chordAudioEl.addEventListener('loadedmetadata', () => {
            const host = global.ChordHost;
            if (host && host.updateMediaPosition) host.updateMediaPosition(chordAudioEl);
        });

        chordAudioEl.addEventListener('ended', () => {
            stopProgressLoop();
            // ★ 只有"整段真实音频"播完才算一段结束。
            //   渲染期间用来解锁 <audio> 的静音占位 WAV 也会触发 ended —— 那种不算，
            //   否则每次播放都会顺手多生成一段。
            const isRealAudio = !!(blobUrl && chordAudioEl.getAttribute('src') === blobUrl);
            const realEnd = isRealAudio && !isRendering;
            // 统计：整段的最后一小节等不到"下一格"来触发 recordHeard，这里补记一次
            if (realEnd && highlightedMeasure >= 0) recordHeard(highlightedMeasure);
            setMeasureHighlight(-1);
            if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'none';
            }
            mpSyncPlayIcon();
            if (realEnd) {
                autoStats.lastEndedAt = Date.now();
                scheduleAutoNext();
            }
        });

        chordAudioEl.addEventListener('pause', () => {
            stopProgressLoop();
            if (!seeking) setMeasureHighlight(-1);   // seek 过程中会短暂 pause，别清高亮
            if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
            mpSyncPlayIcon();
        });
    }

    function stopChordPlayback() {
        // 接力自己引起的"停止"不算用户打断，否则接力会把自己掐死。
        if (!autoRunning) cancelAutoNext();
        if (chordAudioEl) {
            try { chordAudioEl.pause(); } catch (e) {}
        }
        stopProgressLoop();
        setMeasureHighlight(-1);
    }

    // 速度 / 连奏一改，之前渲染好的整段 WAV 就"过期"了：
    //   它的总时长、以及"每小节 = 4 拍 × 60/BPM"这个换算都对不上了，
    //   继续拿它 seek 会跳错位置。所以干脆作废：停止播放 + 等下次点播放键重渲染。
    function invalidateRenderedAudio(hintText) {
        stopChordPlayback();
        blobData = null;
        blobMode = null;
        if (hintText && els.renderInfo) {
            els.renderInfo.style.display = 'block';
            els.renderInfo.textContent = hintText;
        }
    }

    // 三种播放方式：柱式（一拍一下）/ 分解（一拍四音，低→高滚动）/ 单音（每小节只弹最低音，长音）
    const PLAY_MODES = { block: '柱式', arpeggio: '分解和弦', bass: '单音' };

    // ------------------------------------------------------------
    // 锁屏 / 控制中心封面：把"当前这一小节的和弦级数"画成图，随播放实时更换
    //
    //   iOS 锁屏、macOS 控制中心读的都是 MediaSession 的 metadata（标题 + 封面）。
    //   整页只有一个媒体会话，由 index.html 里的中枢统一管（走 ChordHost），
    //   这里只负责"画封面"和"把当前小节推过去"。
    //
    //   两个尺寸都要给：
    //     96×96   —— 锁屏上那张小卡片（只给大图的话，Safari 在小卡片里会显示灰块）
    //     512×512 —— 点开后的全屏播放器
    //   图用 canvas 现画 → toBlob → blob URL。每小节一张**独立的** URL，
    //   系统因此一定能判定"封面变了"，不会因为 URL 相同而拿缓存不刷新。
    // ------------------------------------------------------------
    const ART_SIZES = [512, 96];
    const ART_COMPACT_MAX = 128;   // <= 这个尺寸只画级数大字，别的内容缩到 96px 就是一团糊

    // 按级数配色（浅底深字；换级数就换颜色，扫一眼就知道功能变了）
    //
    //   ★ 这是**全站唯一**的色板：锁屏封面、面板里的级数大图、报错浮窗的色块
    //     全都从这里取色。改这一处，三处一起变 —— 别再在别处硬编码颜色。
    //   ★ 当前是一轮"轮转"：Ⅴ 拿 Ⅰ 的黄、Ⅲ 拿 Ⅴ 的红、Ⅳ 拿 Ⅲ 的蓝、Ⅰ 拿 Ⅳ 的绿，
    //     四个都换了色而且互不撞色；Ⅱ / Ⅵ / Ⅶ 不动。
    const ART_PALETTE = [
        { top: '#eefbf4', bottom: '#d2f6e2', ink: '#08724f', sub: '#208a66' },  // Ⅰ 主（原 Ⅳ 的绿）
        { top: '#f6f4ff', bottom: '#e6e1ff', ink: '#4633a5', sub: '#6b5cc0' },  // Ⅱ
        { top: '#fff3f2', bottom: '#ffe0dd', ink: '#b21f1f', sub: '#c85450' },  // Ⅲ（原 Ⅴ 的红）
        { top: '#f0f6ff', bottom: '#dce9ff', ink: '#1c4fd0', sub: '#3d6ed2' },  // Ⅳ 下属（原 Ⅲ 的蓝）
        { top: '#fff8ef', bottom: '#ffe8cf', ink: '#8a4a10', sub: '#a9762f' },  // Ⅴ 属（原 Ⅰ 的黄）
        { top: '#fdf4ff', bottom: '#f4e6ff', ink: '#83178f', sub: '#a144a6' },  // Ⅵ
        { top: '#f7f9fc', bottom: '#e3e9f1', ink: '#2f3d4f', sub: '#5a6b80' }   // Ⅶ
    ];

    const ART_SERIF = '"Songti SC", "STSong", "Times New Roman", Georgia, serif';
    const ART_SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif';

    // 「按住卡片只显示低音级数」那一档专用底色：**故意不放进 ART_PALETTE**。
    //   ART_PALETTE[6]（Ⅶ）是冷蓝灰 #f7f9fc→#e3e9f1，跟灰阶太接近 —— 若不换成真中性灰，
    //   遮住之后光看底色就能猜出"这不是 Ⅶ 就是没级数"，等于没遮干净。这里是去色相的中性灰。
    const COVER_NEUTRAL = { top: '#f4f4f5', bottom: '#e2e4e9', ink: '#3f4854' };

    let artCache = [];     // 小节索引 -> MediaMetadata.artwork 数组
    let artUrls = [];      // 已生成的全部 blob URL（换一段时统一回收）
    let artImages = [];    // 已"读进内存并解码"的图。钉住引用，保证系统取图时命中暖缓存
    let pendingArtPush = -1;   // 想推但封面还没画好的小节号，画好后补推（见 updateNowPlaying）

    // 换一段时，旧封面不再立刻回收，而是延后这么久再 revoke。
    //   原因：换段那一刻，锁屏上正显示的还是上一代的图；立刻 revoke 会让系统读到一个
    //   已失效的 URL → 封面空白一闪。延后到新封面顶上之后再回收，任一时刻最多两代共存。
    const ART_RELEASE_DELAY_MS = 2500;

    // ------------------------------------------------------------
    // 封面「提前量」
    //
    //   封面推送的**时机**已经是逐帧精确的（rAF，见 updateProgress），页面高亮与声音
    //   基本踩在同一个点上。但"推给系统"到"锁屏上真的看见换了"之间还有一段系统开销
    //   （另一个进程取图 + 解码 + 系统自己的换图过渡），体感上封面仍比声音慢半拍。
    //   这段开销在页面侧消不掉，只能反过来：**把封面提前一点推**。
    //
    //   做法是把"页面高亮用的小节号"和"锁屏封面用的小节号"拆成两个：
    //     页面高亮：按 currentTime 精确算（不提前）
    //     锁屏封面：按 currentTime + ART_LEAD_MS 算（提前）
    //   调 0 = 关掉提前量（回到"和声音同时换"）。
    //   听着觉得封面比声音早/晚，就改这一个数。
    // ------------------------------------------------------------
    let ART_LEAD_MS = 70;
    let coverMeasure = -1;        // 锁屏封面当前是第几小节（与页面高亮 highlightedMeasure 解耦）

    // 提前量护栏：绝不提前超过半小节（否则会早跳一整小节，明显抢拍）。
    function coverLeadSeconds() {
        const half = measureDuration() * 0.5;
        const lead = ART_LEAD_MS / 1000;
        return Math.max(0, Math.min(lead, half));
    }

    // 换封面（-1 不动手：保持锁屏上最后一张，避免把封面清成空）
    function setCoverMeasure(m) {
        if (m === coverMeasure) return;
        coverMeasure = m;
        if (m >= 0) updateNowPlaying(m);
    }

    function artSupported() {
        return typeof document !== 'undefined'
            && typeof navigator !== 'undefined'
            && 'mediaSession' in navigator
            && typeof global.MediaMetadata === 'function';
    }

    // 罗马数字拆成「基号 + 上标 + 下标」三段，方便在封面上按教科书的样子排。
    //   直接把 Unicode 的 ⁿ / ₙ 当正文画，字号跟着基号走就会小得看不清，
    //   所以拆开、自己控字号与位置（见 drawCover）。
    function romanParts(degree, seventh, inversion) {
        const base = ROMAN_MAJOR[degree - 1] || '';
        if (!seventh) {
            if (inversion === 1) return { base, sup: '6', sub: '' };
            if (inversion === 2) return { base, sup: '6', sub: '4' };
            return { base, sup: '', sub: '' };
        }
        if (inversion === 1) return { base, sup: '6', sub: '5' };
        if (inversion === 2) return { base, sup: '4', sub: '3' };
        if (inversion === 3) return { base, sup: '4', sub: '2' };
        return { base, sup: '7', sub: '' };
    }

    // 画一张方形封面。compact = true 时只留级数基号（96px 的缩略图上别的都是糊的）。
    //
    //   opts（可选，**不传 = 与以前逐字节一致**）：
    //     { bassOnly: true } = 设置页「按住卡片显示的内容 → 低音级数」那一档：
    //        底色换中性灰，只画大号简谱数字 + 左上角"第几小节"；
    //        罗马数字（含转位）、和弦音名、调性底行**全跳过**。
    //   ★ 锁屏封面走 coverBlobUrl → drawCover(不带 opts)，所以恒为罗马数字那档。
    function drawCover(g, size, info, compact, opts) {
        const bassOnly = !!(opts && opts.bassOnly);
        const pal = bassOnly ? COVER_NEUTRAL : ART_PALETTE[(info.degree - 1) % ART_PALETTE.length];
        const grad = g.createLinearGradient(0, 0, 0, size);
        grad.addColorStop(0, pal.top);
        grad.addColorStop(1, pal.bottom);
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);

        // ---------------- 低音级数档 ----------------
        if (bassOnly) {
            const txt = (info.bassDegree == null || info.bassDegree === '') ? '?' : String(info.bassDegree);
            const maxW = size * 0.66;
            let bfs = size * 0.62;
            while (bfs > size * 0.16) {
                g.font = '700 ' + bfs + 'px ' + ART_SERIF;
                if (g.measureText(txt).width <= maxW) break;
                bfs -= size * 0.02;
            }
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillStyle = COVER_NEUTRAL.ink;
            g.font = '700 ' + bfs + 'px ' + ART_SERIF;
            g.fillText(txt, size / 2, size * 0.5);

            // 左上角：听到第几小节了（位置 / 字号与原档完全一致，两档切换时它不跳）
            g.textAlign = 'left';
            g.globalAlpha = 0.85;
            g.font = '600 ' + (size * 0.06) + 'px ' + ART_SANS;
            g.fillText(info.pos, size * 0.065, size * 0.088);
            g.globalAlpha = 1;
            return;
        }

        // 中央罗马数字：基号大字，转位数字排在基号右侧的右上 / 右下角
        const parts = compact ? { base: info.base, sup: '', sub: '' } : info.parts;
        const figRatio = 0.42;                 // 转位数字相对基号的字号比
        const widthAt = (px) => {
            g.font = '700 ' + px + 'px ' + ART_SERIF;
            let w = g.measureText(parts.base).width;
            if (parts.sup || parts.sub) {
                g.font = '700 ' + (px * figRatio) + 'px ' + ART_SERIF;
                w += Math.max(
                    parts.sup ? g.measureText(parts.sup).width : 0,
                    parts.sub ? g.measureText(parts.sub).width : 0
                );
            }
            return w;
        };
        const maxW = size * 0.86;
        let fs = size * (compact ? 0.68 : 0.5);
        while (fs > size * 0.16 && widthAt(fs) > maxW) fs -= size * 0.02;

        const cy = compact ? size * 0.5 : size * 0.435;
        const x0 = (size - widthAt(fs)) / 2;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillStyle = pal.ink;
        g.font = '700 ' + fs + 'px ' + ART_SERIF;
        g.fillText(parts.base, x0, cy);
        if (parts.sup || parts.sub) {
            const wb = g.measureText(parts.base).width;
            g.font = '700 ' + (fs * figRatio) + 'px ' + ART_SERIF;
            if (parts.sup) g.fillText(parts.sup, x0 + wb, cy - fs * 0.30);
            if (parts.sub) g.fillText(parts.sub, x0 + wb, cy + fs * 0.28);
        }

        if (compact) return;

        // 和弦音名
        g.textAlign = 'center';
        g.font = '500 ' + (size * 0.082) + 'px ' + ART_SANS;
        g.fillStyle = pal.sub;
        g.fillText(info.tones, size / 2, size * 0.715);

        // 底行：调性 · 配声
        g.font = '400 ' + (size * 0.056) + 'px ' + ART_SANS;
        g.fillText(info.footer, size / 2, size * 0.842);

        // 左上角：听到第几小节了
        g.textAlign = 'left';
        g.globalAlpha = 0.85;
        g.font = '600 ' + (size * 0.06) + 'px ' + ART_SANS;
        g.fillText(info.pos, size * 0.065, size * 0.088);
        g.globalAlpha = 1;
    }

    // 一张 canvas → PNG blob URL（拿不到就返回 null，不抛）
    //
    //   ★ 关键：拿到 URL 之后必须**立刻把它当图片读一遍并解码**（img.decode()）。
    //   只 createObjectURL 不读，等于把"取 blob + PNG 解码"那几十毫秒推迟到系统真正要
    //   显示封面的那一刻 —— 那段时间锁屏上就是空白，也就是用户看到的"闪一下"。
    //   先解码进图像缓存再交给 MediaSession，换图瞬间就能命中暖副本。
    function coverBlobUrl(size, info, compact) {
        // 记下本次生成所属的那一批（与 releaseChordArtwork 的延后回收集合同一份引用）
        const urlBucket = artUrls;
        const imgBucket = artImages;
        return new Promise((resolve) => {
            try {
                const cv = document.createElement('canvas');
                cv.width = size;
                cv.height = size;
                drawCover(cv.getContext('2d'), size, info, compact);
                cv.toBlob((blob) => {
                    if (!blob) { resolve(null); return; }
                    const url = URL.createObjectURL(blob);
                    urlBucket.push(url);

                    const img = new Image();
                    let settled = false;
                    const done = () => {
                        if (settled) return;
                        settled = true;
                        imgBucket.push(img);   // 钉住引用：位图在被系统取走之前不能被回收
                        resolve(url);
                    };
                    img.src = url;
                    if (typeof img.decode === 'function') {
                        // decode() 真正解码一次；失败也照旧可用，不阻塞
                        img.decode().then(done, done);
                    } else {
                        img.onload = done;     // 老浏览器兜底
                        img.onerror = done;
                    }
                }, 'image/png');
            } catch (e) { resolve(null); }
        });
    }

    // 回收上一代封面图。注意是**延后**回收（见 ART_RELEASE_DELAY_MS 的说明）：
    //   立刻 revoke 会把锁屏上正在显示的那张图一起作废 → 换段时封面空白一闪。
    //   这里只是把"这一批"交给定时器，后面新生成的那批写进全新数组，互不影响。
    function releaseChordArtwork() {
        const oldUrls = artUrls;
        const oldImgs = artImages;
        artUrls = [];
        artImages = [];
        artCache = [];
        pendingArtPush = -1;           // 换了一批图，之前挂起的"补推"一并作废
        if (!oldUrls.length && !oldImgs.length) return;
        setTimeout(() => {
            for (let i = 0; i < oldUrls.length; i++) {
                try { URL.revokeObjectURL(oldUrls[i]); } catch (e) {}
            }
            oldUrls.length = 0;
            oldImgs.length = 0;        // 松开引用，解码位图才允许被回收
        }, ART_RELEASE_DELAY_MS);
    }

    // 第 m 小节"画封面要用到的全部信息"。抽出来是为了让**锁屏封面**和
    //   **页面迷你播放器里那张大图**用同一份数据、同一种画法，两边永远长一样。
    function buildCoverInfo(m) {
        if (!data || m < 0 || m >= data.chords.length) return null;
        const c = data.chords[m];
        const parts = romanParts(c.degree, c.seventh, c.inversion);
        // 「按住卡片只显示低音级数」那一档要用：这个和弦**低音**在调内的简谱数字。
        //   低音 = midis[0]（转位时就是那个转位音）。和弦音全来自调内音级 → 一定能在
        //   data.scale 里查到；真查不到（理论上不会）退回音名兜底，别把 'undefined' 画上屏。
        const bassPc = ((c.midis && c.midis.length ? c.midis[0] : 0) % 12 + 12) % 12;
        const bassScale = (data.scale || []).find((s) => s.pc === bassPc);
        const bassNote = (c.notes && c.notes.length) ? c.notes[0] : null;
        return {
            degree: c.degree,
            roman: c.roman,
            base: parts.base,
            parts: parts,
            tones: c.notes.map((n) => pitchName(n.letter, n.acc)).join('  '),
            footer: data.key + ' 大调 · ' + ((data.voicingMode === 'fourpart') ? '四部和声' : '三和弦'),
            pos: (m + 1) + ' / ' + data.chords.length,
            // 低音在调内的级数（简谱数字，字符串；查不到时是音名）
            bassDegree: bassScale ? String(bassScale.degree)
                : (bassNote ? pitchName(bassNote.letter, bassNote.acc) : '?')
        };
    }

    // 为整段和声预生成封面。生成完一段就做，播放时直接查表 → 切小节零延迟。
    function buildChordArtwork() {
        releaseChordArtwork();
        if (!artSupported() || !data || !data.chords.length) return;
        for (let m = 0; m < data.chords.length; m++) {
            const info = buildCoverInfo(m);
            if (!info) continue;
            const idx = m;
            Promise.all(ART_SIZES.map((s) => coverBlobUrl(s, info, s <= ART_COMPACT_MAX)))
                .then((urls) => {
                    const art = [];
                    for (let i = 0; i < ART_SIZES.length; i++) {
                        if (urls[i]) {
                            art.push({
                                src: urls[i],
                                sizes: ART_SIZES[i] + 'x' + ART_SIZES[i],
                                type: 'image/png'
                            });
                        }
                    }
                    if (art.length) artCache[idx] = art;
                    // 之前想推这一小节、但当时封面还没画好（例如刚进页面就点小节）
                    //   → 现在图就绪了，补推一次，免得锁屏一直停在上一张
                    if (pendingArtPush === idx && artCache[idx]) {
                        pendingArtPush = -1;
                        updateNowPlaying(idx);
                    }
                })
                .catch(() => {});
        }
    }

    // 把"当前第 m 小节"推给系统（锁屏 / 控制中心 / 灵动岛）。
    //   title 里也带级数 —— 万一某些系统版本不刷新封面，文字照样能告诉他答案。
    //
    //   ★ 封面还没画好时**不推**：推一个 artwork: [] 会把锁屏上已有的封面清成灰块，
    //   本身也是一次"闪"。这里记下来，等这一小节的图就绪后由 buildChordArtwork 补推。
    function updateNowPlaying(m) {
        if (!artSupported() || !data || m < 0 || m >= data.chords.length) return;
        const host = global.ChordHost;
        if (!host || typeof host.setNowPlaying !== 'function') return;
        const art = artCache[m];
        if (!art || !art.length) { pendingArtPush = m; return; }
        const c = data.chords[m];
        host.setNowPlaying({
            title: '第 ' + (m + 1) + ' 小节 · ' + c.roman,
            artist: data.key + ' 大调 · ' + ((data.voicingMode === 'fourpart') ? '四部和声' : '三和弦'),
            album: '和弦听辨',
            artwork: art
        });
    }

    // 锁屏的「上一首 / 下一首」对和弦页 = 上一小节 / 下一小节（点小节跳转的自然延伸）
    //   ★ 第十六轮：锁屏这两个键也是"前进/后退键"，所以暂停态下与页面按钮同一规则 ——
    //     只切 + 试听，不接着播。基准也统一成 mpMeasure（在播时才用 currentTime）。
    //   ★ 第十八轮：iOS 锁屏实际画出来的往往是系统自绘的「±10 秒」键（数字是它画的，改不了）。
    //     宿主席（index.html）已经把 seekbackward / seekforward 也注册下来并转发到这里，
    //     所以**按哪一对键都走这个 skip 钩子** = 切一个和弦，不会再落回"跳 10 秒"。
    const chordMediaHooks = {
        skip: (dir) => {
            if (!data || !chordAudioEl) return false;
            mpCancelGesture();              // 显式导航 = 手势结束（含解冻）
            const playing = mpIsPlaying();
            const cur = playing
                ? Math.max(0, Math.floor(chordAudioEl.currentTime / measureDuration()))
                : mpMeasure;
            const next = Math.min(data.chords.length - 1, Math.max(0, cur + dir));
            if (next === cur) return true;      // 已在头/尾，照样吃掉这次点击
            if (playing) { doPlay(lastPlayMode, next); return true; }
            mpShowMeasureOnly(next);
            mpPauseJumpTo = next;
            mpPreviewChord(next);
            return true;
        }
    };

    // 首屏还没生成 / 正在渲染 → 整组置灰（语义与原三个播放键的 disabled 一致）
    function setPlayButtonsEnabled(on) {
        if (els.playSeg) els.playSeg.classList.toggle('is-disabled', !on);
    }

    // 设置页那两颗椭圆开关（连续播放 / 随身听模式）的选中态。
    //   只写 aria-checked，外观全交给 CSS 的 [aria-checked="true"] —— 状态与样式不打架。
    function syncTogglePills() {
        if (!els) return;
        if (els.autoContinue) els.autoContinue.setAttribute('aria-checked', settings.autoContinue ? 'true' : 'false');
        if (els.portable) els.portable.setAttribute('aria-checked', settings.portable ? 'true' : 'false');
    }

    // 把滑块挪到「当前播放方式」那一项上。
    //   几何量两遍：首次调用时这块可能刚被 display 切出来，offsetWidth 还没稳。
    function updateSegActive() {
        if (!els || !els.playSeg) return;
        const opts = els.playSeg.querySelectorAll('.seg__opt');
        if (!opts.length) return;
        let active = null;
        for (let i = 0; i < opts.length; i++) {
            const on = (opts[i].dataset.mode === lastPlayMode);
            opts[i].classList.toggle('active', on);
            opts[i].setAttribute('aria-checked', on ? 'true' : 'false');
            if (on) active = opts[i];
        }
        const thumb = els.playSeg.querySelector('.seg__thumb');
        if (!active || !thumb) return;
        const place = () => {
            thumb.style.left = active.offsetLeft + 'px';
            thumb.style.width = active.offsetWidth + 'px';
        };
        place();
        requestAnimationFrame(place);
    }

    // 把滑块挪到「按住卡片显示的内容」那一项上（roman / bass）。
    //   与 updateSegActive 同款：两遍量几何，首帧 display 刚切出来时 offsetWidth 还不稳。
    function updateRevealSeg() {
        if (!els || !els.revealSeg) return;
        const opts = els.revealSeg.querySelectorAll('.seg__opt');
        if (!opts.length) return;
        const cur = (settings.revealMode === 'bass') ? 'bass' : 'roman';
        let active = null;
        for (let i = 0; i < opts.length; i++) {
            const on = (opts[i].dataset.reveal === cur);
            opts[i].classList.toggle('active', on);
            opts[i].setAttribute('aria-checked', on ? 'true' : 'false');
            if (on) active = opts[i];
        }
        const thumb = els.revealSeg.querySelector('.seg__thumb');
        if (!active || !thumb) return;
        const place = () => {
            thumb.style.left = active.offsetLeft + 'px';
            thumb.style.width = active.offsetWidth + 'px';
        };
        place();
        requestAnimationFrame(place);
    }

    function updateHint() {
        if (!els.hint || !data) return;
        if (practiceMode) {
            els.hint.textContent =
                `错题练习：${data.key} 大调 · ${data.chords.length} 小节 · ${settings.tempo} BPM · 正确率不计入统计`;
            return;
        }
        const invText = settings.allowInversion ? '开启转位（和弦间平稳连接）' : '全部原位';
        const modeText = (data.voicingMode === 'fourpart')
            ? '四部和声 · 大谱表'
            : '三和弦 · 单行谱';
        els.hint.textContent =
            `本段：${data.key} 大调 · ${data.chords.length} 小节 · ${settings.tempo} BPM · ${modeText} · ${invText}`;
    }

    async function doGenerate(auto) {
        stopChordPlayback();
        mpPauseJumpTo = -1;             // 换了新的一段 → "暂停态切过和弦"的待重定位作废
        // 错题练习：出题换成"错误组合 + Ⅰ 胶水"的固定序列（每次进入重洗一次顺序）
        data = practiceMode ? practiceProgression() : generateChordProgression(settings);
        renderChordSheet(data);
        updateHint();
        setPlayButtonsEnabled(true);
        // 换了一段 → 之前渲染的音频与高亮全部作废（不然点小节会跳到旧音频上）
        blobData = null;
        blobMode = null;
        highlightedMeasure = -1;
        coverMeasure = -1;              // 锁屏封面的"当前小节"也要复位（否则下一段第一小节会被判成"没变"）
        mpSeg++;                        // 段落代数 +1：冻结快照靠它判断"是不是已经跨到新一段了"
        // ★ 不要在这里直接改 mpMeasure —— 统一走 mpOnMeasure 这一个入口。
        //   它会在"用户正长按看答案"时只更新 mpLiveMeasure、不动显示，
        //   于是自动连播换段也不会把用户按住的那个答案换掉。
        mpOnMeasure(0);
        // 顺便把整段的锁屏封面画好（异步）。等用户点播放时早就绪了，切小节零延迟。
        buildChordArtwork();
        if (!auto) renderInfoText('已生成新的一段，点击“播放”');
        // 采样预加载（首次或缓存未命中时才会真正 fetch）
        try {
            const host = global.ChordHost;
            if (host) {
                await host.initAudio();
                const ok = await preloadChordSamples((t) => {
                    if (els.renderInfo) {
                        els.renderInfo.style.display = 'block';
                        els.renderInfo.textContent = t;
                    }
                });
                if (els.renderInfo) els.renderInfo.style.display = 'none';
                if (ok === 0) {
                    renderInfoText('未加载到钢琴采样：请用本地服务器（http://）打开页面，并确认 音源/和弦钢琴/ 已生成', true);
                }
            }
        } catch (e) {
            console.warn('采样预加载失败:', e);
        }
    }

    // mode：'block' 柱式 / 'arpeggio' 分解 / 'bass' 单音
    // fromMeasure：从第几小节开始（0 = 从头）。点谱面小节时传入该小节索引。
    // auto：true = 本次是"自动连播"接力发起的，不要当成用户操作去打断接力。
    async function doPlay(mode, fromMeasure, auto) {
        mode = mode || lastPlayMode || 'block';
        fromMeasure = fromMeasure || 0;
        mpPauseJumpTo = -1;             // 真开始播了 → 待重定位消费掉（避免下次按播放又跳一次）
        if (!data || !data.chords.length || isRendering) return;
        if (!auto) cancelAutoNext();   // 用户手动播放 / 点小节 → 作废在途的自动接力
        const host = global.ChordHost;
        if (!host) { renderInfoText('音频桥接不可用', true); return; }

        lastPlayMode = mode;   // 记住这次用的播放方式 —— 点谱面小节时会沿用它
        updateSegActive();     // 从播放器 / 锁屏发起的播放也要让页面上的滑块跟上

        // ★ 移动端必需：在用户手势内解锁音频上下文
        //   initAudio() 内部是同步的 → **不 await** 才能留在手势的同步栈里（await 一交出去，
        //   iOS 就可能拒绝这次 resume）。状态判断用 !== 'running'：iOS 除 'suspended' 之外
        //   还有 Safari 私有的 'interrupted'（主 <audio> 播放/暂停后常落到这个态），
        //   只认前者会一直不解锁 —— 主播放不受影响（它走 <audio>），但听辩辅助窗那声会哑。
        try {
            unlockAudioNow();
        } catch (e) {}

        // ★ 在用户手势内创建并解锁 <audio> 元素（后续复用）
        if (!chordAudioEl) {
            chordAudioEl = new Audio();
            bindAudioProgress();
        }
        const seekTo = fromMeasure * measureDuration();

        // ★ 若"这段音频"就是本次要的（同一份 data + 同一种播放方式）→ 直接设进度条时间，
        //   **不重新渲染**。（整段是离线渲染成的一个 WAV，所以点小节 = 给 currentTime 赋值。）
        //   注意必须同时比对模式：换了播放键就得重渲染（模式是烘进 WAV 里的）。
        if (blobData === data && blobMode === mode && blobUrl) {
            try {
                seeking = true;
                chordAudioEl.currentTime = seekTo;
                if (els.renderInfo) {
                    els.renderInfo.style.display = 'block';
                    els.renderInfo.textContent = '播放中（' + (PLAY_MODES[mode] || '柱式') + '）…';
                }
                await chordAudioEl.play();
                setMeasureHighlight(fromMeasure);
                setCoverMeasure(fromMeasure);   // 跳小节后封面立刻跟上，不等下一帧
            } catch (err) {
                renderInfoText('播放失败: ' + (err && err.message), true);
            } finally {
                seeking = false;
            }
            return;
        }

        const silentWav = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQk=';
        chordAudioEl.src = silentWav;
        chordAudioEl.play().catch(() => {});

        isRendering = true;
        setPlayButtonsEnabled(false);
        if (els.renderInfo) els.renderInfo.style.display = 'block';

        try {
            const wav = await renderChordAudio(data.chords, settings.tempo, (t) => {
                if (els.renderInfo) els.renderInfo.textContent = t;
            }, mode);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = URL.createObjectURL(wav);
            blobData = data;                 // 记住这段音频属于哪个 data，供后续 seek
            blobMode = mode;                 // 以及它是用哪种播放方式渲染的

            chordAudioEl.pause();
            chordAudioEl.src = blobUrl;
            seeking = true;
            try { chordAudioEl.currentTime = seekTo; } catch (e) {}
            if (els.renderInfo) {
                els.renderInfo.textContent = '播放中（' + (PLAY_MODES[mode] || '柱式') + '）…';
            }
            try {
                await chordAudioEl.play();
                setMeasureHighlight(fromMeasure);
                setCoverMeasure(fromMeasure);   // 跳小节后封面立刻跟上，不等下一帧
            } catch (err) {
                // 离线渲染耗时可能超出浏览器的自动播放时限 → NotAllowedError。
                // 这不是功能故障：用户再点一次刚才那个播放键即可（那一下是明确手势）。
                const tag = String(err && err.name) + String(err && err.message);
                if (/NotAllowed|not allowed/i.test(tag)) {
                    renderInfoText('浏览器拦截了自动播放，请再点一次刚才的播放键', true);
                } else {
                    renderInfoText('播放失败: ' + (err && err.message), true);
                }
            } finally {
                seeking = false;
            }
        } catch (e) {
            console.error('和弦渲染失败:', e);
            renderInfoText('渲染失败: ' + e.message, true);
        } finally {
            isRendering = false;
            setPlayButtonsEnabled(true);
        }
    }

    function bindUI() {
        if (els.length) {
            els.length.value = String(settings.length);
            els.length.addEventListener('change', (e) => {
                settings.length = parseInt(e.target.value, 10);
                saveSettings();
                doGenerate(true);
            });
        }

        if (els.voicingMode) {
            els.voicingMode.value = (settings.voicingMode === 'triad') ? 'triad' : 'fourpart';
            els.voicingMode.addEventListener('change', (e) => {
                settings.voicingMode = (e.target.value === 'triad') ? 'triad' : 'fourpart';
                saveSettings();
                doGenerate(true);
            });
        }

        if (els.tempo) {
            els.tempo.value = String(settings.tempo);
            if (els.tempoVal) els.tempoVal.textContent = String(settings.tempo);
            els.tempo.addEventListener('input', (e) => {
                settings.tempo = parseInt(e.target.value, 10);
                if (els.tempoVal) els.tempoVal.textContent = String(settings.tempo);
                saveSettings();
                updateHint();
                invalidateRenderedAudio('速度已改为 ' + settings.tempo + ' BPM，点播放键重新渲染');
            });
        }

        // 强调低音（0..100）。拖动中只改读数（不重渲染 —— 每动一格渲染一次会卡）；
        //   松手（change）才落盘，并按"在播就地重渲染续播 / 没播作废待播"处理。
        //   音频是**离线渲染**好的成品，改任何音量参数都必须重渲染才听得出来。
        if (els.bassEmph) {
            els.bassEmph.value = String(settings.bassEmphasis);
            if (els.bassEmphVal) els.bassEmphVal.textContent = String(settings.bassEmphasis);
            const readEmph = (e) => {
                settings.bassEmphasis = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                if (els.bassEmphVal) els.bassEmphVal.textContent = String(settings.bassEmphasis);
            };
            els.bassEmph.addEventListener('input', readEmph);
            els.bassEmph.addEventListener('change', (e) => {
                readEmph(e);
                saveSettings();
                if (mpIsPlaying()) {
                    const at = Math.max(0, Math.floor(chordAudioEl.currentTime / measureDuration()));
                    doPlay(lastPlayMode, at);
                } else {
                    invalidateRenderedAudio('强调低音已改为 ' + settings.bassEmphasis + '%，点播放键用新设置重新渲染');
                }
            });
        }

        if (els.inversion) {
            els.inversion.checked = settings.allowInversion;
            els.inversion.addEventListener('change', (e) => {
                settings.allowInversion = e.target.checked;
                saveSettings();
                syncSecondInvState();
                doGenerate(true);
            });
        }

        // 6₄（四六和弦）开关：默认关（不出现）。只在开启转位时才有实际效果。
        function syncSecondInvState() {
            if (!els.secondInv) return;
            const usable = settings.allowInversion;
            els.secondInv.disabled = !usable;
            const wrap = els.secondInv.closest('.control-group');
            if (wrap) wrap.style.opacity = usable ? '' : '0.45';
        }

        if (els.secondInv) {
            els.secondInv.checked = settings.allowSecondInv;
            els.secondInv.addEventListener('change', (e) => {
                settings.allowSecondInv = e.target.checked;
                saveSettings();
                doGenerate(true);
            });
        }
        syncSecondInvState();

        // 「使用用户数据优化题库」：按历史错误率给级数加权（默认关）。
        //   只影响"下一次生成"，所以改完直接 doGenerate 让新设置立刻见效。
        if (els.adaptive) {
            els.adaptive.checked = !!settings.adaptiveFromStats;
            els.adaptive.addEventListener('change', (e) => {
                settings.adaptiveFromStats = e.target.checked;
                saveSettings();
                doGenerate(true);
            });
        }

        if (els.grid) {
            els.grid.addEventListener('change', (e) => {
                const t = e.target;
                if (t.dataset.role !== 'pick') return;
                const d = parseInt(t.dataset.degree, 10);
                settings.degrees[d] = t.checked;
                syncCard(d);
                saveSettings();
            });
            els.grid.addEventListener('input', (e) => {
                const t = e.target;
                if (t.dataset.role !== 'prob') return;
                const d = parseInt(t.dataset.degree, 10);
                settings.seventhProb[d] = parseInt(t.value, 10);
                const val = els.grid.querySelector(`[data-role="probVal"][data-degree="${d}"]`);
                if (val) val.textContent = t.value + '%';
                saveSettings();
            });
        }

        // 播放方式（连体椭圆滑块）：点一项 = 切成该方式 + 把当前这段按该方式重放一遍
        if (els.playSeg) {
            els.playSeg.addEventListener('click', (e) => {
                const opt = e.target.closest ? e.target.closest('.seg__opt') : null;
                if (!opt || !opt.dataset.mode) return;
                if (els.playSeg.classList.contains('is-disabled')) return;
                lastPlayMode = opt.dataset.mode;
                updateSegActive();
                doPlay(lastPlayMode, 0);
            });
            updateSegActive();
        }

        // 按住卡片显示什么（连体椭圆滑块，两档）：只改"画什么"，
        //   ★ 不重放声音、不作废已渲染的音频（用户在听的时候切换不该被打断）。
        //   按住卡片时如果面板正开着 → 立刻按新档重画一次，所见即所得。
        if (els.revealSeg) {
            els.revealSeg.addEventListener('click', (e) => {
                const opt = e.target.closest ? e.target.closest('.seg__opt') : null;
                if (!opt || !opt.dataset.reveal) return;
                settings.revealMode = (opt.dataset.reveal === 'bass') ? 'bass' : 'roman';
                saveSettings();
                updateRevealSeg();
                if (mpExpanded) mpPaintCover();
            });
            updateRevealSeg();
        }

        // 🔁 连续播放（原「自动连播」，界面 2026-10-06 改名）：一段播完 → 停一下 → 自动换新的一段接着播
        //   ★ 现在是 button[role=switch]，必须用 click 切 aria-checked ——
        //     对 button 来说 'change' 事件根本不会触发（那是 input 的），
        //     照旧写就会"点下去没反应"。
        if (els.autoContinue) {
            els.autoContinue.addEventListener('click', () => {
                settings.autoContinue = !settings.autoContinue;
                saveSettings();
                syncTogglePills();
                if (!settings.autoContinue) {
                    cancelAutoNext();
                    showAutoInfo('已关闭连续播放');
                }
            });
        }

        // 🎧 随身听模式：每小节最后一拍只弹这个和弦的根音。
        //   它改的是"播放排程"→ 当前这段渲染好的 WAV 立刻过期。
        //   用户拍板"切完立刻能听到效果"，所以这里直接作废 + 从头重放一遍。
        if (els.portable) {
            els.portable.addEventListener('click', () => {
                settings.portable = !settings.portable;
                saveSettings();
                syncTogglePills();
                invalidateRenderedAudio(settings.portable
                    ? '随身听模式已开启：每小节的最后一拍只给根音，正在重放…'
                    : '随身听模式已关闭，正在重放…');
                doPlay(lastPlayMode, 0);
            });
        }
        syncTogglePills();

        // （原「停止」键已删：要停下来统一按底部播放器的暂停键，那一下同样会打断自动连播接力）

        // 点击谱面上的小节：**在播** → 从该小节接着播；**暂停** → 与卡片页的「上一个/下一个」
        //   同一套规则（用户 2026-10-07）：只把这一小节响一下、进度环不走，
        //   并记住"下次按播放从这一小节起"（mpPauseJumpTo 由 mpTogglePlay 消费）。
        //   事件委托：命中矩形带 data-measure，点它任意位置都算点这一小节。
        if (els.sheetMusic) {
            els.sheetMusic.addEventListener('click', (e) => {
                const rect = e.target.closest ? e.target.closest('[data-measure]') : null;
                if (!rect) return;
                if (isRendering || !data) return;
                const m = parseInt(rect.dataset.measure, 10);
                if (!isFinite(m)) return;
                if (mpIsPlaying()) {
                    setMeasureHighlight(m);          // 先给点击反馈，再去 seek / 渲染
                    doPlay(lastPlayMode, m);
                    return;
                }
                mpShowMeasureOnly(m);
                mpPauseJumpTo = m;
                mpPreviewChord(m);
            });
        }

        // ---------------- 底部迷你播放器 ----------------
        if (els.mpExpand) els.mpExpand.addEventListener('click', () => mpSetExpanded(true));
        if (els.mpClose) els.mpClose.addEventListener('click', () => mpSetExpanded(false));
        // ★ 级数图不再有"点一下切换显隐" —— 改成整个舞台长按揭示（见 bindStageGesture）。
        if (els.mpPrev) els.mpPrev.addEventListener('click', () => mpJump(-1));
        if (els.mpNext) els.mpNext.addEventListener('click', () => mpJump(1));
        if (els.mpPlayPause) els.mpPlayPause.addEventListener('click', () => { mpTogglePlay(); });
        if (els.mpPlayPauseMin) els.mpPlayPauseMin.addEventListener('click', () => { mpTogglePlay(); });
        if (els.mpSheetToggle) els.mpSheetToggle.addEventListener('click', () => {
            mpSetStageView(mpStageView === 'sheet' ? 'card' : 'sheet');
        });
        if (els.mpGenerate) els.mpGenerate.addEventListener('click', () => { mpRegenerate(); });
        if (els.mpGenerateMin) els.mpGenerateMin.addEventListener('click', () => { mpRegenerate(); });
        if (els.mpErrorNone) els.mpErrorNone.addEventListener('click', () => mpSubmitReport(null));
        // 用 pointerdown 而不是 click 关闭：iOS Safari 对 fixed 遮罩的 click
        // 判定有坑（下方区域第一次 tap 常被吞/错位，要点两下）。按下即关最跟手。
        // ★ 判定从"落点严格等于遮罩"改成"落点不在面板内"：
        //   面板有 18px 内边距、遮罩有 16px 内边距，落在这些缝隙里的点击
        //   原来的写法不算数 → 表现为"要点两下才关"。现在一次即关。
        //   用 capture 阶段，避免面板内部按钮的冒泡被误判。
        if (els.mpError) {
            els.mpError.addEventListener('pointerdown', (e) => {
                if (!e.target.closest || !e.target.closest('.mp-error__panel')) mpCloseError();
            }, { capture: true });
        }

        // 听辨辅助窗：柱式（点一下即试听一遍）/ 点右侧数字试听 / 点窗外关闭并从这一小节继续
        //   ★ 第十八轮：「和弦分解」按钮已删（用户要求），所以这里只绑柱式。
        //     开窗那一响与 pointerup 兜底补放仍然是分解/琶音 —— 那两处在 mpOpenAid / finish 里，未动。
        if (els.mpAidBlock) els.mpAidBlock.addEventListener('click', () => mpReplayAid('block'));
        // 数字列做事件委托（内容是每次开窗重画的，不能逐个挂）。
        //   ★ 按 data-midi 认音，不按数字 —— 两个 1 是不同音高。
        //   ★ 第十六轮：**从 click 改成 pointerdown**。三个理由：
        //     ① 用户反馈"快速连点两个音，会重复上一个音而不是新点的音"——
        //        iOS 上合成 click 在快速连点时会延迟/合并、目标解析到上一个按钮；
        //        而 pointerdown 在手指落下的那一刻就带着**当时**的 target 派发，不会错位。
        //     ② 需求：两指同时按两个音要同时出声 —— click 是按"最后一次触摸"合成的，
        //        多指时根本不成立；pointerdown 是每根手指各来一次。
        //     ③ 触感：指下即响，比等 click 更跟手。
        //   preventDefault 用来压掉紧随其后的合成 click（避免万一的双触发）+ 抑制长按选择。
        if (els.mpAidTones) {
            els.mpAidTones.addEventListener('pointerdown', (e) => {
                const b = (e.target && e.target.closest) ? e.target.closest('[data-midi]') : null;
                if (!b) return;
                try { e.preventDefault(); } catch (err) {}
                const midi = parseInt(b.dataset.midi, 10);
                if (!isFinite(midi)) return;
                // 记一笔（真机上复现"连点重复上一个音"时读 _getAidTapLog() 就能判定）
                try {
                    mpAidTapLog.push({
                        midi: midi, pointerId: e.pointerId, ts: Date.now(),
                        x: Math.round(e.clientX), y: Math.round(e.clientY)
                    });
                    if (mpAidTapLog.length > 12) mpAidTapLog.shift();
                } catch (err) {}
                mpPlayAidTone(midi);
            });
        }
        if (els.mpAid) {
            els.mpAid.addEventListener('pointerdown', (e) => {
                // 窗内任何按下（含点音名）也顺手解锁一次音频上下文 —— 它是真激活事件
                unlockAudioNow();
                if (!e.target.closest || !e.target.closest('.mp-aid__panel')) mpCloseAid();
            }, { capture: true });
        }
        if (els.mpErrorGrid) {
            els.mpErrorGrid.addEventListener('click', (e) => {
                const b = e.target.closest ? e.target.closest('[data-degree]') : null;
                if (!b) return;
                mpSubmitReport(parseInt(b.dataset.degree, 10));
            });
        }

        // 错题练习开关：面板顶部按钮 = 开/关切换；数据库页按钮 = 快捷进入
        if (els.dbPractice) els.dbPractice.addEventListener('click', () => { startPractice(); });
        if (els.mpExitPractice) els.mpExitPractice.addEventListener('click', () => {
            if (practiceMode) { exitPractice(); return; }
            startPractice().then((ok) => {
                if (!ok) renderInfoText('还没有错题记录，先在普通模式练几题', false);
            });
        });

        // 长按看的答案：按住揭示、按住上滑报错、按住左/右滑上一个/下一个（左右互通）
        bindStageGesture();

        // ★ 第十六轮：任意一次点击都顺手"续一下"音频上下文。
        //   为什么挂在 document 的 capture 阶段：它比所有目标处理器都早跑，
        //   所以「用户点哪都行，排程之前上下文已经被唤醒过一次」——
        //   这是"浏览器放一会儿再切回来就没声音"的兜底（真正的自愈在宿主的
        //   ensureAudioLive 里：resume 起不来就原地重建 AudioContext）。
        //   passive:true 不拦任何默认行为；重复调用是幂等的。
        document.addEventListener('pointerdown', () => {
            try {
                const host = global.ChordHost;
                if (host && typeof host.ensureAudioLive === 'function') host.ensureAudioLive();
                else unlockAudioNow();
            } catch (e) {}
        }, { capture: true, passive: true });

        // 连按两次卡片不该把页面放大、也不该选中面板里的文字。
        //   CSS 那边已经用 user-select:none + touch-action:manipulation + viewport
        //   三重压制；这里再拦一道 dblclick / gesturestart，兜住个别浏览器的漏网。
        const withinPanel = (t) => !!(t && t.closest && t.closest('.mp, .mp-error, .mp-aid'));
        document.addEventListener('dblclick', (e) => {
            if (withinPanel(e.target)) e.preventDefault();
        }, { passive: false });
        document.addEventListener('gesturestart', (e) => {
            if (withinPanel(e.target)) e.preventDefault();
        }, { passive: false });

        // ---------------- 数据库页（听辨统计） ----------------
        if (els.dbScopeAll) els.dbScopeAll.addEventListener('click', () => setStatsScope('all'));
        if (els.dbScopeRound) els.dbScopeRound.addEventListener('click', () => setStatsScope('session'));
        if (els.dbClearRound) els.dbClearRound.addEventListener('click', () => {
            if (typeof confirm === 'function' && !confirm('清空「本轮」的统计，重新计数？\n（历史总计会保留）')) return;
            statsSession = emptyStats();
            setStatsScope('session');
            flushStats();
        });
        if (els.dbClearAll) els.dbClearAll.addEventListener('click', () => {
            if (typeof confirm === 'function' && !confirm('清空全部听辨统计（历史总计 + 本轮）？\n这一步不可撤销。')) return;
            statsAll = emptyStats();
            statsSession = emptyStats();
            setStatsScope('all');
            flushStats();
        });

        // 转屏 / 缩放后重画（canvas 尺寸跟着变）；谱表页展开时顺带补 SVG 高度
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', () => {
                if (!mpExpanded) return;
                mpPaintCover();
                if (mpStageView === 'sheet') requestAnimationFrame(fitSheetPage);
            });
        }
        mpSetRevealed(false);
        mpSyncPlayIcon();
        mpOnMeasure(mpMeasure);
    }

    // ============================================================
    // 底部迷你播放器（手持练习用）
    //
    //   收起：一颗胶囊，只有「换一段」（收起条上不写级数，免得剧透答案）。
    //   展开：铺满一屏 —— 顶行（收起 / 播放暂停）、中间级数大图（可点着切换显隐）、
    //         一行三键（上一个 / 报错 / 下一个）、底部「换一段」。
    //
    //   ★ 它是**常驻**的（用户 2026-10-06）：整块 DOM（面板 + 报错浮窗 + 辅助浮窗）
    //     挂在 body 直接子级，不放在任何视图里 —— 切到数据库页它照样在。
    //     切页时只停声音（见 deactivate），不收面板：用户回来能接着操作。
    //   代价：body 上不能加 transform / filter / will-change，否则这两个浮窗的
    //     position:fixed 会被劫持到 body 上（祖先链已缩短到只剩 body）。
    // ============================================================

    // 展开 / 收起。展开时锁住背景滚动（否则面板后面还能橡皮筋滚）。
    function mpSetExpanded(on) {
        mpCancelGesture();               // 面板状态一变，在途的手势（含冻结）作废
        mpExpanded = !!on;
        if (els && els.mp) els.mp.dataset.state = mpExpanded ? 'expanded' : 'collapsed';
        if (typeof document !== 'undefined' && document.body) {
            document.body.style.overflow = mpExpanded ? 'hidden' : '';
        }
        if (mpExpanded) {
            mpPaintCover();
            mpSyncPlayIcon();
            if (mpStageView === 'sheet') requestAnimationFrame(fitSheetPage);
        } else {
            mpCloseError();
        }
    }

    // 舞台两页切换：'card'（级数卡片/长按热区）⇄ 'sheet'（五线谱）。
    //   谱表页没有长按揭示那套东西 —— 它自己的交互只有"点小节跳转"。
    function mpSetStageView(v) {
        v = (v === 'sheet') ? 'sheet' : 'card';
        if (v === mpStageView) return;
        mpCancelGesture();            // 切页瞬间作废在途手势
        mpStageView = v;
        // ★ 谱表页把卡片整块藏掉（.is-sheet）：谱表页是**透明底**的 absolute 覆盖层，
        //   卡片那圈 1px 描边 + 阴影会从谱面四周透出来 —— 看着像"谱表浮在卡片上"
        //   （用户 2026-10-07 报的现象）。CSS 里按页隐藏，切回卡片页自动恢复。
        if (els && els.mpStage) els.mpStage.classList.toggle('is-sheet', v === 'sheet');
        if (els && els.mpSheetPage) {
            els.mpSheetPage.hidden = (v !== 'sheet');
            if (v === 'sheet') requestAnimationFrame(fitSheetPage);
        }
        // 切换键文案 = 点下去会去的那一页（图标 + 文字一起换）
        if (els && els.mpSheetToggle) {
            els.mpSheetToggle.innerHTML = (v === 'sheet')
                ? iconSvg('i-card') + '卡片'
                : iconSvg('i-staff') + '谱表';
        }
        // 切回卡片页时，若之前是揭示态，封面已在 canvas 里，无需重画
    }

    // 谱表页的高度补偿入口（手机竖屏需要显式给 SVG 设高，见 fitSheetSvgHeight）
    function fitSheetPage() {
        if (!els || !els.mpSheetPage) return;
        const svgEl = els.mpSheetPage.querySelector('svg');
        if (!svgEl) return;
        const vb = (svgEl.getAttribute('viewBox') || '').split(/\s+/);
        const vbW = parseFloat(vb[2]);
        const vbH = parseFloat(vb[3]);
        if (vbW > 0 && vbH > 0) fitSheetSvgHeight(svgEl, vbW, vbH);
    }

    // 小节变了 → 收起条播放键的进度环 + （展开时）重画大图
    //
    //   ★ 这是"显示"的唯一入口，所以冻结闸门也放在这里：
    //     mpLiveMeasure 永远跟着播放走（真实进度不丢），
    //     但只要手指还按着在看答案（mpFreeze 非空），显示就停在冻结点不动。
    function mpOnMeasure(m) {
        if (m < 0) return;
        mpLiveMeasure = m;
        if (mpFreeze) return;
        mpMeasure = m;
        mpPaintProgress();
        if (mpExpanded) mpPaintCover();
    }

    // 收起条播放键的进度环：整段进度 0…1（写入 --mp-prog，并落到 SVG 的 stroke-dashoffset）。
    //   收起条不再显示「第 X / Y 小节」文字（用户 2026-10-06 拍板），进度只剩这根环。
    //
    //   ★ 进度是**连续**的：用「音频当前播放位置 / 整段时长」算，而不是「第几小节 / 总小节数」。
    //     用户 2026-10-06：「进度条应该无极挪动，而不是现在一小节前进一格」。
    //   ★ 时长拿不到时（还没渲染出音频元素 / 还没 loadedmetadata）就是 **0**，环一点都不亮。
    //     绝不要退回"按小节算"：`chordAudioEl` 只在 doPlay 里才创建，页面刚刷新、一次都没播过时
    //     它还是 null，那时按小节算会给出 (0+1)/8 = 1/8 —— 于是"没播放，进度条却已经有一截了"
    //     （用户 2026-10-06 反馈第 3 条）。没开始播就该是 0。
    function mpProgressTime() {
        // 冻结（长按看答案）期间：环停在冻结那一刻，跟着播放走下去会和"面板停住"自相矛盾
        if (mpFreeze && mpFreeze.t != null) return mpFreeze.t;
        return chordAudioEl ? chordAudioEl.currentTime : 0;
    }

    function mpPaintProgress() {
        if (!els || !els.mpPlayPauseMin) return;
        const dur = chordAudioEl ? chordAudioEl.duration : 0;
        const t = mpProgressTime();
        const p = (isFinite(dur) && dur > 0) ? (t / dur) : 0;   // 无极：跟真实时间走；没开始播 = 0
        const v = Math.max(0, Math.min(1, p));
        els.mpPlayPauseMin.style.setProperty('--mp-prog', String(v));
        // 方案 B：键外圈那根描边就是进度条。pathLength="1" + dasharray "1 1"，
        //   所以 dashoffset = 1 − 进度 时，露出来的弧长正好等于进度，
        //   路径起点在 12 点钟方向（见 index.html 的 <path d>），亮起来的那段从 12 点顺时针长。
        if (els.mpRingBar) {
            els.mpRingBar.style.strokeDashoffset = String(1 - v);
            // ★ v = 0 时那根描边还会在 12 点钟留一个 1.5px 的小圆点 ——
            //   它是 round linecap 对"零长度 dash"的渲染（Chrome/Safari 都会画），
            //   看着仍然像"已经有一点点进度了"。进度为 0 就干脆整根藏掉，播起来再显示。
            els.mpRingBar.style.visibility = (v <= 0) ? 'hidden' : '';
        }
    }

    // （「开始播放⇄下一首」动态文案已废——用户 2026-10-06 拍板：两个键固定功能，
    //    播放/暂停独立成键，生成键恒为「⏭ 下一首」。）

    // 把当前小节的级数画进面板里那张 canvas（与锁屏封面同一套画法、同一份数据）
    //
    //   尺寸不用 canvas 自己的 clientWidth 推 —— 那会成环（设了属性→尺寸变→下次读到的又不一样）。
    //   改成量"装它的那个舞台"，取能放下的最大正方形，再用行内样式把它钉死。
    function mpPaintCover() {
        if (!els || !els.mpCover) return;
        // ★ 冻结期间画的是"按住那一刻的快照"，不是当前小节 —— 这就是"报错对象锁定"的一半。
        //   （另一半在 mpOpenError：它也只认这份快照。）
        const info = mpFreeze ? mpFreeze.info : buildCoverInfo(mpMeasure);
        if (!info) return;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        let side = 0;
        if (els.mpStage) {
            const r = els.mpStage.getBoundingClientRect();
            side = Math.floor(Math.min(r.width, r.height)) - 8;   // 减掉舞台自己的 4px 内边距 ×2
        }
        if (!(side > 0)) {
            const vw = (typeof window !== 'undefined') ? window.innerWidth : 390;
            const vh = (typeof window !== 'undefined') ? window.innerHeight : 700;
            side = Math.max(200, Math.min(vw - 40, vh - 300));
        }
        els.mpCover.style.width = side + 'px';
        els.mpCover.style.height = side + 'px';
        // 占位卡也钉成同一个正方形 —— 揭示/回遮时版式一点都不跳
        if (els.mpCoverHidden) {
            els.mpCoverHidden.style.width = side + 'px';
            els.mpCoverHidden.style.height = side + 'px';
        }
        // 遮住时：**连画都不画**，还把画布像素抹掉。
        //   以前是"照画 + 盖一层 blur/grayscale"，但底色色相会透过毛玻璃漏出来
        //   （黄=Ⅴ、红=Ⅲ、蓝=Ⅳ…一眼就能猜），罗马数字的轮廓也没盖住。
        const px = Math.round(side * dpr);
        if (els.mpCover.width !== px || els.mpCover.height !== px) {
            els.mpCover.width = px;
            els.mpCover.height = px;
        }
        if (!mpRevealing) {
            try { els.mpCover.getContext('2d').clearRect(0, 0, px, px); } catch (e) {}
            return;
        }
        try {
            // ★ 第 5 参只在设置页选了「低音级数」时给 —— 不给就是现状（罗马数字档）。
            //   锁屏封面不走这里（它走 coverBlobUrl），所以那边恒为罗马数字，不受设置影响。
            drawCover(els.mpCover.getContext('2d'), px, info, false,
                (settings.revealMode === 'bass') ? { bassOnly: true } : null);
        } catch (e) {}
    }

    // 圆角矩形路径（Canvas2D 的 roundRect 在旧 Safari 上没有，自己画一遍最保险）
    function roundRectPath(c, x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        c.beginPath();
        c.moveTo(x + r, y);
        c.lineTo(x + w - r, y);
        c.arcTo(x + w, y, x + w, y + r, r);
        c.lineTo(x + w, y + h - r);
        c.arcTo(x + w, y + h, x + w - r, y + h, r);
        c.lineTo(x + r, y + h);
        c.arcTo(x, y + h, x, y + h - r, r);
        c.lineTo(x, y + r);
        c.arcTo(x, y, x + r, y, r);
        c.closePath();
    }

    // 揭示开关（瞬时）：按住 = true，松手 = false。
    //   ★ 与旧版的区别：以前是"点一下持久切换"，现在**默认永远遮住**，
    //     只有手指按住的那段时间才看得见。
    function mpSetRevealed(on) {
        mpRevealing = !!on;
        if (els && els.mpStage) {
            els.mpStage.classList.toggle('is-hidden', !mpRevealing);
            els.mpStage.classList.toggle('is-revealed', mpRevealing);
        }
        if (els && els.mpCoverHidden) els.mpCoverHidden.hidden = mpRevealing;
        if (!mpRevealing) {
            // 遮住时把画布上的像素也抹掉 —— 只靠 CSS 藏，万一有渲染怪癖就漏了；
            // 抹掉之后它是一张真正的空白画布，零线索。
            if (els && els.mpCover) {
                try { els.mpCover.getContext('2d').clearRect(0, 0, els.mpCover.width, els.mpCover.height); } catch (e) {}
            }
            return;
        }
        // 揭示时立刻画一张，别等到下一帧才有图（否则会看到空卡片闪一下）
        if (mpExpanded) mpPaintCover();
    }

    // ------------------------------------------------------------
    // 长按看答案：手势状态机
    //
    //   按下 →（MP_HOLD_MS）→ 揭示 + **冻结**当前小节
    //     按住往上滑 → 打开报错浮窗（对象 = 冻结点那个和弦，不随音乐前进而变）
    //     按住往左滑 → 回退到上一个和弦（可连滑，每滑一格退一格）
    //   松手 / 系统打断 → 回到遮住 + 解冻
    //
    //   ★ 音乐不停：用户明确要的是"按住期间照常播，只有封面和报错对象冻住"。
    //   ★ 冻结为什么不是只记一个"小节索引"：
    //     自动连播的 doGenerate 会**整体换掉 data**，索引会指到新一段上去。
    //     而 buildCoverInfo() 返回的是纯数据快照（degree/roman/base/parts/…），
    //     所以这里直接把它整个存下来 —— 就算整段被换掉，按住时看到的答案也不变。
    // ------------------------------------------------------------

    // 往前取 n 个级数（不足处补 null）：[m-n, …, m-1]。
    //   错误组合榜要"以出错和弦结尾、长度 2/3/4 的窗口"，所以从 prev2 泛化成任意长度。
    function mpPrevDegrees(m, n) {
        const out = [];
        if (!data) { for (let i = 0; i < n; i++) out.push(null); return out; }
        for (let i = m - n; i < m; i++) {
            out.push((i >= 0 && i < data.chords.length) ? data.chords[i].degree : null);
        }
        return out;
    }

    function mpPrevTwo(m) { return mpPrevDegrees(m, 2); }

    function mpFreezeAt(m) {
        const info = buildCoverInfo(m);
        if (!info) return false;
        mpFreeze = {
            seg: mpSeg,
            measure: m,
            info: info,
            degree: info.degree,
            roman: info.roman,
            midis: data.chords[m].midis.slice(),   // 听辩辅助窗琶音/柱式要用（快照自带，跨段不串）
            prev2: mpPrevTwo(m),
            prev3: mpPrevDegrees(m, 3),
            // 冻结那一刻的播放位置：进度环是连续值，冻结期间得把它也钉住，
            //   否则"面板停住、环还在走"会自相矛盾（见 mpProgressTime）。
            t: (chordAudioEl ? chordAudioEl.currentTime : null)
        };
        mpMeasure = m;            // 面板（含收起条上的进度环）都停在冻结点
        mpPaintProgress();
        return true;
    }

    function mpUnfreeze() {
        if (!mpFreeze) return;
        mpFreeze = null;
        mpMeasure = mpLiveMeasure;    // 恢复跟随实时进度
        mpPaintProgress();
        if (mpExpanded) mpPaintCover();
    }

    // 手势的统一收尾。任何"显式动作"（点按钮 / 换段 / 收起面板 / 切视图）都先调它。
    function mpCancelGesture() {
        // 听辩辅助窗还开着时，任何显式收尾先静默收掉它（停声+恢复播放+收浮窗）。
        //   注意这里不调 mpCloseAid —— 会递归（mpCloseAid 末尾也调 mpCancelGesture）。
        if (mpAid) {
            mpStopAidVoices();
            if (els && els.mpAid) els.mpAid.hidden = true;
            if (mpAid.wasPlaying && chordAudioEl) { try { chordAudioEl.play().catch(() => {}); } catch (e) {} }
            mpAid = null;
            mpAidLast = null;
            mpSyncPlayIcon();
        }
        if (mpGesture) {
            if (mpGesture.timer) clearTimeout(mpGesture.timer);
            if (els && els.mpStage && mpGesture.captured) {
                try { els.mpStage.releasePointerCapture(mpGesture.pointerId); } catch (e) {}
            }
            mpGesture = null;
        }
        if (els && els.mpStage) {
            els.mpStage.classList.remove('is-pressing', 'is-revealed');
        }
        mpClearDragOffset();          // 跟手位移归零（有过渡 → 卡片自己弹回原位）
        mpSetRevealed(false);
        mpUnfreeze();
    }

    // 长按阈值到点：冻结 + 揭示
    function mpArmGesture(g) {
        if (!mpFreezeAt(mpLiveMeasure)) return false;
        g.phase = 'armed';
        if (els && els.mpStage) {
            els.mpStage.classList.remove('is-pressing');
            els.mpStage.classList.add('is-revealed');
        }
        mpSetRevealed(true);
        return true;
    }

    // 按住左滑：退到上一个和弦（冻结目标与小节一起退，音乐也跟着 seek 过去）
    //   ★ 第十六轮：**暂停态**下套用与「上一个」按钮同一规则 —— 只切 + 试听，不接着播。
    function mpStepBackWhileHolding() {
        if (!data || !data.chords.length) return;
        const cur = mpFreeze ? mpFreeze.measure : mpMeasure;
        const next = Math.max(0, cur - 1);
        if (next === cur) return;          // 已经在第一小节
        mpFreezeAt(next);
        mpSetRevealed(true);
        mpNudge('left');
        if (mpIsPlaying()) { doPlay(lastPlayMode, next); return; }
        mpShowMeasureOnly(next);
        mpPauseJumpTo = next;
        mpPreviewChord(next);
    }

    // ---- 卡片对水平滑动的手感反馈：跟手位移 + 每格轻推 ----
    //   风格要求：克制。所以位移比例只有 0.15、上限 14px，轻推只 ±6px / 0.17s。
    const MP_DRAG_RATIO = 0.15;   // 手指走 1px，卡片走 0.15px
    const MP_DRAG_MAX_X = 14;     // 横向跟手位移上限（px）
    const MP_DRAG_MAX_Y = 10;     // 纵向更克制一点（px）
    const MP_NUDGE_PX = 8;        // 每切一格的轻推幅度（px，横向）
    const MP_NUDGE_PX_Y = 6;      // 纵向轻推幅度（px）
    const MP_NUDGE_MS = 190;      // 轻推动画时长（ms）

    // 跟手位移走 CSS 独立属性 translate（与 transform:scale 互不覆盖），
    //   写到舞台的 --mp-drag-x 上，.mp-cover 引用它。
    function clampDrag(v, lim) {
        return (v > lim) ? lim : ((v < -lim) ? -lim : v);
    }

    function mpSetDragOffset(dx, dy) {
        const stage = els && els.mpStage;
        if (!stage) return;
        // 谱表页只认纵向滚动，卡片不跟手
        if (mpStageView === 'sheet') { mpClearDragOffset(); return; }
        stage.classList.add('is-dragging');       // 拖动期间关掉 translate 的过渡 → 跟手
        stage.style.setProperty('--mp-drag-x', clampDrag(dx * MP_DRAG_RATIO, MP_DRAG_MAX_X).toFixed(1) + 'px');
        stage.style.setProperty('--mp-drag-y', clampDrag(dy * MP_DRAG_RATIO, MP_DRAG_MAX_Y).toFixed(1) + 'px');
    }

    function mpClearDragOffset() {
        const stage = els && els.mpStage;
        if (!stage) return;
        stage.classList.remove('is-dragging');    // 松手后恢复过渡 → 自动弹回
        stage.style.removeProperty('--mp-drag-x');
        stage.style.removeProperty('--mp-drag-y');
    }

    // 每切一格轻推一下（'left' 往左、'right' 往右）。
    //   用 Web Animations 而不是切 class：连滑时能可靠地"每一步重放"，且不需要强制重排。
    let mpNudgeAnim = null;
    function mpNudge(dir) {
        const cover = els && els.mpCover;
        if (!cover || typeof cover.animate !== 'function') return;
        if (mpNudgeAnim) { try { mpNudgeAnim.cancel(); } catch (e) {} mpNudgeAnim = null; }
        const vertical = (dir === 'up' || dir === 'down');
        const p = vertical ? MP_NUDGE_PX_Y : MP_NUDGE_PX;
        const sign = (dir === 'right' || dir === 'down') ? 1 : -1;
        const axis = vertical ? 'translateY' : 'translateX';
        // 只动 transform（不动 translate），所以跟手位移不会被覆盖掉
        mpNudgeAnim = cover.animate(
            [
                { transform: 'scale(1) ' + axis + '(0px)' },
                { transform: 'scale(1) ' + axis + '(' + (sign * p) + 'px)' },
                { transform: 'scale(1) ' + axis + '(0px)' }
            ],
            { duration: MP_NUDGE_MS, easing: 'ease-out' }
        );
        mpNudgeAnim.onfinish = () => { mpNudgeAnim = null; };
    }

    // 按住右滑：进到下一个和弦（与左滑对称，可连滑；到最后一个就停住不动）
    //   ★ 第十六轮：暂停态同样只切 + 试听，不接着播。
    function mpStepForwardWhileHolding() {
        if (!data || !data.chords.length) return;
        const last = data.chords.length - 1;
        const cur = mpFreeze ? mpFreeze.measure : mpMeasure;
        const next = Math.min(last, cur + 1);
        if (next === cur) return;          // 已经在最后一小节
        mpFreezeAt(next);
        mpSetRevealed(true);
        mpNudge('right');
        if (mpIsPlaying()) { doPlay(lastPlayMode, next); return; }
        mpShowMeasureOnly(next);
        mpPauseJumpTo = next;
        mpPreviewChord(next);
    }

    function bindStageGesture() {
        const stage = els && els.mpStage;
        if (!stage) return;

        // iOS 长按会弹拷贝菜单/放大镜，直接压掉
        stage.addEventListener('contextmenu', (e) => { e.preventDefault(); });

        stage.addEventListener('pointerdown', (e) => {
            // ★ 趁"真·用户激活事件"把音频上下文解锁（同步）。
            //   下滑那声琶音稍后在 pointermove 里播，而 pointermove 不是激活事件 ——
            //   不在这里提前解锁，iOS 会拒绝 resume，于是"有窗没声"。
            unlockAudioNow();
            if (!mpExpanded || !data || !data.chords.length) return;
            if (e.isPrimary === false) return;      // 只认主指针，防双指误触
            if (mpGesture) return;
            const g = {
                pointerId: e.pointerId,
                x0: e.clientX,
                y0: e.clientY,
                anchorX: e.clientX,        // 水平台阶锚点（左右共用：往左 -MP_STEP_PX / 往右 +MP_STEP_PX）
                phase: 'pending',
                axis: null,
                viewOnly: mpStageView === 'sheet',   // 谱表页：没有长按揭示（点击小节跳转另有处理）
                consumed: false,      // 手势已被听辩辅助窗接管：松手只回收指针，不解冻
                captured: false,
                timer: 0
            };
            mpGesture = g;
            try { stage.setPointerCapture(e.pointerId); g.captured = true; } catch (err) {}
            if (!g.viewOnly) {
                stage.classList.add('is-pressing');
                g.timer = setTimeout(() => { g.timer = 0; mpArmGesture(g); }, MP_HOLD_MS);
            }
        });

        stage.addEventListener('pointermove', (e) => {
            const g = mpGesture;
            if (!g || e.pointerId !== g.pointerId) return;
            const dx = e.clientX - g.x0;
            const dy = e.clientY - g.y0;

            if (g.phase === 'pending') {
                // 还没到长按阈值就动了 → 当成滑动/误触取消（不揭示、不触发方向）。
                //   （未长按的左右滑翻页手势已废——切页走顶行中央的按键。）
                if (Math.abs(dx) > MP_SLOP_PX || Math.abs(dy) > MP_SLOP_PX) {
                    if (g.timer) { clearTimeout(g.timer); g.timer = 0; }
                    stage.classList.remove('is-pressing');
                    if (g.captured) { try { stage.releasePointerCapture(g.pointerId); } catch (err) {} g.captured = false; }
                    mpGesture = null;
                }
                return;
            }
            if (g.phase !== 'armed') return;

            // 跟手位移：按当前轴走 —— 横向就跟横、纵向就跟竖（斜滑按主导轴，避免来回抖）。
            const horizontal = g.axis
                ? (g.axis === 'h')
                : (Math.abs(dx) > Math.abs(dy));
            if (horizontal) mpSetDragOffset(dx, 0); else mpSetDragOffset(0, dy);

            // 先定轴：斜滑按主导轴，绝不双触发；轴一旦锁定，另一方向就不再触发。
            //   ★ 用户 2026-10-07：上下两条手势**对调** —— 上滑 = 报错，下滑 = 听辨辅助。
            //   错题练习不设报错 → 不认"上滑"这个轴（下滑辅助/左右滑平移照常）。
            if (!g.axis) {
                if (dy > MP_DOWN_PX && dy > Math.abs(dx) * 1.2) g.axis = 'down';
                else if (!practiceMode && dy < -MP_UP_PX && Math.abs(dy) > Math.abs(dx) * 1.2) g.axis = 'up';
                // 左右合并成一个水平轴 'h'：具体往左还是往右，由 move 里相对锚点的位移决定
                else if (Math.abs(dx) > MP_STEP_PX && Math.abs(dx) > Math.abs(dy) * 1.2) g.axis = 'h';
            }

            if (g.axis === 'down') {
                if (dy > MP_DOWN_PX) {
                    g.phase = 'done';                 // 一次性动作，之后忽略 move
                    g.consumed = true;                // 手势交给辅助窗接管：松手不解冻、不关门
                    mpNudge('down');
                    mpOpenAid(mpFreeze);              // 暂停 + 播冻结和弦的琶音 + 弹辅助窗
                }
                return;
            }

            if (g.axis === 'up') {
                if (dy < -MP_UP_PX) {
                    g.phase = 'done';                 // 一次性动作，之后忽略 move
                    mpNudge('up');                    // 触发那一下的纵向轻推（与左右切格同族）
                    mpOpenError(mpFreeze);            // 目标 = 冻结快照；音乐不停
                }
                return;
            }

            if (g.axis === 'h') {
                // 水平轴只有一个锚点，每滑够一格就走一步、锚点跟着走。
                //   左右因此是互通的：左滑两格后手指折返，只要相对"停下那一点"再滑够
                //   一格就前进 —— 不需要先把手指拉回起点。
                let guard = 0;
                while (guard < 20) {
                    const d = e.clientX - g.anchorX;
                    if (d >= MP_STEP_PX) { g.anchorX += MP_STEP_PX; mpStepForwardWhileHolding(); }
                    else if (d <= -MP_STEP_PX) { g.anchorX -= MP_STEP_PX; mpStepBackWhileHolding(); }
                    else break;
                    guard++;
                }
            }
        });

        const finish = (e) => {
            const g = mpGesture;
            if (!g || (e && e.pointerId !== undefined && e.pointerId !== g.pointerId)) return;
            if (g.consumed) {
                // 听辩辅助窗已接管：只回收指针。解冻/恢复播放由"关辅助窗"那一侧负责。
                if (g.captured) { try { stage.releasePointerCapture(g.pointerId); } catch (err) {} }
                // ★ 兜底补放：下滑那声琶音是在 pointermove（非激活事件）里播的，若当时没能解锁
                //   （mpAidLast.ok 为假），这里补一次 —— pointerup 是激活事件，这一下一定解锁。
                //   守卫用"上一次 ok 为假才补"，所以第一次真排上程了绝不会出现双声。
                if (mpAid && mpAidLast && !mpAidLast.ok) {
                    try { mpReplayAid('arp'); } catch (err) {}
                }
                mpGesture = null;
                return;
            }
            mpCancelGesture();
        };
        stage.addEventListener('pointerup', finish);
        stage.addEventListener('pointercancel', finish);
        stage.addEventListener('lostpointercapture', finish);
    }

    // ============================================================
    // 图标（用户 2026-10-06：全站去 emoji，统一线性 SVG）
    //   —— 图标本体全部定义在 index.html 顶部那个隐藏的 <svg class="ic-sprite"> 里，
    //      这里只负责拼出引用片段。同文档 <use href="#id"> 引用，file:// 打开也能用。
    //   —— 只有"纯符号的播放/暂停键"用实心版（solid=true），其余一律线性。
    // ============================================================
    function iconSvg(id, solid) {
        return '<svg class="ic' + (solid ? ' ic--solid' : '') + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
    }

    function mpSyncPlayIcon() {
        if (!els) return;
        const playing = !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended);
        // 纯符号播放键（无文字、键又小）→ 实心，一眼可辨
        const iconId = playing ? 'i-pause-solid' : 'i-play-solid';
        // ★ 只改 <use> 的引用，**不要**写 innerHTML：
        //   收起条那颗播放键里除了图标，还有外圈那根进度环（方案 B），
        //   整块 innerHTML 重写会把环一起抹掉 —— 环还在 DOM 引用里、却已脱离文档，
        //   表现为"进度一直在写、画面上却没有"。踩过一次。
        const sync = (btn) => {
            if (!btn) return;
            const use = btn.querySelector('use');
            if (use) use.setAttribute('href', '#' + iconId);
            else btn.innerHTML = iconSvg(iconId, true);   // 兜底：万一按钮里没有 <use>
            btn.classList.toggle('is-playing', playing);
        };
        sync(els.mpPlayPause);
        sync(els.mpPlayPauseMin);
        // 收起条波形动画的开关
        if (els.mpExpand) els.mpExpand.classList.toggle('is-playing', playing);
    }

    // 播放 / 暂停。
    //   暂停用 pause()，**不用 stopChordPlayback** —— 那个是"停止"语义，
    //   会 cancelAutoNext() 并且清掉高亮，把自动连播打断。
    //   继续播放优先"原地续播"（保留小节内的位置）；还没渲染过才回落 doPlay。
    async function mpTogglePlay() {
        if (!data || !data.chords.length) return;
        const playing = !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended);
        if (playing) {
            try { chordAudioEl.pause(); } catch (e) {}
            return;
        }
        // ★ 第十六轮：暂停期间用「上一个/下一个」切过和弦 → 这里要**从新切到的那一小节起播**，
        //   而不是回到暂停点原地续播（否则"看着在第 5 小节、一播又从第 2 小节响"）。
        if (mpPauseJumpTo >= 0) {
            const t = mpPauseJumpTo;
            mpPauseJumpTo = -1;
            await doPlay(lastPlayMode, t);
            return;
        }
        if (chordAudioEl && blobData === data && blobUrl) {
            try {
                await chordAudioEl.play();
                return;
            } catch (e) { /* 被拦或被换过 → 往下重渲染 */ }
        }
        await doPlay(lastPlayMode, mpMeasure);
    }

    // ------------------------------------------------------------
    // 第十六轮：暂停态下的「上一个 / 下一个」= 只切和弦 + 试听一下，**不接着播**
    // ------------------------------------------------------------
    //   用户要求：暂停时点前进/后退，不要开始播放；切到前/后一个和弦之后把这个和弦
    //   播一下就行，进度环保持静止不流动。
    //   进度环静止是**自然结果**：mpPaintProgress 算的是 currentTime / duration，
    //   这里全程不碰 chordAudioEl.currentTime，所以环停在原处。
    function mpIsPlaying() {
        return !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended);
    }

    // 当前"播放方式" → 试听用的实时奏法。
    //   约定：沿用用户当下选的播放方式（柱式→同时响 / 分解→逐个音 / 单音→只响低音那一个）。
    function mpPreviewStyleFor(mode) {
        if (mode === 'arpeggio') return 'arp';
        if (mode === 'bass') return 'note';
        return 'block';
    }

    // 试听一个小节的和弦（实时 Web Audio，不走主 <audio> → 天然不动进度）
    function mpPreviewChord(next) {
        const c = (data && data.chords) ? data.chords[next] : null;
        if (!c || !c.midis || !c.midis.length) return;
        const mode = lastPlayMode;
        if (mode === 'bass') playInstantChord([c.midis[0]], 'note').catch(() => {});
        else playInstantChord(c.midis, mpPreviewStyleFor(mode)).catch(() => {});
    }

    // 只把"面板显示"挪到第 next 小节，不碰音频。
    //   ★ mpLiveMeasure 也要一起写：mpUnfreeze() 收尾时会执行 `mpMeasure = mpLiveMeasure`，
    //     只写 mpMeasure 的话，手指一松就被拉回原处（表现为"滑完又跳回去"）。
    function mpShowMeasureOnly(next) {
        mpLiveMeasure = next;
        mpMeasure = next;
        mpPaintProgress();
        if (mpExpanded) mpPaintCover();
        setMeasureHighlight(next);
        setCoverMeasure(next);
    }

    // 上一个 / 下一个和弦。
    //   基准用 mpMeasure（面板上正在看的这一小节），**不用 currentTime** ——
    //   暂停作答时 currentTime 停在暂停点甚至 0，拿它做基准会跳错小节。
    function mpJump(dir) {
        if (!data || !data.chords.length) return;
        mpCancelGesture();                   // 显式导航 = 手势结束（含解冻）
        const next = Math.max(0, Math.min(data.chords.length - 1, mpMeasure + dir));
        if (next === mpMeasure) return;      // 已在头 / 尾
        if (mpIsPlaying()) { doPlay(lastPlayMode, next); return; }   // 正在播：维持原行为（seek + 接着播）
        mpShowMeasureOnly(next);             // 暂停：只切显示
        mpPauseJumpTo = next;                // 记住"下次按播放要从这里起"
        mpPreviewChord(next);                // 把这个和弦试听一下
    }

    // 换一段（生成键恒为「⏭ 下一首」——固定功能，不再管"开始播放"分流；
    //   播当前这段是播放键的职责）。默认顺手接着播（MP_AUTOPLAY_AFTER_GENERATE）。
    async function mpRegenerate() {
        if (isRendering) return;
        mpCancelGesture();
        await doGenerate(false);
        if (MP_AUTOPLAY_AFTER_GENERATE) await doPlay(lastPlayMode, 0);
    }

    // 给一个级数色块上色（取全站唯一的 ART_PALETTE —— 与锁屏封面/面板大图同源，
    //   这样"我听成了那个橙色的"这种记忆能直接对上）。
    function paintDegreeChip(el, d) {
        const pal = ART_PALETTE[(d - 1) % ART_PALETTE.length];
        el.style.background = 'linear-gradient(135deg, ' + pal.top + ', ' + pal.bottom + ')';
        el.style.color = pal.ink;
        el.style.borderColor = 'rgba(16, 24, 40, 0.10)';
    }

    // 报错浮窗的槽位顺序。
    //   浮窗是**两列**、行优先填格，所以这里不能按 1..7 顺排，要写成 [1,2,4,3,5,6]：
    //     左列自上而下 = Ⅰ Ⅳ Ⅴ（大和弦）
    //     右列自上而下 = Ⅱ Ⅲ Ⅵ（小和弦）
    //   Ⅶ 单独一排、横跨两列（--wide）。以后要加不协和和弦，往数组末尾追加即可，
    //   会自动落到 Ⅶ 下面新的一排，版式不用动。
    const MP_ERROR_SLOTS = [1, 2, 4, 3, 5, 6, 7];

    // 报错浮窗的选项：设置里勾选的级数（Ⅰ 永远有 —— 它本来就强制参与）+「没听出来」。
    //   每次打开都重建，所以改了设置里的勾选，下次打开就跟着变。
    //
    //   ★ 没勾选的级数**保留一个隐形占位格**（visibility:hidden，不是 display:none）——
    //     否则后面的格子会往前补位，用户肌肉记忆里的位置就漂了。
    function mpBuildErrorOptions() {
        if (!els || !els.mpErrorGrid) return;
        els.mpErrorGrid.innerHTML = '';
        for (let i = 0; i < MP_ERROR_SLOTS.length; i++) {
            const d = MP_ERROR_SLOTS[i];
            const off = (d !== 1 && !settings.degrees[d]);   // Ⅰ 恒在
            if (off) {
                // Ⅶ 关掉时不留占位（否则末尾会多出一条看不见的空行）
                if (d === 7) continue;
                const hole = document.createElement('span');
                hole.className = 'mp-error__hole';
                hole.setAttribute('aria-hidden', 'true');
                els.mpErrorGrid.appendChild(hole);
                continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = (d === 7) ? 'mp-error__opt mp-error__opt--wide' : 'mp-error__opt';
            b.dataset.degree = String(d);
            b.textContent = DEGREE_CHOICES[d - 1];
            paintDegreeChip(b, d);
            els.mpErrorGrid.appendChild(b);
        }
    }

    // 打开报错浮窗。
    //   frozen = 长按那一刻的冻结快照（"按住上滑"进来时传它）；
    //   传 null = 直接点「报错」按钮进来，用面板当前小节。
    //   ★ 目标一旦定下就再也不变 —— 这就是"报错对象锁定在按住那一刻的和弦"。
    function mpOpenError(frozen) {
        if (practiceMode) return;            // 错题练习不设报错
        if (!data || !data.chords.length) return;
        let m, deg, rom, prev2, prev3;
        if (frozen) {
            m = frozen.measure;
            deg = frozen.degree;
            rom = frozen.roman;
            prev2 = frozen.prev2;
            prev3 = frozen.prev3;
        } else {
            m = Math.max(0, Math.min(data.chords.length - 1, mpMeasure));
            deg = data.chords[m].degree;
            rom = data.chords[m].roman;
            prev2 = mpPrevTwo(m);
            prev3 = mpPrevDegrees(m, 3);
        }
        mpErrorCtx = {
            measure: m,
            actual: deg,
            actualRoman: rom,
            prev2: prev2 || [null, null],
            prev3: prev3 || [null, null, null]
        };
        mpBuildErrorOptions();
        if (els.mpError) els.mpError.hidden = false;
    }

    function mpCloseError() {
        if (els && els.mpError) els.mpError.hidden = true;
    }

    // ---------------- 听辩辅助窗（长按 + 下滑） ----------------
    //   触发即暂停主音频 → 播冻结和弦的「和弦分解」→ 弹浮窗；
    //   浮窗里可重听柱式 / 再放一遍和弦分解；点窗外关闭并恢复播放。
    //   辅助窗不写任何统计（与报错浮窗的 practiceMode 闸门无关，错题模式也可用）。
    let mpAid = null;   // { measure, midis, sources: [], wasPlaying }
    // 最近一次 playInstantChord 的结果 { style, ok, ctxState, scheduled }。
    //   ok 为假 = 那一声"没能真正排上程/上下文没在跑"，pointerup 会拿它决定要不要补放。
    let mpAidLast = null;
    // 第十六轮：最近几次"点数字试听"的记录（环形，最多 12 条）。
    //   起因是用户反馈"快速连点两个音，会重复上一个音而不是新点的音"——
    //   无头浏览器里复现不了真机的触摸合成行为，所以留这个口子：
    //   真机上复现时读 ChordRecognition._getAidTapLog()，
    //   就能看清"到底收到了几个 pointerdown、midi 对不对、两次间隔多少毫秒"。
    let mpAidTapLog = [];

    async function mpOpenAid(frozen) {
        if (!frozen || frozen.seg !== mpSeg) return;      // 跨段快照作废
        const midis = (frozen.midis && frozen.midis.length)
            ? frozen.midis
            : ((data && data.chords[frozen.measure] || {}).midis);
        if (!midis || !midis.length) return;
        const wasPlaying = !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended);
        if (chordAudioEl && wasPlaying) { try { chordAudioEl.pause(); } catch (e) {} }
        mpSyncPlayIcon();                                  // pause 事件会同步，这里兜底
        mpAid = { measure: frozen.measure, midis: midis.slice(), sources: [], wasPlaying };
        mpPaintAidTones(frozen.measure);
        if (els && els.mpAid) els.mpAid.hidden = false;
        try { await playInstantChord(midis, 'arp'); } catch (e) {}   // 失败静默：浮窗仍在，可手点重放
    }

    // 和弦音角色 → 中文标注（chordToneSpelled 返回的是英文 role）
    const AID_ROLE_LABEL = { root: '根音', third: '三音', fifth: '五音', seventh: '七音' };

    // 辅助窗右侧那一列：**按音高自下而上**（最低音在最下）。
    //   ★ 第十六轮改（用户 2026-10-06）：
    //     主文字 = 该音在**调式内的级数**（简谱数字 1..7，**不带八度点** ——
    //              同一个音名的两个 C 都显示 1，这是用户明确要的）；
    //     副标注 = 它是**和弦的几音**（根音 / 三音 / 五音 / 七音）。
    //   DOM 里按"低音在前"追加，CSS 用 column-reverse 把它翻成自下而上 —— 顺序只有一处定义。
    //   ★ 每个音可点：点一下就发这个音高。
    //     数字不带八度（两个 1 音高不同），所以**只能按 data-midi 认音** ——
    //     notes 是 chords[m].midis.map(midiToSpelled) 来的（同序同长），下标一一对应，
    //     而 midiToSpelled 的结果里**不含 midi**，所以要按下标回到 midis 里取。
    function mpPaintAidTones(measure) {
        if (!els || !els.mpAidTones) return;
        els.mpAidTones.innerHTML = '';
        const c = (data && data.chords) ? data.chords[measure] : null;
        if (!c || !c.notes || !c.notes.length) return;
        const midis = (mpAid && mpAid.midis && mpAid.midis.length === c.notes.length)
            ? mpAid.midis
            : (c.midis || []);
        // 和弦各音的"角色"：直接复用 chordToneSpelled —— 它按调内级数推出和弦音，
        //   **转位天然正确**（角色由根音定义，跟哪个音落在低音无关）；四部重复音时
        //   同一个角色会出现两枚，这也是对的（和声学上就是重复了那个音）。
        const ct = (data && data.scale)
            ? chordToneSpelled(data.scale, c.degree, !!c.seventh)
            : [];
        c.notes.forEach((n, i) => {                   // notes 已按 MIDI 升序（低 → 高）
            const midi = midis[i];
            const pc = ((midi % 12) + 12) % 12;
            const k = (data && data.scale) ? data.scale.findIndex((s) => s.pc === pc) : -1;
            // 调内级数；万一碰上变化音（理论上不会），退回显示音名，不显示空白
            const digit = (k >= 0) ? String(k + 1) : pitchName(n.letter, n.acc);
            const t = ct.find((x) => x.pc === pc);
            const role = t ? (AID_ROLE_LABEL[t.role] || '') : '';

            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mp-aid__tone';
            b.dataset.midi = String(midi);            // ★ 点它发这个音（不能按数字 —— 两个 1 音高不同）
            b.dataset.digit = digit;
            b.dataset.role = role;
            const num = document.createElement('span');
            num.className = 'mp-aid__tone-num';
            num.textContent = digit;
            const label = document.createElement('span');
            label.className = 'mp-aid__tone-role';
            label.textContent = role;
            b.appendChild(num);
            b.appendChild(label);
            b.setAttribute('aria-label',
                pitchName(n.letter, n.acc) + ' · 第 ' + digit + ' 级 · ' + role + ' · 试听');
            els.mpAidTones.appendChild(b);
        });
    }

    function mpStopAidVoices() {
        if (!mpAid) return;
        mpAid.sources.forEach((s) => { try { s.stop(); } catch (e) {} });   // 已结束的 stop() 无害
        mpAid.sources = [];
    }

    // 关浮层后从第 m 小节重新起播（m < 0 忽略）。
    //   收口「报错窗提交 / 辅助窗关掉」两条恢复路径的起播点 —— 用户 2026-10-10 要求：
    //   从**按住时的那一个和弦**重新开始，而不是它前一个和弦、也不是在暂停点原地续播。
    //   ★ 必须在 mpCancelGesture() **之后**调用：unfreeze 会把 mpMeasure 拉回 mpLiveMeasure，
    //     而 setMeasureHighlight() 开头有 `if (m === highlightedMeasure) return;` ——
    //     重播的正好是当前已高亮那一小节时它会直接 return、不更新 mpLiveMeasure，
    //     于是"先起播后解冻"会被 unfreeze 覆盖回旧值（画面/进度环跳回去）。
    function mpResumeFromMeasure(m) {
        if (!(m >= 0)) return;
        doPlay(lastPlayMode, m);
    }

    // 用户主动关窗：停声 → 收浮窗 → 从"按住那一小节"重播 → 结束长按态（解冻）
    function mpCloseAid() {
        if (!mpAid) return;
        mpStopAidVoices();
        if (els && els.mpAid) els.mpAid.hidden = true;
        const was = mpAid.wasPlaying;
        const at = mpAid.measure;     // ★ 必须在 mpAid = null 之前取（关窗后的起播点）
        mpAid = null;
        mpAidLast = null;
        mpSyncPlayIcon();
        //   ★ 顺序：先解冻（此时 mpAid 已置空 → 不会走 mpCancelGesture 里那段兜底分支，不会递归），
        //     再起播。原先那句"原地 chordAudioEl.play()"已删 —— 留着会"先在暂停点响一下、
        //     随后 doPlay 再 seek 回本小节"，两声抢音。
        mpCancelGesture();
        if (was) mpResumeFromMeasure(at);
    }

    function mpReplayAid(style) {
        if (!mpAid) return;
        mpStopAidVoices();
        playInstantChord(mpAid.midis, style).catch(() => {});
    }

    // 点辅助窗右侧的某个简谱数字 → 只发这一个音高。
    //   ★ 刻意**不**先 mpStopAidVoices()：用户要的是"可以叠着响，像弹琴"——
    //     连着点几个音、或者两指同时按两个音，声音自然叠起来。
    //   （声源仍登记在 mpAid.sources 里，关窗时一次收干净；playInstantChord 内部有上限剪枝。）
    function mpPlayAidTone(midi) {
        if (!mpAid || !isFinite(midi)) return;
        playInstantChord([midi], 'note').catch(() => {});
    }

    // 上报「我听成了哪个级数」。guessed = null 表示"没听出来"。
    function mpSubmitReport(guessed) {
        if (!mpErrorCtx) { mpCloseError(); return; }
        const rec = {
            measure: mpErrorCtx.measure,
            actual: mpErrorCtx.actual,
            actualRoman: mpErrorCtx.actualRoman,
            // 前几个和弦（错误组合榜要用）—— 冻结进来时记的就是冻结点前面那几个
            prev2: mpErrorCtx.prev2 || [null, null],
            prev3: mpErrorCtx.prev3 || [null, null, null],
            guessed: (guessed == null ? null : guessed),
            guessedRoman: (guessed == null ? null : (DEGREE_CHOICES[guessed - 1] || null)),
            ts: Date.now()
        };
        mpReports.push(rec);
        if (mpReports.length > MP_REPORTS_MAX) mpReports.shift();
        recordReport(rec);            // 聚合统计（数据库页的数据源 + 出题加权的依据）
        mpCloseError();
        mpErrorCtx = null;
        try { console.log('[和弦听辨·报错]', rec); } catch (e) {}
        // ★ 报错提交后从**报错那一个和弦**的小节开头重新起播，播完自然继续往后。
        //   （用户 2026-10-10 改：原先是"提前一小节"重播 —— 先把出错和弦的前置语境给一遍；
        //     现在要求直接从出错的那一小节起，不再退到它前一个和弦。）
        //   doPlay 快路只是 seek，seeking 期间不会误计 heard；从 rec.measure 起播后，经过
        //   rec.measure → +1 的小节边界时会把 rec.measure 记一次 heard —— 它确实被完整
        //   重听了一遍，属可接受的计数。isRendering 中提交时 doPlay 会静默跳过本次重播。
        mpCancelGesture();            // 长按冻结/揭示态先解冻，再 seek（必须先解冻，理由见 mpResumeFromMeasure）
        if (!practiceMode) mpResumeFromMeasure(rec.measure);
    }

    // ============================================================
    // 错题练习模式（复用迷你播放器，正确率不计入数据库，不设报错）
    // ============================================================

    // ★ 用户 2026-10-07：上下手势对调（上滑=报错 / 下滑=辅助），提示文案跟着换。
    const MP_HINT_NORMAL = '按住看答案 · 按住上滑报错 · 按住下滑辅助 · 按住左/右滑上一个/下一个 · 顶行按钮切换谱表';
    const MP_HINT_PRACTICE = '错题练习：按住看答案 · 按住下滑辅助 · 按住左/右滑上一个/下一个 · 顶行按钮切换谱表（不计统计 · 无报错）';

    // 切换错题模式的 UI 痕迹：报错键 / 下滑手势 / 提示文案 / 收起条前缀 / 退出按钮
    function applyPracticeUi(on) {
        // 错题练习开关：恒显，靠 is-on 高亮 + 文案区分开/关
        if (els && els.mpExitPractice) {
            els.mpExitPractice.hidden = false;
            els.mpExitPractice.innerHTML = (on ? iconSvg('i-x') : iconSvg('i-target'))
                + (on ? '退出错题' : '错题练习');
            els.mpExitPractice.classList.toggle('is-on', !!on);
        }
        if (els && els.dbPractice) els.dbPractice.disabled = !!on;   // 错题中禁用数据库页入口（已在错题里）
        if (els && els.mpHint) els.mpHint.textContent = on ? MP_HINT_PRACTICE : MP_HINT_NORMAL;
        mpPaintProgress();
        updateHint();
    }

    // 进入错题练习：取错误组合榜前 5 → Ⅰ 胶水连播。
    //   统计闸门在 recordHeard / recordReport / mpOpenError / scheduleAutoNext 里。
    async function startPractice() {
        if (!topPracticeCombos(5).length) return false;
        mpCancelGesture();
        mpCloseError();
        mpSetExpanded(false);
        practiceMode = true;
        applyPracticeUi(true);
        await doGenerate(true);
        // 从数据库页切回主页（路由由 index.html 暴露；拿不到就留在原页，不影响练习）
        try {
            if (global.appRouter && global.appRouter.goHome) global.appRouter.goHome();
        } catch (e) {}
        mpSetExpanded(true);
        await doPlay(lastPlayMode, 0);
        return true;
    }

    // 退出错题练习：恢复正常出题（不自动播，和日常「下一首」的落点一致）
    async function exitPractice() {
        if (!practiceMode) return;
        practiceMode = false;
        applyPracticeUi(false);
        await doGenerate(false);
    }

    // ============================================================
    // 数据库页：把统计渲染成 DOM
    //   两个范围：「历史总计」/「本轮」；混淆矩阵用单色暖色深浅表示次数。
    // ============================================================

    let statsScope = 'all';       // 'all' = 历史总计 | 'session' = 本轮

    function currentStats() {
        return (statsScope === 'session') ? statsSession : statsAll;
    }

    function setStatsScope(scope) {
        statsScope = (scope === 'session') ? 'session' : 'all';
        if (els && els.dbScopeAll) els.dbScopeAll.classList.toggle('active', statsScope === 'all');
        if (els && els.dbScopeRound) els.dbScopeRound.classList.toggle('active', statsScope === 'session');
        renderStats();
    }

    // 混淆矩阵的深浅：1 / 2~4 / 5+ 三档暖色（不是纯红 —— 小面积数字上用纯红对比度差）
    const DB_HEAT = [
        { min: 0, bg: '#f4f5f8', fg: 'transparent' },
        { min: 1, bg: '#faece7', fg: '#4a1b0c' },
        { min: 2, bg: '#f5c4b3', fg: '#4a1b0c' },
        { min: 5, bg: '#f0997b', fg: '#4a1b0c' }
    ];

    function heatFor(n) {
        let pick = DB_HEAT[0];
        for (let i = 0; i < DB_HEAT.length; i++) {
            if (n >= DB_HEAT[i].min) pick = DB_HEAT[i];
        }
        return pick;
    }

    // 级数色块（用全站唯一色板，和锁屏封面 / 面板大图 / 报错浮窗同源）
    function makeChip(d) {
        const el = document.createElement('span');
        el.className = 'db-chip';
        if (d == null || d === 0) {
            el.textContent = (d === 0) ? '？' : '—';
            el.style.background = '#f4f5f8';
            el.style.color = 'var(--text-tertiary)';
            return el;
        }
        el.textContent = DEGREE_CHOICES[d - 1] || String(d);
        paintDegreeChip(el, d);
        return el;
    }

    function makeMatrixCell(rowDeg, colDeg, n) {
        const el = document.createElement('div');
        el.className = 'db-matrix__cell';
        const h = heatFor(n);
        el.style.background = h.bg;
        if (n > 0) {
            el.textContent = String(n);
            el.style.color = h.fg;
        } else if (rowDeg === colDeg) {
            // 对角线（听成自己）理论上永远是 0 —— 给个淡淡的点方便定位
            el.textContent = '·';
            el.style.color = '#d3d7e2';
        } else {
            el.textContent = '';
        }
        el.title = DEGREE_CHOICES[rowDeg - 1] + ' → ' +
            (colDeg === 0 ? '没听出来' : DEGREE_CHOICES[colDeg - 1]) + '：' + n + ' 次';
        return el;
    }

    function emptyLine(text) {
        const el = document.createElement('div');
        el.className = 'db-empty';
        el.textContent = text;
        return el;
    }

    function renderStats() {
        init();      // 保证 els / 统计都已就绪（理论上首屏已经进过和弦页，这里只是兜底）
        if (!els || !els.dbMatrix) return;
        const s = currentStats();

        // ---- 三张汇总卡 ----
        const reports = s.totals.reports || 0;
        const heard = s.totals.heard || 0;
        if (els.dbTotalWrong) els.dbTotalWrong.textContent = String(reports);
        if (els.dbTotalHeard) els.dbTotalHeard.textContent = String(heard);
        if (els.dbWrongRate) {
            els.dbWrongRate.textContent = (heard > 0)
                ? (Math.round(reports / heard * 1000) / 10) + '%'
                : '—';
        }
        if (els.dbScopeAll) els.dbScopeAll.classList.toggle('active', statsScope === 'all');
        if (els.dbScopeRound) els.dbScopeRound.classList.toggle('active', statsScope === 'session');

        // ---- 混淆矩阵：7 行（实际）× (7 列 + 1 列"没听出来") ----
        els.dbMatrix.innerHTML = '';
        const corner = document.createElement('div');
        corner.className = 'db-matrix__head';
        els.dbMatrix.appendChild(corner);
        for (let c = 1; c <= 7; c++) {
            const h = document.createElement('div');
            h.className = 'db-matrix__head';
            h.textContent = DEGREE_CHOICES[c - 1];
            els.dbMatrix.appendChild(h);
        }
        const hNone = document.createElement('div');
        hNone.className = 'db-matrix__head';
        hNone.textContent = '没听出';
        els.dbMatrix.appendChild(hNone);

        for (let r = 1; r <= 7; r++) {
            const lab = document.createElement('div');
            lab.className = 'db-matrix__rowlabel';
            lab.textContent = DEGREE_CHOICES[r - 1];
            els.dbMatrix.appendChild(lab);
            const row = s.confusion[String(r)] || {};
            for (let c = 1; c <= 7; c++) {
                els.dbMatrix.appendChild(makeMatrixCell(r, c, row[String(c)] || 0));
            }
            els.dbMatrix.appendChild(makeMatrixCell(r, 0, row['0'] || 0));
        }

        // ---- 最常混淆 Top 8 ----
        const pairs = [];
        Object.keys(s.confusion).forEach((a) => {
            const row = s.confusion[a] || {};
            Object.keys(row).forEach((g) => {
                const n = row[g] || 0;
                if (n > 0) pairs.push({ a: parseInt(a, 10), g: parseInt(g, 10), n: n });
            });
        });
        pairs.sort((x, y) => y.n - x.n);
        if (els.dbTop) {
            els.dbTop.innerHTML = '';
            if (!pairs.length) {
                els.dbTop.appendChild(emptyLine('还没有报错记录 —— 练习时按住级数图、往上滑即可报错'));
            } else {
                pairs.slice(0, 8).forEach((p) => {
                    const row = document.createElement('div');
                    row.className = 'db-row';
                    row.appendChild(makeChip(p.a));
                    const ar = document.createElement('span');
                    ar.className = 'db-arrow';
                    ar.textContent = '→';
                    row.appendChild(ar);
                    row.appendChild(makeChip(p.g));
                    const meta = document.createElement('span');
                    meta.className = 'db-row__meta';
                    meta.textContent = p.n + ' 次';
                    row.appendChild(meta);
                    els.dbTop.appendChild(row);
                });
            }
        }

        // ---- 错误组合榜 Top 10（长度 2~4 混排，方向性：逆向 ≠ 正向）----
        const combos = [];
        Object.keys(s.combos).forEach((k) => {
            const v = s.combos[k];
            if (v && v.wrong > 0) {
                combos.push({
                    d: k.split('|').map((x) => parseInt(x, 10)),
                    seen: v.seen || 0,
                    wrong: v.wrong
                });
            }
        });
        combos.sort((x, y) => (y.wrong - x.wrong) || (y.seen - x.seen));
        if (els.dbCombos) {
            els.dbCombos.innerHTML = '';
            if (!combos.length) {
                els.dbCombos.appendChild(emptyLine('还没有数据 —— 报错时会把它前面的和弦一起记进组合（按时间顺序，逆向 ≠ 正向）'));
            } else {
                combos.slice(0, 10).forEach((c) => {
                    const row = document.createElement('div');
                    row.className = 'db-row';
                    c.d.forEach((d, i) => {
                        if (i > 0) {
                            const ar = document.createElement('span');
                            ar.className = 'db-arrow';
                            ar.textContent = '→';
                            row.appendChild(ar);
                        }
                        row.appendChild(makeChip(d));
                    });
                    const meta = document.createElement('span');
                    meta.className = 'db-row__meta';
                    const rate = (c.seen > 0) ? Math.round(c.wrong / c.seen * 100) : null;
                    meta.textContent = '错 ' + c.wrong + ' 次 · 出现 ' + c.seen + ' 次' +
                        (rate == null ? '' : ' · ' + rate + '%');
                    row.appendChild(meta);
                    els.dbCombos.appendChild(row);
                });
            }
        }

        // ---- 错题练习入口：有没有可练的组合决定按钮态 ----
        if (els.dbPractice) {
            const list = topPracticeCombos(5);
            els.dbPractice.disabled = (list.length === 0);
            if (els.dbPracticeStatus) {
                els.dbPracticeStatus.textContent = list.length
                    ? '已攒到 ' + list.length + ' 组常错的组合（错 ≥2 次）—— 用 Ⅰ 级和弦串起来连着练，不计入统计'
                    : '还没有可练的错题 —— 同一个组合错够 2 次就会出现在这里';
            }
        }
    }

    // ------------------------------------------------------------
    // 对外接口
    // ------------------------------------------------------------

    let inited = false;

    function init() {
        if (inited) return;
        cacheEls();
        loadSettings();
        loadStats();
        buildDegreeGrid();
        bindUI();
        updateHint();
        inited = true;
    }

    function activate() {
        init();
        if (!data) {
            // 首次进入：直接给一段，省得用户先点一下
            doGenerate(true);
        }
    }

    function deactivate() {
        // 播放器是常驻的（切到数据库页也在）→ **不收起面板**，用户随时能接着操作。
        //   但要停住声音：既避免"看不见控制却还在响"，也免得在数据库页被自动连播换了段。
        cancelAutoNext();
        stopChordPlayback();
        mpCancelGesture();
        mpCloseError();
        if (statsFlushTimer) flushStats();   // 离开时把统计补一次盘（debounce 可能还没到）
        // 离开和弦页就把媒体会话交还（不然人在视唱页、锁屏按播放会去动和弦那段音频）
        const host = global.ChordHost;
        if (host && host.reclaimMedia) host.reclaimMedia(null, null);
    }

    global.ChordRecognition = {
        init,
        activate,
        deactivate,
        generate: () => doGenerate(false),
        play: doPlay,
        // 便于调试 / 自测
        _generateChordProgression: generateChordProgression,
        _getSettings: () => settings,
        // 错题练习（调试 / 自测 / 数据库页入口）
        startPractice,
        exitPractice,
        _isPracticeMode: () => practiceMode,
        _topPracticeCombos: (n) => topPracticeCombos(n || 5),
        _buildPracticeSequence: buildPracticeSequence,
        _generateProgressionFromSequence: generateProgressionFromSequence,
        _buildScale: buildScale,
        _buildCandidates: buildCandidates,
        _chordToneSpelled: chordToneSpelled,
        _doubledToneIndex: doubledToneIndex,
        _buildFourPartCandidates: buildFourPartCandidates,
        _fourPartCost: fourPartCost,
        _chooseFourPartVoicing: chooseFourPartVoicing,
        _hasParallel: hasParallel,
        _hasOverlap: hasOverlap,
        _innerLeapOk: innerLeapOk,
        _voiceMotionCost: voiceMotionCost,
        _inStandardRange: inStandardRange,
        _repairFourPartOverlaps: repairFourPartOverlaps,
        _getFourPartStats: () => FOURPART_STATS,
        _FOUR_RANGES: FOUR_RANGES,
        _getSheetState: () => ({
            rects: measureRects.length,
            highlighted: highlightedMeasure,
            lastPlayMode: lastPlayMode,
            geom: sheetGeom.length,
            hasBlob: !!blobData,
            blobMode: blobMode,
            currentTime: chordAudioEl ? chordAudioEl.currentTime : null,
            paused: chordAudioEl ? chordAudioEl.paused : null,
            measureDuration: measureDuration()
        }),
        _setMeasureHighlight: setMeasureHighlight,
        _measureDuration: measureDuration,
        // 播放排程（调试 / 自测用）：随身听模式动到的就是它 —— 末拍该出现几个音、是哪个音。
        //   第二个参数可传入一段 progression（Node 里没有 DOM，data 是空的，靠它测）。
        _getSchedule: (mode, prog) => {
            const p = prog || data;
            if (!p) return [];
            return buildChordSchedule(p.chords, settings.tempo, mode, {
                scale: p.scale, portable: !!settings.portable
            });
        },
        _chordRootMidi: (m) => ((data && data.chords[m]) ? chordRootMidi(data.chords[m], data.scale) : null),
        // 当前这段的极简快照（调内各级 pc + 每小节的级数与音）：供自测独立验证"根音对不对"
        _getDataBrief: () => (data ? {
            key: data.key,
            scalePc: data.scale.map((s) => s.pc),
            chords: data.chords.map((c) => ({ degree: c.degree, inversion: c.inversion, midis: c.midis.slice() }))
        } : null),
        _getAudioEl: () => chordAudioEl,
        _getBlobUrl: () => blobUrl,
        // 自动连播（调试 / 自测用）
        _getAutoState: () => ({
            autoContinue: settings.autoContinue,
            timerPending: !!autoTimer,
            breakGen: autoBreak,
            running: autoRunning,
            chains: autoStats.chains,
            gapMs: AUTO_CONTINUE_GAP_MS,
            progressRaf: progressRaf
        }),
        _cancelAutoNext: cancelAutoNext,
        _scheduleAutoNext: scheduleAutoNext,
        _getCheckBox: () => els.autoContinue,   // 名字沿用（老的验收脚本在用）；现在返回的是那颗 switch 按钮
        _syncToggles: syncTogglePills,
        // 锁屏封面（调试 / 自测用）
        _artSupported: artSupported,
        _buildChordArtwork: buildChordArtwork,
        _getArtwork: () => artCache,
        _getArtUrls: () => artUrls.slice(),
        _getArtImages: () => artImages.slice(),
        _getPendingArtPush: () => pendingArtPush,
        _artReleaseDelayMs: ART_RELEASE_DELAY_MS,
        _releaseChordArtwork: releaseChordArtwork,
        _updateNowPlaying: updateNowPlaying,
        _skipMeasure: (dir) => chordMediaHooks.skip(dir),
        _drawCover: drawCover,
        _romanParts: romanParts,
        _getNowPlayingTitle: (m) => {
            if (!data || m < 0 || m >= data.chords.length) return null;
            return '第 ' + (m + 1) + ' 小节 · ' + data.chords[m].roman;
        },
        _buildChordSchedule: buildChordSchedule,
        _renderChordAudio: renderChordAudio,
        _resolveSample: resolveSample,
        _getSettings: () => settings,
        _getLastData: () => data,
        // ---- 封面提前量（调试 / 自测用）----
        _getCoverMeasure: () => coverMeasure,
        _getArtLeadMs: () => ART_LEAD_MS,
        _setArtLeadMs: (v) => { ART_LEAD_MS = Math.max(0, Number(v) || 0); coverMeasure = -1; },
        _setCoverMeasure: setCoverMeasure,
        // ---- 底部迷你播放器（调试 / 自测用）----
        _getReports: () => mpReports,
        _clearReports: () => { mpReports = []; },
        _getMpState: () => ({
            measure: mpMeasure,
            liveMeasure: mpLiveMeasure,
            expanded: mpExpanded,
            revealing: mpRevealing,
            frozen: !!mpFreeze,
            freezeMeasure: mpFreeze ? mpFreeze.measure : -1,
            freezeDegree: mpFreeze ? mpFreeze.degree : null,
            gesturePhase: mpGesture ? mpGesture.phase : null,
            gestureAxis: mpGesture ? mpGesture.axis : null,
            playing: !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended),
            // 第十六轮：暂停态切过和弦后"待重定位到的小节"（-1 = 没有）
            pauseJumpTo: mpPauseJumpTo,
            errorOpen: !!(els && els.mpError && !els.mpError.hidden),
            aidOpen: !!(els && els.mpAid && !els.mpAid.hidden),
            reportCount: mpReports.length
        }),
        _setMpExpanded: mpSetExpanded,
        _setMpStageView: mpSetStageView,
        _getMpStageView: () => mpStageView,
        _setMpMeasure: (m) => { mpMeasure = m; mpOnMeasure(m); },
        _setMpRevealed: mpSetRevealed,
        _openMpError: mpOpenError,
        _closeMpError: mpCloseError,
        _openMpAid: mpOpenAid,
        // 直接对第 m 小节开辅助窗（跳过"长按+下滑"手势，供自测用）
        _openMpAidAt: (m) => {
            if (!data || !data.chords[m]) return null;
            const chord = data.chords[m];
            return mpOpenAid({
                seg: mpSeg, measure: m,
                midis: chord.midis || [],
                info: buildCoverInfo(m)
            });
        },
        _closeMpAid: mpCloseAid,
        // 辅助窗右侧那一列音名（DOM 顺序 = 低音在前；画面上靠 column-reverse 自下而上）
        _getAidTones: () => (els && els.mpAidTones
            ? Array.from(els.mpAidTones.children).map((n) => n.textContent)
            : null),
        _getAidToneLayout: () => (els && els.mpAidTones
            ? getComputedStyle(els.mpAidTones).flexDirection
            : null),
        // 音名各自绑的 midi（点它发哪个音）—— 用于断言"音高是按 data-midi 认的，不是按音名"
        _getAidToneMidis: () => (els && els.mpAidTones
            ? Array.from(els.mpAidTones.children).map((n) => n.dataset.midi)
            : null),
        // 第十六轮：每个按钮的「简谱数字 + 几音标注」全貌
        _getAidToneInfo: () => (els && els.mpAidTones
            ? Array.from(els.mpAidTones.children).map((n) => ({
                midi: n.dataset.midi, digit: n.dataset.digit, role: n.dataset.role,
                text: n.textContent, aria: n.getAttribute('aria-label')
            }))
            : null),
        // 第十六轮：最近几次"点数字试听"的记录（真机上复现"连点重复上一个音"时读它）
        _getAidTapLog: () => mpAidTapLog.slice(),
        // 辅助窗音频状态：上下文跑没跑起来、这一声排上程没有（"有声"最接近的可断言代理）
        _getAidAudio: () => ({
            open: !!mpAid,
            midis: mpAid ? mpAid.midis.slice() : null,
            voices: mpAid ? mpAid.sources.length : 0,
            ctx: (global.ChordHost && global.ChordHost.audioContext)
                ? global.ChordHost.audioContext.state : null,
            last: mpAidLast ? Object.assign({}, mpAidLast) : null
        }),
        // 收起条播放键的外圈进度（方案 B）
        _getRingDashoffset: () => (els && els.mpRingBar ? els.mpRingBar.style.strokeDashoffset : null),
        // 自测用：整段音频的播放位置 / 总时长（证明进度环是"按时间连续"的，而不是按小节跳的）。
        //   注意：**别**为了造样本去给 currentTime 赋值 —— 那会触发 timeupdate，
        //   反过来把高亮改掉；要样本就让音频真播着，隔一会儿读两次。
        _getAudioClock: () => (chordAudioEl
            ? { t: chordAudioEl.currentTime, d: chordAudioEl.duration, paused: chordAudioEl.paused }
            : null),
        // 第十六轮：音频自愈相关的两个口子
        //   _unlockAudioNow：手动唤醒上下文（验收用；也可以在真机控制台里敲）
        //   _reloadSamples：宿主重建 AudioContext 后，bufferCache 被清空 → 由这里重新解码
        _unlockAudioNow: unlockAudioNow,
        _reloadSamples: () => preloadChordSamples(() => {}),
        // ---- 听辨统计 / 数据库页（调试 / 自测用）----
        renderStats: renderStats,
        _getStats: () => ({ all: statsAll, session: statsSession, scope: statsScope }),
        _setStats: (which, obj) => {
            const v = normalizeStats(obj);
            if (which === 'session') statsSession = v; else statsAll = v;
            renderStats();
        },
        _clearStats: (which) => {
            if (which === 'session' || which === 'all') {
                if (which === 'session') statsSession = emptyStats(); else statsAll = emptyStats();
            } else {
                statsAll = emptyStats();
                statsSession = emptyStats();
            }
            renderStats();
            flushStats();
        },
        _flushStats: flushStats,
        _setStatsScope: setStatsScope,
        _recordHeard: recordHeard,
        _computeReport: (rec) => { recordReport(rec); flushStats(); },
        // 出题加权（调试 / 自测用）
        _degreeWeight: (d) => degreeWeight(d, mergedCounts()),
        _mergedCounts: () => mergedCounts(),
        _ADAPT: () => ({
            p0: ADAPT_P0, k: ADAPT_K, gain: ADAPT_GAIN, wmin: ADAPT_WMIN, wmax: ADAPT_WMAX
        }),
        _getMpErrorOptions: () => {
            if (!els || !els.mpErrorGrid) return [];
            const out = [];
            els.mpErrorGrid.querySelectorAll('[data-degree]').forEach((b) => {
                out.push(parseInt(b.dataset.degree, 10));
            });
            return out;
        },
        _getCoverInfo: buildCoverInfo,
        // 验收用：把"这个和弦的音各自是几音（root/third/fifth/seventh）"算出来对账
        //   （辅助窗那个「根音/三音/五音/七音」小标签的来源就是它）
        _chordToneSpelled: chordToneSpelled,
        _getArtPalette: () => ART_PALETTE.map((p) => ({ top: p.top, bottom: p.bottom, ink: p.ink, sub: p.sub })),
        // 报错浮窗的几何布局：每个色块的中心坐标 + 尺寸（用来客观验证"两列 + Ⅶ 横跨"）
        _getMpErrorLayout: () => {
            if (!els || !els.mpErrorGrid) return null;
            const grid = els.mpErrorGrid.getBoundingClientRect();
            const items = [];
            els.mpErrorGrid.querySelectorAll('button[data-degree]').forEach((b) => {
                const r = b.getBoundingClientRect();
                items.push({
                    degree: parseInt(b.dataset.degree, 10),
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                    color: getComputedStyle(b).color,
                    bg: getComputedStyle(b).backgroundImage
                });
            });
            return { gridW: Math.round(grid.width), items: items };
        }
    };

})(typeof window !== 'undefined' ? window : this);
