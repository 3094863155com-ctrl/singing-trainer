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
    // 每个和弦音"按住"的时长 = 一拍 × legato。钢琴采样本身就在自然衰减，
    // 只要不人为把它压下去，按住就能得到连贯的声音。
    //   0.4  ≈ 断奏（弹一下就松手，短促）
    //   1.0  ≈ 连奏（按满一拍，到下一拍才换）★ 默认
    //   1.4  ≈ 更连贯（越过下一拍，相邻和弦轻微叠在一起，像踩了延音踏板）
    const LEGATO_MIN = 0.35;
    const LEGATO_MAX = 1.40;
    const LEGATO_DEFAULT = 1.00;
    const CHORD_RELEASE = 0.12;   // 松手淡出时长（秒），避免"咔"的切断声

    function clampLegato(v) {
        const n = parseFloat(v);
        if (!isFinite(n)) return LEGATO_DEFAULT;
        return Math.min(LEGATO_MAX, Math.max(LEGATO_MIN, n));
    }

    function legatoWord(v) {
        const n = clampLegato(v);
        if (n < 0.75) return '断奏';
        if (n > 1.15) return '更连贯';
        return '连奏';
    }

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
        // 自动连播：一段播完 → 停约 1.5 秒 → 自动换新的一段（调性重新随机）接着播，无限进行。
        // 任何手动操作（停止 / 播放 / 换一段 / 点小节 / 改参数 / 切视图）都会打断接力。
        autoContinue: false,
        legato: LEGATO_DEFAULT,
        // 参与的级数（Ⅰ 永远参与，端点强制）
        degrees: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
        // 各级出现七和弦的概率（%）
        seventhProb: { 1: 0, 2: 40, 3: 0, 4: 10, 5: 70, 6: 0, 7: 30 },
        // 「使用用户数据优化题库」：按历史错误率给级数加权出题。
        //   默认 false —— 关着的时候出题路径与以前**逐字节一致**（回归脚本靠这条）。
        //   打开后错得多的级数出现概率更高，正确率回升就自动降回基线。见 degreeWeight()。
        adaptiveFromStats: false
    };

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
        const lastRowHeight = fourPart ? 220 : 130;
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

            // 大括号 + 左侧竖线：只在每行第一个小节画一次
            if (isFirstInLine) {
                try {
                    const brace = new Vex.StaveConnector(treble, bass);
                    brace.setType(Vex.StaveConnector.type.BRACE);
                    brace.setContext(ctx).draw();
                } catch (e) { /* 括号画不出不影响出谱 */ }
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
                // 带高 = 覆盖该行谱表 + 罗马数字标注；约束 < lineHeight 以免相邻行重叠
                const bandTop = fourPart ? -22 : -18;
                const bandH = fourPart ? 200 : 116;
                for (let m = 0; m < totalMeasures; m++) {
                    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    r.setAttribute('x', String(geom[m].x));
                    r.setAttribute('y', String(geom[m].y + bandTop));
                    r.setAttribute('width', String(geom[m].staveWidth));
                    r.setAttribute('height', String(bandH));
                    r.setAttribute('fill', '#d97706');
                    r.setAttribute('fill-opacity', '0');
                    r.setAttribute('pointer-events', 'all');
                    r.setAttribute('style', 'cursor:pointer');
                    r.dataset.measure = String(m);
                    hitSvg.appendChild(r);
                    measureRects.push(r);
                }
                // 重绘不丢状态：若正在播放，把高亮恢复回去
                if (highlightedMeasure >= 0 && highlightedMeasure < measureRects.length) {
                    measureRects[highlightedMeasure].setAttribute('fill-opacity', '0.14');
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
                        requestAnimationFrame(() => {
                            if (window.innerWidth > 768) { svgEl.style.height = ''; return; }
                            const w = svgEl.getBoundingClientRect().width;
                            if (w > 0) svgEl.style.height = (w * vbH / vbW) + 'px';
                        });
                    }
                }
            }
        } catch (err) {
            console.error('和弦谱面渲染出错:', err);
            container.innerHTML = `<div style="color:red;padding:20px;">五线谱渲染出错: ${err.message}</div>`;
        }
    }

    // ------------------------------------------------------------
    // 音频：时间表 / 采样解析 / 离线混音
    // ------------------------------------------------------------

    // 一小节 1 个和弦，每拍弹 1 下（四分音符柱式）
    // 播放排程
    //   mode 'block'     柱式：一小节 4 拍，每拍 1 下（各声部同时发声）—— 原有行为，默认值
    //   mode 'arpeggio'  分解：一小节 16 个十六分音符，和弦音（低→高）循环滚动
    //   mode 'bass'      单音：每小节只弹一次最低音，长音铺满整小节
    // 事件结构 { time, midis, dur }；分解/单音会额外带 hold / gain，用来覆盖包络默认值。
    function buildChordSchedule(chords, tempo, mode) {
        mode = mode || 'block';
        const beatDur = 60 / tempo;
        const events = [];

        for (let m = 0; m < chords.length; m++) {
            const chord = chords[m];
            const base = m * 4 * beatDur;

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
                for (let k = 0; k < 16; k++) {
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
            } else if (mode === 'bass') {
                events.push({
                    time: base,
                    midis: [chord.midis[0]],          // midis 升序 → [0] 就是最低音
                    dur: 4 * beatDur                  // 长音＝整小节；hold 交给 legato 决定
                });
            } else {
                for (let b = 0; b < 4; b++) {
                    // 保持原来的表达式写法（不做 base + b*beat 的等价重构）：
                    // 浮点下两者会有末位差异，这里是"原行为逐字节不变"的保险。
                    events.push({
                        time: (m * 4 + b) * beatDur,
                        midis: chord.midis,
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

    async function renderChordAudio(chords, tempo, onProgress, mode) {
        mode = mode || 'block';
        const report = (t) => { if (onProgress) onProgress(t); };
        const host = global.ChordHost;
        if (!host) throw new Error('音频桥接不可用');

        report('构建时间表…');
        const events = buildChordSchedule(chords, tempo, mode);

        const legato = clampLegato(settings.legato);
        // 事件自带 hold 时用它（分解模式固定一拍），否则按连奏滑杆算 —— 柱式/单音行为不变
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
        for (const e of events) {
            const g = (e.gain != null) ? e.gain : 1.0;
            for (const midi of e.midis) {
                const s = resolveSample(midi);
                if (!s) { missing++; continue; }

                const src = offlineCtx.createBufferSource();
                src.buffer = s.buffer;
                src.playbackRate.value = s.rate;

                const gain = offlineCtx.createGain();
                src.connect(gain);
                gain.connect(offlineCtx.destination);

                // 连奏包络：4ms 起音 → 按住（hold）→ 短淡出。
                // 注意：这里**不再**人为做指数衰减 —— 之前的写法把这颗音从 0dB 强压到 -80dB，
                // 比钢琴自身的衰减快十几倍，听着就是"弹一下就没了"。现在让采样自己衰减。
                const t = e.time;
                const hold = holdOf(e);           // 按住多久（秒）
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(g, t + 0.004);
                gain.gain.setValueAtTime(g, t + hold);
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
        if (typeof s.adaptiveFromStats === 'boolean') settings.adaptiveFromStats = s.adaptiveFromStats;
        if (s.legato !== undefined) settings.legato = clampLegato(s.legato);
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
    let chordAudioEl = null;
    let blobUrl = null;
    let isRendering = false;

    // ---- 谱面点击跳转播放 + 播放位置高亮 ----
    //   音频是"整段离线渲染成一个 WAV"，所以"点某个小节"本质上就是给进度条设时间
    //   （audioEl.currentTime），不需要重新渲染。
    let sheetGeom = [];           // 每小节的几何（由 renderChordSheet 落盘）
    let measureRects = [];        // 每小节的命中/高亮 <rect>
    let highlightedMeasure = -1;  // 当前高亮的小节索引（-1 = 无）
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
    let mpExpanded = false;       // 展开中？
    let mpRevealing = false;      // 是否处于"按住揭示"（默认遮住，按住才显示）
    let mpFreeze = null;          // 长按那一刻的冻结快照（null = 未冻结）
    let mpSeg = 0;                // 段落代数：doGenerate 时 +1（防止冻结跨段串号）
    let mpGesture = null;         // 长按手势记录（null = 无手势）
    let mpReports = [];           // 报错明细（内存，上限 MP_REPORTS_MAX；聚合统计另有持久化）
    let mpErrorCtx = null;        // 报错浮窗那一刻的快照，防作答时小节已漂移
    // 「换一段」之后要不要顺手接着播？迷你播放器的定位是连续刷题 → 默认接着播。
    // 想让它跟页面上那颗「🎲 换一段」一样"只生成不播"，把这个常量改成 false 即可。
    const MP_AUTOPLAY_AFTER_GENERATE = true;

    // ---- 长按手势的旋钮（手感全靠这几个数）----
    const MP_HOLD_MS = 160;       // 按住多久算"长按"（到点才揭示答案，防误触剧透）
    const MP_SLOP_PX = 12;        // 长按阈值到达前的容差：超过就当成滑动/误触，取消本次
    const MP_DOWN_PX = 56;        // 按住之后往下滑多少算"要报错"
    const MP_LEFT_PX = 48;        // 按住之后往左滑多少算"回上一个和弦"（可连滑多次）
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
            legato: document.getElementById('chord-legato'),
            legatoVal: document.getElementById('chord-legato-val'),
            legatoWord: document.getElementById('chord-legato-word'),
            generate: document.getElementById('chord-generate'),
            voicingMode: document.getElementById('chord-voicing-mode'),
            play: document.getElementById('chord-play'),
            playArp: document.getElementById('chord-play-arpeggio'),
            playBass: document.getElementById('chord-play-bass'),
            stop: document.getElementById('chord-stop'),
            autoContinue: document.getElementById('chord-auto-continue'),
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
            mpBarTitle: document.getElementById('chord-mp-bar-title'),
            mpGenerateMin: document.getElementById('chord-mp-generate-min'),
            mpSheet: document.getElementById('chord-mp-sheet'),
            mpClose: document.getElementById('chord-mp-close'),
            mpPlayPause: document.getElementById('chord-mp-playpause'),
            mpStage: document.getElementById('chord-mp-stage'),
            mpCover: document.getElementById('chord-mp-cover'),
            mpCoverHidden: document.getElementById('chord-mp-cover-hidden'),
            mpPrev: document.getElementById('chord-mp-prev'),
            mpReport: document.getElementById('chord-mp-report'),
            mpNext: document.getElementById('chord-mp-next'),
            mpNote: document.getElementById('chord-mp-report-note'),
            mpGenerate: document.getElementById('chord-mp-generate'),
            mpExitPractice: document.getElementById('chord-mp-exit-practice'),
            mpHint: document.getElementById('chord-mp-hint'),
            mpError: document.getElementById('chord-mp-error'),
            mpErrorGrid: document.getElementById('chord-mp-error-grid'),
            mpErrorNone: document.getElementById('chord-mp-error-none'),
            mpErrorCancel: document.getElementById('chord-mp-error-cancel'),
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
            measureRects[m].setAttribute('fill-opacity', '0.14');
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
        const dur = measureDuration();
        const last = data.chords.length - 1;
        // 页面高亮：精确跟随（不提前）
        const m = Math.min(last, Math.floor(chordAudioEl.currentTime / dur));
        setMeasureHighlight(m);
        // 锁屏封面：带一点提前量（见 ART_LEAD_MS），把系统侧那几十毫秒的滞后补回来
        const mc = Math.min(last, Math.floor((chordAudioEl.currentTime + coverLeadSeconds()) / dur));
        setCoverMeasure(mc);
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
        showAutoInfo('🔁 自动连播：马上换新的一段…');
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

    function showAutoInfo(text) {
        if (!els.renderInfo) return;
        els.renderInfo.style.display = 'block';
        els.renderInfo.textContent = text;
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
    function drawCover(g, size, info, compact) {
        const pal = ART_PALETTE[(info.degree - 1) % ART_PALETTE.length];
        const grad = g.createLinearGradient(0, 0, 0, size);
        grad.addColorStop(0, pal.top);
        grad.addColorStop(1, pal.bottom);
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);

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
        return {
            degree: c.degree,
            roman: c.roman,
            base: parts.base,
            parts: parts,
            tones: c.notes.map((n) => pitchName(n.letter, n.acc)).join('  '),
            footer: data.key + ' 大调 · ' + ((data.voicingMode === 'fourpart') ? '四部和声' : '三和弦'),
            pos: (m + 1) + ' / ' + data.chords.length
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
    const chordMediaHooks = {
        skip: (dir) => {
            if (!data || !chordAudioEl) return false;
            mpCancelGesture();              // 显式导航 = 手势结束（含解冻）
            const cur = Math.max(0, Math.floor(chordAudioEl.currentTime / measureDuration()));
            const next = Math.min(data.chords.length - 1, Math.max(0, cur + dir));
            if (next === cur) return true;      // 已在头/尾，照样吃掉这次点击
            doPlay(lastPlayMode, next);
            return true;
        }
    };

    function setPlayButtonsEnabled(on) {
        const btns = [els.play, els.playArp, els.playBass];
        for (let i = 0; i < btns.length; i++) {
            if (btns[i]) btns[i].disabled = !on;
        }
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
        mpSetNote('');                  // 上一段的报错提示也清掉
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
        if (!data || !data.chords.length || isRendering) return;
        if (!auto) cancelAutoNext();   // 用户手动播放 / 点小节 → 作废在途的自动接力
        const host = global.ChordHost;
        if (!host) { renderInfoText('音频桥接不可用', true); return; }

        lastPlayMode = mode;   // 记住这次用的播放方式 —— 点谱面小节时会沿用它

        // ★ 移动端必需：在用户手势内解锁音频上下文
        try {
            await host.initAudio();
            if (host.audioContext && host.audioContext.state === 'suspended') {
                host.audioContext.resume();
            }
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

        // 连奏程度：只影响"弹"，不需要重新生成（改完直接再点播放即可）
        if (els.legato) {
            els.legato.value = String(Math.round(settings.legato * 100));
            if (els.legatoVal) els.legatoVal.textContent = settings.legato.toFixed(1);
            if (els.legatoWord) els.legatoWord.textContent = legatoWord(settings.legato);
            els.legato.addEventListener('input', (e) => {
                settings.legato = clampLegato(parseInt(e.target.value, 10) / 100);
                if (els.legatoVal) els.legatoVal.textContent = settings.legato.toFixed(1);
                if (els.legatoWord) els.legatoWord.textContent = legatoWord(settings.legato);
                saveSettings();
                invalidateRenderedAudio('连奏已改为 ' + settings.legato.toFixed(1) + '×，点播放键重新渲染');
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

        if (els.generate) els.generate.addEventListener('click', () => doGenerate(false));
        if (els.play) els.play.addEventListener('click', () => doPlay('block', 0));
        if (els.playArp) els.playArp.addEventListener('click', () => doPlay('arpeggio', 0));
        if (els.playBass) els.playBass.addEventListener('click', () => doPlay('bass', 0));

        // 🔁 自动连播：一段播完 → 停一下 → 自动换新的一段接着播
        if (els.autoContinue) {
            els.autoContinue.checked = settings.autoContinue;
            els.autoContinue.addEventListener('change', (e) => {
                settings.autoContinue = e.target.checked;
                saveSettings();
                if (!settings.autoContinue) {
                    cancelAutoNext();
                    showAutoInfo('已关闭自动连播');
                }
            });
        }

        if (els.stop) {
            els.stop.addEventListener('click', () => {
                cancelAutoNext();   // 用户按停止 → 一定打断自动连播（含"正在准备下一段"那一步）
                stopChordPlayback();
                if (els.renderInfo) { els.renderInfo.textContent = '已停止'; }
            });
        }

        // 点击谱面上的小节 → 从该小节开头播放（沿用上次按的那个播放键）。
        //   事件委托：命中矩形带 data-measure，点它任意位置都算点这一小节。
        if (els.sheetMusic) {
            els.sheetMusic.addEventListener('click', (e) => {
                const rect = e.target.closest ? e.target.closest('[data-measure]') : null;
                if (!rect) return;
                if (isRendering || !data) return;
                const m = parseInt(rect.dataset.measure, 10);
                if (!isFinite(m)) return;
                setMeasureHighlight(m);          // 先给点击反馈，再去 seek / 渲染
                doPlay(lastPlayMode, m);
            });
        }

        // ---------------- 底部迷你播放器 ----------------
        if (els.mpExpand) els.mpExpand.addEventListener('click', () => mpSetExpanded(true));
        if (els.mpClose) els.mpClose.addEventListener('click', () => mpSetExpanded(false));
        // ★ 级数图不再有"点一下切换显隐" —— 改成整个舞台长按揭示（见 bindStageGesture）。
        if (els.mpPrev) els.mpPrev.addEventListener('click', () => mpJump(-1));
        if (els.mpNext) els.mpNext.addEventListener('click', () => mpJump(1));
        if (els.mpPlayPause) els.mpPlayPause.addEventListener('click', () => { mpTogglePlay(); });
        if (els.mpGenerate) els.mpGenerate.addEventListener('click', () => { mpRegenerate(); });
        if (els.mpGenerateMin) els.mpGenerateMin.addEventListener('click', () => { mpRegenerate(); });
        if (els.mpReport) els.mpReport.addEventListener('click', () => { mpCancelGesture(); mpOpenError(null); });
        if (els.mpErrorNone) els.mpErrorNone.addEventListener('click', () => mpSubmitReport(null));
        if (els.mpErrorCancel) els.mpErrorCancel.addEventListener('click', () => mpCloseError());
        if (els.mpError) {
            els.mpError.addEventListener('click', (e) => {
                if (e.target === els.mpError) mpCloseError();   // 点遮罩关闭
            });
        }
        if (els.mpErrorGrid) {
            els.mpErrorGrid.addEventListener('click', (e) => {
                const b = e.target.closest ? e.target.closest('[data-degree]') : null;
                if (!b) return;
                mpSubmitReport(parseInt(b.dataset.degree, 10));
            });
        }

        // 错题练习：进入（数据库页的按钮）/ 退出（面板顶部的按钮）
        if (els.dbPractice) els.dbPractice.addEventListener('click', () => { startPractice(); });
        if (els.mpExitPractice) els.mpExitPractice.addEventListener('click', () => { exitPractice(); });

        // 长按看的答案：按住揭示、按住下滑报错、按住左滑上一个和弦
        bindStageGesture();

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

        // 转屏 / 缩放后重画（canvas 尺寸跟着变）
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', () => { if (mpExpanded) mpPaintCover(); });
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
    //   它整块 DOM 放在 #view-chord 里面：切到视唱页时 #view-chord 是 display:none，
    //   display:none 子树里的 position:fixed 同样不渲染 → 切页自动隐藏。
    //   代价：body / .container / #view-chord 这条链上不能加 transform / filter，
    //   否则 fixed 的包含块会被劫持。
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
        } else {
            mpCloseError();
        }
    }

    // 小节变了 → 收起条上的进度文字 + （展开时）重画大图
    //
    //   ★ 这是"显示"的唯一入口，所以冻结闸门也放在这里：
    //     mpLiveMeasure 永远跟着播放走（真实进度不丢），
    //     但只要手指还按着在看答案（mpFreeze 非空），显示就停在冻结点不动。
    function mpOnMeasure(m) {
        if (m < 0) return;
        mpLiveMeasure = m;
        if (mpFreeze) return;
        mpMeasure = m;
        mpPaintBarTitle();
        if (mpExpanded) mpPaintCover();
    }

    function mpPaintBarTitle() {
        if (!els || !els.mpBarTitle) return;
        const total = (data && data.chords.length) ? data.chords.length : 0;
        // ★ 只报"第几小节"，**不报级数** —— 收起条上写级数等于剧透答案
        const base = total
            ? ('第 ' + (mpMeasure + 1) + ' / ' + total + ' 小节')
            : '还没有内容，点「下一首」';
        els.mpBarTitle.textContent = practiceMode ? ('错题 · ' + base) : base;
    }

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
            drawCover(els.mpCover.getContext('2d'), px, info, false);
        } catch (e) {}
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
    //     按住往下滑 → 打开报错浮窗（对象 = 冻结点那个和弦，不随音乐前进而变）
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
            prev2: mpPrevTwo(m),
            prev3: mpPrevDegrees(m, 3)
        };
        mpMeasure = m;            // 面板（含收起条上的进度）都停在冻结点
        mpPaintBarTitle();
        return true;
    }

    function mpUnfreeze() {
        if (!mpFreeze) return;
        mpFreeze = null;
        mpMeasure = mpLiveMeasure;    // 恢复跟随实时进度
        mpPaintBarTitle();
        if (mpExpanded) mpPaintCover();
    }

    // 手势的统一收尾。任何"显式动作"（点按钮 / 换段 / 收起面板 / 切视图）都先调它。
    function mpCancelGesture() {
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
    function mpStepBackWhileHolding() {
        if (!data || !data.chords.length) return;
        const cur = mpFreeze ? mpFreeze.measure : mpMeasure;
        const next = Math.max(0, cur - 1);
        if (next === cur) return;          // 已经在第一小节
        mpFreezeAt(next);
        mpSetRevealed(true);
        doPlay(lastPlayMode, next);
    }

    function bindStageGesture() {
        const stage = els && els.mpStage;
        if (!stage) return;

        // iOS 长按会弹拷贝菜单/放大镜，直接压掉
        stage.addEventListener('contextmenu', (e) => { e.preventDefault(); });

        stage.addEventListener('pointerdown', (e) => {
            if (!mpExpanded || !data || !data.chords.length) return;
            if (e.isPrimary === false) return;      // 只认主指针，防双指误触
            if (mpGesture) return;
            const g = {
                pointerId: e.pointerId,
                x0: e.clientX,
                y0: e.clientY,
                anchorX: e.clientX,
                phase: 'pending',
                axis: null,
                captured: false,
                timer: 0
            };
            mpGesture = g;
            try { stage.setPointerCapture(e.pointerId); g.captured = true; } catch (err) {}
            stage.classList.add('is-pressing');
            g.timer = setTimeout(() => { g.timer = 0; mpArmGesture(g); }, MP_HOLD_MS);
        });

        stage.addEventListener('pointermove', (e) => {
            const g = mpGesture;
            if (!g || e.pointerId !== g.pointerId) return;
            const dx = e.clientX - g.x0;
            const dy = e.clientY - g.y0;

            if (g.phase === 'pending') {
                // 还没到长按阈值就动了 → 当成滑动/误触，取消（既不揭示也不触发方向）
                if (Math.abs(dx) > MP_SLOP_PX || Math.abs(dy) > MP_SLOP_PX) {
                    if (g.timer) { clearTimeout(g.timer); g.timer = 0; }
                    stage.classList.remove('is-pressing');
                    if (g.captured) { try { stage.releasePointerCapture(g.pointerId); } catch (err) {} g.captured = false; }
                    mpGesture = null;
                }
                return;
            }
            if (g.phase !== 'armed') return;

            // 先定轴：斜滑按主导轴，绝不双触发。
            //   错题练习不设报错 → 不认"下滑"这个轴（只认左滑回退）。
            if (!g.axis) {
                if (!practiceMode && dy > MP_DOWN_PX && dy > Math.abs(dx) * 1.2) g.axis = 'down';
                else if (dx < -MP_LEFT_PX && Math.abs(dx) > Math.abs(dy) * 1.2) g.axis = 'left';
            }

            if (g.axis === 'down') {
                if (dy > MP_DOWN_PX) {
                    g.phase = 'done';                 // 一次性动作，之后忽略 move
                    mpOpenError(mpFreeze);            // 目标 = 冻结快照；音乐不停
                }
                return;
            }

            if (g.axis === 'left') {
                // 每再左滑一格就退一个小节（re-arm）；已经在第一小节就只重置锚点、不动作
                let guard = 0;
                while (g.anchorX - e.clientX >= MP_LEFT_PX && guard < 20) {
                    g.anchorX -= MP_LEFT_PX;
                    mpStepBackWhileHolding();
                    guard++;
                }
            }
        });

        const finish = (e) => {
            const g = mpGesture;
            if (!g || (e && e.pointerId !== undefined && e.pointerId !== g.pointerId)) return;
            mpCancelGesture();
        };
        stage.addEventListener('pointerup', finish);
        stage.addEventListener('pointercancel', finish);
        stage.addEventListener('lostpointercapture', finish);
    }

    function mpSetNote(text) {
        if (els && els.mpNote) els.mpNote.textContent = text || '';
    }

    function mpSyncPlayIcon() {
        if (!els || !els.mpPlayPause) return;
        const playing = !!(chordAudioEl && !chordAudioEl.paused && !chordAudioEl.ended);
        els.mpPlayPause.textContent = playing ? '⏸ 暂停' : '▶ 播放';
        els.mpPlayPause.classList.toggle('is-playing', playing);
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
        if (chordAudioEl && blobData === data && blobUrl) {
            try {
                await chordAudioEl.play();
                return;
            } catch (e) { /* 被拦或被换过 → 往下重渲染 */ }
        }
        await doPlay(lastPlayMode, mpMeasure);
    }

    // 上一个 / 下一个和弦。
    //   基准用 mpMeasure（面板上正在看的这一小节），**不用 currentTime** ——
    //   暂停作答时 currentTime 停在暂停点甚至 0，拿它做基准会跳错小节。
    function mpJump(dir) {
        if (!data || !data.chords.length) return;
        mpCancelGesture();                   // 显式导航 = 手势结束（含解冻）
        const next = Math.max(0, Math.min(data.chords.length - 1, mpMeasure + dir));
        if (next === mpMeasure) return;      // 已在头 / 尾
        doPlay(lastPlayMode, next);
    }

    // 换一段。默认顺手接着播（MP_AUTOPLAY_AFTER_GENERATE）。
    async function mpRegenerate() {
        if (isRendering) return;
        mpCancelGesture();
        mpSetNote('');
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
    //   frozen = 长按那一刻的冻结快照（"按住下滑"进来时传它）；
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
        mpSetNote('已记录：你听成 ' + (rec.guessedRoman || '没听出来') +
            ' ｜ 实际 ' + rec.actualRoman + '（第 ' + (rec.measure + 1) + ' 小节）');
        mpErrorCtx = null;
        try { console.log('[和弦听辨·报错]', rec); } catch (e) {}
        // ★ 报错提交后回到报错和弦的小节开头**重播一小节**，播完自然继续往后。
        //   （本轮明确推翻上一轮"报错提交后播放不停不跳转"的决定。）
        //   doPlay 快路只是 seek，seeking 期间不会误计 heard；重播的那一小节会再计
        //   一次 —— 它确实又被完整听了一遍，属可接受的双计。
        //   isRendering 中提交时 doPlay 会静默跳过本次重播（概率极低）。
        mpCancelGesture();            // 长按冻结/揭示态先解冻，再 seek
        if (!practiceMode) doPlay(lastPlayMode, rec.measure);
    }

    // ============================================================
    // 错题练习模式（复用迷你播放器，正确率不计入数据库，不设报错）
    // ============================================================

    const MP_HINT_NORMAL = '按住看答案 · 按住下滑报错 · 按住左滑上一个';
    const MP_HINT_PRACTICE = '错题练习：按住看答案 · 按住左滑上一个（不计统计 · 无报错）';

    // 切换错题模式的 UI 痕迹：报错键 / 下滑手势 / 提示文案 / 收起条前缀 / 退出按钮
    function applyPracticeUi(on) {
        if (els && els.mpReport) els.mpReport.hidden = !!on;
        if (els && els.mpExitPractice) els.mpExitPractice.hidden = !on;
        if (els && els.mpHint) els.mpHint.textContent = on ? MP_HINT_PRACTICE : MP_HINT_NORMAL;
        mpPaintBarTitle();
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
                els.dbTop.appendChild(emptyLine('还没有报错记录 —— 练习时按住级数图、往下滑即可报错'));
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
        stopChordPlayback();
        // 离开和弦页：把迷你播放器复位成收起态（否则切回来面板还开着），浮窗也关掉
        mpSetExpanded(false);
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
        _getCheckBox: () => els.autoContinue,
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
            errorOpen: !!(els && els.mpError && !els.mpError.hidden),
            reportCount: mpReports.length
        }),
        _setMpExpanded: mpSetExpanded,
        _setMpMeasure: (m) => { mpMeasure = m; mpOnMeasure(m); },
        _setMpRevealed: mpSetRevealed,
        _openMpError: mpOpenError,
        _closeMpError: mpCloseError,
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
