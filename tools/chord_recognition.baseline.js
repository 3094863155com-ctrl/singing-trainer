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
        legato: LEGATO_DEFAULT,
        // 参与的级数（Ⅰ 永远参与，端点强制）
        degrees: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
        // 各级出现七和弦的概率（%）
        seventhProb: { 1: 0, 2: 40, 3: 0, 4: 10, 5: 70, 6: 0, 7: 30 }
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

    // 四部软代价值的权重
    const P4 = {
        bassMove: 0.6,
        upperMove: 1.0,
        upperLeap: 2.0,
        bassLeap: 1.0,
        parallel: 60,        // 平行五/八度（原模式只有 8，四部必须显著提高）
        hidden: 40,          // 隐伏五/八度（外声部）
        overlap: 30,
        crossing: 30,
        commonTone: -3,      // 共同音保持在同一声部 → 加分
        resolveOk: -4,
        resolveBad: 15,
        rangeCenter: 0.25,
        outOfRange: 3,       // 越出声部标准音域的每半音惩罚
        rootBonus: -4,
        endNonRoot: 100
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

        const pad = relax >= 3 ? 4 : (relax === 2 ? 2 : 0);
        const gapUp = relax >= 1 ? 2 : 0;
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

                const opts = upperTones.map((t, k) => {
                    const arr = [];
                    const [lo, hi] = rangeOf(k + 1);
                    for (let o = 0; o < 9; o++) {
                        const m = t.pc + 12 * (o + 1);
                        if (m <= bassMidi || m < lo || m > hi) continue;
                        arr.push(m);
                    }
                    return arr;
                });
                if (opts.some((a) => a.length === 0)) continue;

                for (const t0 of opts[0]) {
                    for (const t1 of opts[1]) {
                        if (t1 <= t0) continue;
                        for (const t2 of opts[2]) {
                            if (t2 <= t1) continue;
                            if (t2 - t1 > FOUR_GAP.sa + gapUp) continue;
                            if (t1 - t0 > FOUR_GAP.at + gapUp) continue;
                            if (t0 - bassMidi > FOUR_GAP.tb + gapUp) continue;
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
        return out;
    }

    // 四部专用软代价（与原 voicingCost 完全独立，互不影响）
    function fourPartCost(cand, prevMidis, isLast, ctx) {
        let cost = 0;
        const b = cand.midis;

        if (prevMidis && prevMidis.length === 4) {
            const a = prevMidis;

            cost += Math.abs(b[0] - a[0]) * P4.bassMove;
            for (let i = 1; i < 4; i++) {
                const d = Math.abs(b[i] - a[i]);
                cost += d * P4.upperMove;
                if (d > 4) cost += (d - 4) * P4.upperLeap;        // 上方声部避免大跳
            }
            const bl = Math.abs(b[0] - a[0]);
            if (bl > 7) cost += (bl - 7) * P4.bassLeap;

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

            // 隐伏五/八度（两外声部 S、B 同向进行到纯五/纯八，且至少一声部为跳进）
            {
                const dS = b[3] - a[3];
                const dB = b[0] - a[0];
                const dci = b[3] - b[0];
                const dpi = a[3] - a[0];
                const ci = Math.abs(dci);
                if (dS !== 0 && dB !== 0 && Math.sign(dS) === Math.sign(dB)
                    && (ci === 7 || ci === 0 || ci === 12) && ci !== Math.abs(dpi)
                    && (Math.abs(dS) > 2 || Math.abs(dB) > 2)) {
                    cost += P4.hidden;
                }
            }

            // 声部超越 / 交错（跨和弦）
            for (let i = 0; i < 3; i++) {
                if (b[i] > a[i + 1]) cost += P4.crossing;
                if (b[i + 1] < a[i]) cost += P4.overlap;
            }

            // 共同音保持在同一部 → 加分
            for (let i = 0; i < 4; i++) {
                if (b[i] === a[i]) cost += P4.commonTone;
            }

            // 导音必须上行解决到主音
            if (ctx) {
                for (let i = 0; i < 4; i++) {
                    const pc = (((a[i] % 12) + 12) % 12);
                    if (pc !== ctx.leadingPc) continue;
                    const npc = (((b[i] % 12) + 12) % 12);
                    const mv = b[i] - a[i];
                    if (npc === ctx.tonicPc && mv > 0 && mv <= 2) cost += P4.resolveOk;
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

    // 挑四部配声：4 级放宽阶梯，逐级尝试；池内随机保留变化
    //   平行五/八度是硬错误 → 优先在"干净"候选里选；某一级若全是脏的，
    //   继续放宽一级再找（而不是将就），全部级别都脏时才退而求其次。
    function chooseFourPartVoicing(scale, degree, seventh, prevMidis, allowInversion, isLast, allowSecondInv, ctx) {
        const pick = (cands) => {
            const scored = cands.map((c) => ({ c, cost: fourPartCost(c, prevMidis, isLast, ctx) }));
            scored.sort((x, y) => x.cost - y.cost);
            const best = scored[0].cost;
            const pool = scored.filter((s) => s.cost <= best + 3.0).map((s) => s.c);
            return pool[Math.floor(Math.random() * pool.length)];
        };
        const needClean = !!(prevMidis && prevMidis.length === 4);
        let dirtyPool = null;

        for (let relax = 0; relax <= 3; relax++) {
            const cands = buildFourPartCandidates(
                scale, degree, seventh, allowInversion, allowSecondInv, relax
            );
            if (!cands.length) continue;
            if (!needClean) return pick(cands);

            const clean = cands.filter((c) => !hasParallel(prevMidis, c.midis));
            if (clean.length) return pick(clean);
            if (!dirtyPool) dirtyPool = cands;
        }
        if (dirtyPool) return pick(dirtyPool);
        return fallbackFourPart(scale, degree, seventh);
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
        let prevDegree = 1;
        for (let i = 1; i <= N - 2; i++) {
            const pool = picked.filter((d) => d !== prevDegree);
            const list = pool.length ? pool : picked;
            const d = list[Math.floor(Math.random() * list.length)];
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
                const n = chord.midis.length;
                for (let k = 0; k < 16; k++) {
                    events.push({
                        time: base + k * six,
                        midis: [chord.midis[k % n]],  // 从低音起，逐音上行，循环
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

    // ------------------------------------------------------------
    // UI 与状态
    // ------------------------------------------------------------

    let data = null;              // { key, scale, keySig, chords }
    let chordAudioEl = null;
    let blobUrl = null;
    let isRendering = false;

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
            grid: document.getElementById('degree-grid'),
            inversion: document.getElementById('chord-inversion'),
            secondInv: document.getElementById('chord-second-inv'),
            info: document.getElementById('chord-info'),
            renderInfo: document.getElementById('chord-render-info'),
            hint: document.getElementById('chord-key-hint')
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

    function stopChordPlayback() {
        if (chordAudioEl) {
            try { chordAudioEl.pause(); } catch (e) {}
        }
    }

    // 三种播放方式：柱式（一拍一下）/ 分解（一拍四音，低→高滚动）/ 单音（每小节只弹最低音，长音）
    const PLAY_MODES = { block: '柱式', arpeggio: '分解和弦', bass: '单音' };

    function setPlayButtonsEnabled(on) {
        const btns = [els.play, els.playArp, els.playBass];
        for (let i = 0; i < btns.length; i++) {
            if (btns[i]) btns[i].disabled = !on;
        }
    }

    function updateHint() {
        if (!els.hint || !data) return;
        const invText = settings.allowInversion ? '开启转位（和弦间平稳连接）' : '全部原位';
        const modeText = (data.voicingMode === 'fourpart')
            ? '四部和声 · 大谱表'
            : '三和弦 · 单行谱';
        els.hint.textContent =
            `本段：${data.key} 大调 · ${data.chords.length} 小节 · ${settings.tempo} BPM · ${modeText} · ${invText}`;
    }

    async function doGenerate(auto) {
        stopChordPlayback();
        data = generateChordProgression(settings);
        renderChordSheet(data);
        updateHint();
        setPlayButtonsEnabled(true);
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

    async function doPlay(mode) {
        mode = mode || 'block';
        if (!data || !data.chords.length || isRendering) return;
        const host = global.ChordHost;
        if (!host) { renderInfoText('音频桥接不可用', true); return; }

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

            chordAudioEl.pause();
            chordAudioEl.src = blobUrl;
            if (els.renderInfo) {
                els.renderInfo.textContent = '播放中（' + (PLAY_MODES[mode] || '柱式') + '）…';
            }
            try {
                await chordAudioEl.play();
            } catch (err) {
                // 离线渲染耗时可能超出浏览器的自动播放时限 → NotAllowedError。
                // 这不是功能故障：用户再点一次刚才那个播放键即可（那一下是明确手势）。
                const tag = String(err && err.name) + String(err && err.message);
                if (/NotAllowed|not allowed/i.test(tag)) {
                    renderInfoText('浏览器拦截了自动播放，请再点一次刚才的播放键', true);
                } else {
                    renderInfoText('播放失败: ' + (err && err.message), true);
                }
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
        if (els.play) els.play.addEventListener('click', () => doPlay('block'));
        if (els.playArp) els.playArp.addEventListener('click', () => doPlay('arpeggio'));
        if (els.playBass) els.playBass.addEventListener('click', () => doPlay('bass'));
        if (els.stop) {
            els.stop.addEventListener('click', () => {
                stopChordPlayback();
                if (els.renderInfo) { els.renderInfo.textContent = '已停止'; }
            });
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
    }

    global.ChordRecognition = {
        init,
        activate,
        deactivate,
        generate: () => doGenerate(false),
        play: doPlay,
        // 便于调试 / 自测
        _generateChordProgression: generateChordProgression,
        _buildScale: buildScale,
        _buildCandidates: buildCandidates,
        _chordToneSpelled: chordToneSpelled,
        _doubledToneIndex: doubledToneIndex,
        _buildFourPartCandidates: buildFourPartCandidates,
        _fourPartCost: fourPartCost,
        _chooseFourPartVoicing: chooseFourPartVoicing,
        _FOUR_RANGES: FOUR_RANGES,
        _buildChordSchedule: buildChordSchedule,
        _renderChordAudio: renderChordAudio,
        _resolveSample: resolveSample,
        _getSettings: () => settings,
        _getLastData: () => data
    };

})(typeof window !== 'undefined' ? window : this);
