// ============================================================
// harmony_melody.js —— 和声性旋律生成（实验性，与原 singing_trainer.html 完全隔离）
//
// 设计目标：
//   1. 自包含：内部复制所需工具函数，不依赖原文件的任何变量
//   2. 接口最小：仅暴露 window.HarmonyMelody 供原文件调用
//   3. 渲染复用：返回的 melody 数组与原文件格式一致，由原 renderSheetMusic 渲染
//   4. 伴奏独立：钢琴合成与调度封装在此文件内
//
// 和声丰富化（v2）：
//   - 模块长度：0.5 / 1 / 2 小节随机（0.5 低概率，实现半小节换和弦）
//   - 经过和弦：30% 概率在主模块末尾插入 1 拍经过和弦，调内为主、偶尔七和弦色彩
//   - 终止式：随机二选一 —— K46 → V7 → I（古典正格终止）或 ii7 → V7 → I（爵士终止）
//   - 钢琴音量/静音接口
// ============================================================

(function (global) {
    'use strict';

    // ------------------------------------------------------------
    // 常量与工具（与原文件隔离，内部独立实现）
    // ------------------------------------------------------------

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const FLAT_MAP = { 'Db': 1, 'Eb': 3, 'Gb': 6, 'Ab': 8, 'Bb': 10 };
    const ENHARMONIC_MAP = { 'A#': 'Bb', 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab' };

    // 调式音阶（与原文件保持一致）
    const SCALES = {
        'C': ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
        'G': ['G', 'A', 'B', 'C', 'D', 'E', 'F#'],
        'D': ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],
        'A': ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#'],
        'E': ['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'],
        'B': ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'],
        'F#': ['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#'],
        'F': ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],
        'Bb': ['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'],
        'Eb': ['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D'],
        'Ab': ['Ab', 'Bb', 'C', 'Db', 'Eb', 'F', 'G'],
        'Db': ['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C'],
        'Cm': ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'Bb'],
        'Gm': ['G', 'A', 'Bb', 'C', 'D', 'Eb', 'F'],
        'Dm': ['D', 'E', 'F', 'G', 'A', 'Bb', 'C'],
        'Am': ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        'Em': ['E', 'F#', 'G', 'A', 'B', 'C', 'D'],
        'Bm': ['B', 'C#', 'D', 'E', 'F#', 'G', 'A'],
        'F#m': ['F#', 'G#', 'A', 'B', 'C#', 'D', 'E'],
        'Fm': ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'Eb'],
        'Bbm': ['Bb', 'C', 'Db', 'Eb', 'F', 'Gb', 'Ab'],
        'Ebm': ['Eb', 'F', 'Gb', 'Ab', 'Bb', 'Db', 'Eb'],
        'Abm': ['Ab', 'Bb', 'Db', 'Eb', 'F', 'Gb', 'Ab'],
        'Dbm': ['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C']
    };

    function noteNameIndex(name) {
        const idx = NOTE_NAMES.indexOf(name);
        return idx !== -1 ? idx : (FLAT_MAP[name] !== undefined ? FLAT_MAP[name] : -1);
    }

    function midiFromNote(note) {
        const match = note.match(/^([A-G][#b]?)(\d+)$/);
        if (!match) return 60;
        const name = match[1];
        const octave = parseInt(match[2]);
        const index = noteNameIndex(name);
        if (index === -1) return 60;
        return index + (octave + 1) * 12;
    }

    function midiToFreq(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function midiToNoteEntry(midi, scale) {
        const noteIndex = midi % 12;
        const rawNote = NOTE_NAMES[noteIndex];
        const octave = Math.floor(midi / 12) - 1;
        let note = rawNote;
        if (ENHARMONIC_MAP[rawNote]) {
            const enharmonic = ENHARMONIC_MAP[rawNote];
            if (scale.indexOf(enharmonic) !== -1) {
                note = enharmonic;
            }
        }
        return { note, octave };
    }

    // 以 tonicMidi 为根，构建一个完整八度的 scale midi（7 个音，按音高递增）
    function buildBaseOctaveMidis(scale, tonicMidi) {
        const midis = [];
        const tonicPc = tonicMidi % 12;
        let octaveBase = Math.floor(tonicMidi / 12);
        let prevPc = tonicPc;
        for (let i = 0; i < scale.length; i++) {
            const pc = noteNameIndex(scale[i]);
            if (pc === -1) continue;
            if (i > 0 && pc <= prevPc) {
                octaveBase++;
            }
            midis.push(pc + octaveBase * 12);
            prevPc = pc;
        }
        return midis;
    }

    // ------------------------------------------------------------
    // 和声进行生成（调内随机合理进行 + 经过和弦 + 终止式）
    // ------------------------------------------------------------

    // 功能分组：T / S / D
    function functionOf(degree) {
        if (degree === 1 || degree === 3 || degree === 6) return 'T';
        if (degree === 2 || degree === 4) return 'S';
        return 'D';
    }

    function pickNextDegree(prev, forceDifferent) {
        // forceDifferent=true（跨小节）：强制 degree != prev（小节线后第一个重拍必须换和弦）
        // forceDifferent=false（同小节内）：25% 概率延续同 degree（可配合转位）
        if (!forceDifferent && Math.random() < 0.25) {
            return prev;
        }
        const func = functionOf(prev);
        let candidates;
        if (func === 'T') {
            candidates = [1, 3, 6, 2, 4, 5, 7].filter(d => d !== prev);
        } else if (func === 'S') {
            candidates = [2, 4, 5, 7].filter(d => d !== prev);
        } else {
            candidates = [1, 3, 6];
        }
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // 生成完整进行：返回模块数组，每个模块 { degree, beats, seventh, cad64, passing, inversion }
    // 规则：每小节固定 4 拍一个和弦，相邻小节 degree 必须不同；结尾保留终止式
    // inversion: 0=原位, 1=第一转位(三音在低音), 2=第二转位(五音在低音)
    function generateProgression(totalMeasures) {
        const totalBeats = totalMeasures * 4;

        // 预留结尾终止式 12 拍（3 个 4 拍模块）
        const CADENCE_BEATS = 12;
        const bodyBeatsTotal = totalBeats - CADENCE_BEATS;
        const bodyMeasures = Math.max(0, Math.floor(bodyBeatsTotal / 4));

        // 主体模块：每小节固定 4 拍一个和弦，相邻小节 degree 不同
        const bodyModules = [];
        for (let i = 0; i < bodyMeasures; i++) {
            bodyModules.push({
                degree: 0, beats: 4, seventh: false,
                cad64: false, passing: false, inversion: 0
            });
        }
        if (bodyModules.length > 0) {
            bodyModules[0].degree = 1;  // 起始 I
            for (let i = 1; i < bodyModules.length; i++) {
                // 每个模块都是 4 拍 = 1 小节，相邻即跨小节，强制 degree 不同
                bodyModules[i].degree = pickNextDegree(bodyModules[i - 1].degree, true);
            }
        }

        // 结尾终止式：保证终止式首模块与 body 末模块 degree 不同（遵守相邻小节规则）
        const result = bodyModules.slice();
        const bodyLastDegree = bodyModules.length > 0
            ? bodyModules[bodyModules.length - 1].degree : 0;
        let cadenceType;
        if (bodyLastDegree === 1) {
            cadenceType = 'jazz';       // ii7(2) 避开 I(1)
        } else if (bodyLastDegree === 2) {
            cadenceType = 'classical';  // K46(1) 避开 ii(2)
        } else {
            cadenceType = Math.random() < 0.5 ? 'classical' : 'jazz';
        }
        if (cadenceType === 'classical') {
            // K46 → V7 → I（古典正格终止）
            result.push({ degree: 1, beats: 4, seventh: false, cad64: true, passing: false, inversion: 0 });
            result.push({ degree: 5, beats: 4, seventh: true, cad64: false, passing: false, inversion: 0 });
            result.push({ degree: 1, beats: 4, seventh: false, cad64: false, passing: false, inversion: 0 });
        } else {
            // ii7 → V7 → I（爵士终止）
            result.push({ degree: 2, beats: 4, seventh: true, cad64: false, passing: false, inversion: 0 });
            result.push({ degree: 5, beats: 4, seventh: true, cad64: false, passing: false, inversion: 0 });
            result.push({ degree: 1, beats: 4, seventh: false, cad64: false, passing: false, inversion: 0 });
        }

        return result;
    }

    // ------------------------------------------------------------
    // 和弦音计算
    // ------------------------------------------------------------

    // 在音域内收集和弦音（1/3/5，若 seventh 则加 7 音）
    function collectChordTones(module, baseOctaveMidis, scaleMidiNotes) {
        const i = module.degree - 1;
        const rootPc = baseOctaveMidis[i] % 12;
        const thirdPc = baseOctaveMidis[(i + 2) % 7] % 12;
        const fifthPc = baseOctaveMidis[(i + 4) % 7] % 12;
        const seventhPc = baseOctaveMidis[(i + 6) % 7] % 12;
        const tones = [];
        for (const midi of scaleMidiNotes) {
            const pc = midi % 12;
            if (pc === rootPc || pc === thirdPc || pc === fifthPc) {
                tones.push(midi);
            } else if (module.seventh && pc === seventhPc) {
                tones.push(midi);
            }
        }
        return tones;
    }

    // 在和弦音集合中选最接近 currentMidi 的音
    // 反同音机制：若最近的和弦音与 currentMidi 相同（即会产出同音连续），
    // 仅保留 30% 概率允许同音（维持骨架稳定性），70% 概率跳到次近和弦音。
    // 根因：和声模式强拍/模块首音都走 nearestChordTone，若上一音已落在和弦音 X，
    // 下一强拍 currentMidi 仍在 X 附近，会反复命中 X → 视觉/听觉上的"同音连续"。
    function nearestChordTone(chordTones, currentMidi) {
        if (chordTones.length === 0) return currentMidi;
        // 按距离 currentMidi 升序排序
        const sorted = chordTones.slice().sort(
            (a, b) => Math.abs(a - currentMidi) - Math.abs(b - currentMidi)
        );
        // 30% 概率允许同音（保留骨架稳定，避免过度跳脱破坏和声感）
        // 70% 概率：若最近和弦音 == currentMidi（同音），跳过它选次近和弦音
        if (Math.random() >= 0.30 && sorted[0] === currentMidi && sorted.length > 1) {
            return sorted[1];
        }
        return sorted[0];
    }

    // 四部和声 voicing：返回 { bass, tenor, alto, soprano }
    // 声部连接规则：
    //   - 低音可自由大跳（产生旋律感，级进/跳进交替）
    //   - 上方三声部（T/A/S）平稳过渡：共同音保留，非共同音级进到最近和弦音
    //   - 支持 inversion（转位）、cad64（K46）、seventh（七和弦）
    function voiceLeadChord(module, baseOctaveMidis, previousVoicing) {
        const i = module.degree - 1;
        const rootPc = baseOctaveMidis[i] % 12;
        const thirdPc = baseOctaveMidis[(i + 2) % 7] % 12;
        const fifthPc = baseOctaveMidis[(i + 4) % 7] % 12;
        const seventhPc = baseOctaveMidis[(i + 6) % 7] % 12;

        // === 低音（Bass）：可大跳，由 inversion/cad64 决定 ===
        let bassMidi;
        if (module.cad64) {
            // K46：低音=5音（低八度）
            bassMidi = baseOctaveMidis[(i + 4) % 7] - 12;
        } else if (module.inversion === 1) {
            // 第一转位：低音=3音（低八度）
            bassMidi = baseOctaveMidis[(i + 2) % 7] - 12;
        } else if (module.inversion === 2) {
            // 第二转位：低音=5音（低八度）
            bassMidi = baseOctaveMidis[(i + 4) % 7] - 12;
        } else {
            // 原位：低音=根音（低八度）
            bassMidi = baseOctaveMidis[i] - 12;
        }

        // === 上方三声部可用音池（中音区 C4~B5，midi 60~83）===
        const roles = [
            { pc: rootPc, role: 'root' },
            { pc: thirdPc, role: 'third' },
            { pc: fifthPc, role: 'fifth' }
        ];
        if (module.seventh) {
            roles.push({ pc: seventhPc, role: 'seventh' });
        }
        const pool = [];
        for (let octave = 4; octave <= 5; octave++) {
            for (const r of roles) {
                const midi = r.pc + octave * 12;
                if (midi >= 60 && midi <= 83) {
                    pool.push({ midi, pc: r.pc, role: r.role });
                }
            }
        }
        if (pool.length < 3) {
            // 极端情况下兜底：用根三五原位
            const r = baseOctaveMidis[i];
            let t = baseOctaveMidis[(i + 2) % 7];
            let f = baseOctaveMidis[(i + 4) % 7];
            while (t < r) t += 12;
            while (f < t) f += 12;
            return { bass: bassMidi, tenor: t, alto: f, soprano: f + 12 };
        }

        // === 声部连接 ===
        let assigned = {};
        if (previousVoicing) {
            const prevUpper = [
                { name: 'tenor', midi: previousVoicing.tenor },
                { name: 'alto', midi: previousVoicing.alto },
                { name: 'soprano', midi: previousVoicing.soprano }
            ];
            const used = new Set();

            // 1) 共同音保留：前一voicing的声部音高，若pc在新和弦中存在，保留同声部
            for (const v of prevUpper) {
                const pc = v.midi % 12;
                const match = pool.find(t => t.pc === pc && !used.has(t.midi));
                if (match) {
                    assigned[v.name] = match.midi;
                    used.add(match.midi);
                }
            }

            // 2) 剩余声部级进到最近可用音
            for (const v of prevUpper) {
                if (assigned[v.name] !== undefined) continue;
                let best = null;
                let bestDist = Infinity;
                for (const t of pool) {
                    if (used.has(t.midi)) continue;
                    const d = Math.abs(t.midi - v.midi);
                    if (d < bestDist) {
                        bestDist = d;
                        best = t.midi;
                    }
                }
                if (best !== null) {
                    assigned[v.name] = best;
                    used.add(best);
                }
            }
        } else {
            // 首次分配：根三五分配到 T/A/S
            const rootT = pool.find(t => t.role === 'root') || pool[0];
            const thirdT = pool.find(t => t.role === 'third') || pool[1];
            const fifthT = pool.find(t => t.role === 'fifth') || pool[2];
            assigned.tenor = rootT.midi;
            assigned.alto = thirdT.midi;
            assigned.soprano = fifthT.midi;
        }

        // 兜底：若某声部未分配，从池中取未用音
        const usedFinal = new Set([assigned.tenor, assigned.alto, assigned.soprano].filter(x => x !== undefined));
        for (const v of ['tenor', 'alto', 'soprano']) {
            if (assigned[v] === undefined) {
                const cand = pool.find(t => !usedFinal.has(t.midi));
                if (cand) {
                    assigned[v] = cand.midi;
                    usedFinal.add(cand.midi);
                }
            }
        }

        // 确保 T < A < S（声部不交叉）
        const upper = [assigned.tenor, assigned.alto, assigned.soprano].sort((a, b) => a - b);
        return {
            bass: bassMidi,
            tenor: upper[0],
            alto: upper[1],
            soprano: upper[2]
        };
    }

    // ------------------------------------------------------------
    // 节奏型（与原 getBeatModule 逻辑一致，带 density 调节）
    // ------------------------------------------------------------

    function getBeatModule(density) {
        const patterns = [
            { pattern: ['4n'],                              base: 3,   type: 'sparse' },
            { pattern: ['8n', '8n'],                        base: 2,   type: 'medium' },
            { pattern: ['16n', '16n', '16n', '16n'],       base: 1.5, type: 'dense'  },
            { pattern: ['8n', '16n', '16n'],                base: 2,   type: 'dense'  },
            { pattern: ['16n', '16n', '8n'],                base: 2,   type: 'dense'  },
            { pattern: ['16n', '8n', '16n'],                base: 2,   type: 'dense'  },
            { pattern: ['8d', '16n'],                      base: 1.5, type: 'medium' }
        ];
        const weighted = patterns.map(p => {
            let mult;
            if (p.type === 'dense') {
                mult = Math.max(0.05, 1 - density * 0.95);
            } else if (p.type === 'sparse') {
                mult = 0.3 + density * 1.4;
            } else {
                mult = 0.7 + (1 - Math.abs(density - 0.5) * 2) * 0.6;
            }
            return { pattern: p.pattern, weight: p.base * mult };
        });
        const totalWeight = weighted.reduce((s, p) => s + p.weight, 0);
        let r = Math.random() * totalWeight;
        for (const p of weighted) {
            r -= p.weight;
            if (r <= 0) return p.pattern;
        }
        return weighted[0].pattern;
    }

    // 级进/跳进选择（与原 getNextNoteMidi 逻辑一致）
    function nextStepwise(scaleMidiNotes, currentMidi, leapProb) {
        const currentIndex = scaleMidiNotes.indexOf(currentMidi);
        if (currentIndex === -1) {
            return scaleMidiNotes[Math.floor(scaleMidiNotes.length / 2)];
        }
        const rand = Math.random();
        if (rand < leapProb) {
            const intervals = [
                { steps: 2, weight: 0.40 },
                { steps: 3, weight: 0.20 },
                { steps: 4, weight: 0.20 },
                { steps: 5, weight: 0.12 },
                { steps: 6, weight: 0.08 }
            ];
            let r = Math.random();
            let selectedSteps = 2;
            let cumulative = 0;
            for (const interval of intervals) {
                cumulative += interval.weight;
                if (r <= cumulative) {
                    selectedSteps = interval.steps;
                    break;
                }
            }
            const direction = Math.random() < 0.5 ? 1 : -1;
            const targetIndex = currentIndex + direction * selectedSteps;
            if (targetIndex >= 0 && targetIndex < scaleMidiNotes.length) {
                return scaleMidiNotes[targetIndex];
            }
            const oppositeIndex = currentIndex - direction * selectedSteps;
            if (oppositeIndex >= 0 && oppositeIndex < scaleMidiNotes.length) {
                return scaleMidiNotes[oppositeIndex];
            }
        }
        const up = Math.random() < 0.5;
        if (up) {
            if (currentIndex < scaleMidiNotes.length - 1) return scaleMidiNotes[currentIndex + 1];
            if (currentIndex > 0) return scaleMidiNotes[currentIndex - 1];
        } else {
            if (currentIndex > 0) return scaleMidiNotes[currentIndex - 1];
            if (currentIndex < scaleMidiNotes.length - 1) return scaleMidiNotes[currentIndex + 1];
        }
        return scaleMidiNotes[currentIndex];
    }

    // ------------------------------------------------------------
    // 旋律骨架生成（按拍循环，适配新模块结构）
    // ------------------------------------------------------------

    function generateMelody(opts) {
        const {
            currentKey,
            melodyLength,
            rangeStart,
            rangeEnd,
            density,
            leapProbability
        } = opts;

        const scale = SCALES[currentKey] || SCALES['C'];
        const startMidi = midiFromNote(rangeStart);
        const endMidi = midiFromNote(rangeEnd);

        // 构建音域内所有调内音
        const scaleMidiNotes = [];
        for (let octave = Math.floor(startMidi / 12); octave <= Math.floor(endMidi / 12); octave++) {
            for (const noteName of scale) {
                const noteIndex = noteNameIndex(noteName);
                if (noteIndex === -1) continue;
                const midi = noteIndex + octave * 12;
                if (midi >= startMidi && midi <= endMidi) {
                    scaleMidiNotes.push(midi);
                }
            }
        }
        scaleMidiNotes.sort((a, b) => a - b);

        if (scaleMidiNotes.length === 0) {
            return { melody: [], progression: [], baseOctaveMidis: [], currentKey };
        }

        // 主音（音域中点附近）
        const tonicPc = noteNameIndex(scale[0]);
        const tonicCandidates = scaleMidiNotes.filter(m => m % 12 === tonicPc);
        const midMidi = (startMidi + endMidi) / 2;
        const tonicMidi = tonicCandidates.length > 0
            ? tonicCandidates.reduce((closest, m) =>
                Math.abs(m - midMidi) < Math.abs(closest - midMidi) ? m : closest,
                tonicCandidates[0])
            : scaleMidiNotes[0];

        const baseOctaveMidis = buildBaseOctaveMidis(scale, tonicMidi);

        // 和声进行
        const progression = generateProgression(melodyLength);

        // 旋律生成（按拍循环）
        const melody = [];
        let currentMidi = tonicMidi;
        let globalBeat = 0;
        const totalBeats = melodyLength * 4;

        for (let mi = 0; mi < progression.length; mi++) {
            const module = progression[mi];
            const chordTones = collectChordTones(module, baseOctaveMidis, scaleMidiNotes);
            const nextModule = progression[mi + 1];
            const nextChordTones = nextModule
                ? collectChordTones(nextModule, baseOctaveMidis, scaleMidiNotes)
                : null;

            for (let b = 0; b < module.beats; b++) {
                const beatInMeasure = globalBeat % 4;
                const isLastBeat = (globalBeat === totalBeats - 1);

                if (isLastBeat) {
                    // 结尾主音
                    const entry = midiToNoteEntry(tonicMidi, scale);
                    melody.push({ note: entry.note, octave: entry.octave, duration: '4n' });
                    currentMidi = tonicMidi;
                } else {
                    const beatModule = getBeatModule(density);
                    for (let k = 0; k < beatModule.length; k++) {
                        const duration = beatModule[k];
                        let nextMidi;
                        const isStrongBeat = (beatInMeasure === 0 && k === 0) || (beatInMeasure === 2 && k === 0);
                        const isModuleStart = (b === 0 && k === 0);  // 模块首个音

                        if (isModuleStart || isStrongBeat) {
                            // 模块开始或强拍：用和弦音骨架
                            nextMidi = nearestChordTone(chordTones, currentMidi);
                        } else if (k === beatModule.length - 1 && beatInMeasure === 3 && nextChordTones) {
                            // 小节末过渡：倾向下一和弦音
                            nextMidi = nearestChordTone(nextChordTones, currentMidi);
                        } else {
                            // 填充音：级进/跳进
                            nextMidi = nextStepwise(scaleMidiNotes, currentMidi, leapProbability);
                        }
                        const entry = midiToNoteEntry(nextMidi, scale);
                        melody.push({ note: entry.note, octave: entry.octave, duration });
                        currentMidi = nextMidi;
                    }
                }
                globalBeat++;
            }
        }

        return { melody, progression, baseOctaveMidis, currentKey };
    }

    // ------------------------------------------------------------
    // Tone.js 钢琴伴奏（四部和声 + 音量/静音控制）
    // ------------------------------------------------------------

    let piano = null;
    let accompanimentEnabled = false;
    let scheduledTimers = [];
    let pianoVolumeDb = -10;       // 默认 -10dB
    let pianoMuted = false;

    async function initPiano() {
        if (typeof Tone === 'undefined') {
            console.warn('harmony_melody: Tone.js 未加载，伴奏不可用');
            return false;
        }
        // 自动下一首等"无用户手势"场景下 Tone.start() 会抛
        // "The request is not allowed by the user agent..." 错误。
        // 若 AudioContext 已 running（前一次渲染已启动过），跳过 Tone.start()。
        // 离线渲染 Tone.Offline 不依赖 running 状态，仍可正常工作。
        if (Tone.context.state !== 'running') {
            await Tone.start();
        }
        if (piano) {
            piano.volume.value = pianoMuted ? -Infinity : pianoVolumeDb;
            return true;
        }
        piano = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: 'triangle' },
            envelope: { attack: 0.005, decay: 0.4, sustain: 0.3, release: 1.2 }
        }).toDestination();
        piano.volume.value = pianoMuted ? -Infinity : pianoVolumeDb;
        return true;
    }

    function setAccompanimentEnabled(enabled) {
        accompanimentEnabled = !!enabled;
        if (!enabled) stopAccompaniment();
    }

    function isAccompanimentEnabled() {
        return accompanimentEnabled;
    }

    function isAvailable() {
        return typeof Tone !== 'undefined';
    }

    // 音量控制：volumePercent 0-100
    function setPianoVolume(volumePercent) {
        pianoVolumeDb = volumePercent <= 0 ? -Infinity : 20 * Math.log10(volumePercent / 100);
        if (piano && !pianoMuted) {
            piano.volume.value = pianoVolumeDb;
        }
    }

    function setPianoMuted(muted) {
        pianoMuted = !!muted;
        if (piano) {
            piano.volume.value = pianoMuted ? -Infinity : pianoVolumeDb;
        }
        if (pianoMuted) stopAccompaniment();
    }

    // 构建钢琴伴奏时间表（纯函数，供实时播放和离线渲染共用）
    // 返回: [{ time, freqs, dur }] 按时间递增
    //   time: 触发时间（秒）；freqs: SATB 频率数组；dur: 持续时间（秒）
    //   规则：经过和弦时值短(0.5拍)，强拍稍长(0.95拍)，弱拍(0.6拍)
    //   pianoOffsetSec: 钢琴整体时间偏移（秒），正值=延后，负值=提前；用于人声/钢琴对齐
    //   末尾渐慢：与 buildVocalSchedule 同步，最后一小节（4 拍）开始，
    //     速度降至 60%（factor 1.0→1.667），曲线 progress^1.5（前 2 拍减速明显，后 2 拍末端加速）
    function buildPianoSchedule(generatedData, tempo, pianoOffsetSec) {
        if (!generatedData || !generatedData.progression) return [];
        const offset = (typeof pianoOffsetSec === 'number') ? pianoOffsetSec : 0;
        const { progression, baseOctaveMidis } = generatedData;
        const beatDuration = 60 / tempo;
        // 渐慢参数：与 buildVocalSchedule 完全一致（人声/钢琴对齐关键）
        const RIT_BEATS = 4;
        const RIT_FINAL_FACTOR = 1 / 0.6;  // 1.667，即速度降至 60%
        let totalBeats = 0;
        for (const m of progression) totalBeats += m.beats;
        const ritStartBeat = totalBeats > RIT_BEATS ? totalBeats - RIT_BEATS : Number.POSITIVE_INFINITY;
        let elapsed = 0;
        let currentBeat = 0;
        let previousVoicing = null;  // 用于声部连接
        const events = [];

        for (const module of progression) {
            const voicing = voiceLeadChord(module, baseOctaveMidis, previousVoicing);
            previousVoicing = voicing;
            const chordMidis = [voicing.bass, voicing.tenor, voicing.alto, voicing.soprano];
            const freqs = chordMidis.map(midiToFreq);

            for (let b = 0; b < module.beats; b++) {
                const beatInMeasure = currentBeat % 4;  // 用原拍数判断小节内位置（不受渐慢影响）
                const isStrong = (beatInMeasure === 0);

                let dur;
                if (module.passing) {
                    dur = beatDuration * 0.5;   // 经过和弦时值短
                } else if (isStrong) {
                    dur = beatDuration * 0.95;
                } else {
                    dur = beatDuration * 0.6;
                }

                // 末尾渐慢（与 buildVocalSchedule 同步，progress^1.5）
                let factor = 1.0;
                if (currentBeat >= ritStartBeat) {
                    const progress = Math.min(1, (currentBeat - ritStartBeat) / RIT_BEATS);
                    factor = 1.0 + (RIT_FINAL_FACTOR - 1.0) * Math.pow(progress, 1.5);
                }
                dur *= factor;

                // 应用偏移并钳制到非负（避免 Tone.Offline/setTimeout 负时间异常）
                events.push({ time: Math.max(0, elapsed + offset), freqs, dur });
                elapsed += beatDuration * factor;
                currentBeat += 1;
            }
        }
        return events;
    }

    // 播放四部和声伴奏：复用 buildPianoSchedule 时间表，用 setTimeout 调度
    function playAccompaniment(generatedData, tempo, pianoOffsetSec) {
        if (!piano || !accompanimentEnabled || pianoMuted) return;

        stopAccompaniment();

        const events = buildPianoSchedule(generatedData, tempo, pianoOffsetSec);
        for (const e of events) {
            const id = setTimeout(() => {
                if (!accompanimentEnabled || !piano || pianoMuted) return;
                piano.triggerAttackRelease(e.freqs, e.dur);
            }, e.time * 1000);
            scheduledTimers.push(id);
        }
    }

    function stopAccompaniment() {
        scheduledTimers.forEach(t => clearTimeout(t));
        scheduledTimers = [];
        if (piano) {
            try { piano.releaseAll(); } catch (e) {}
        }
    }

    // ------------------------------------------------------------
    // 暴露接口（仅此对象对外可见）
    // ------------------------------------------------------------

    global.HarmonyMelody = {
        generateMelody: generateMelody,
        initPiano: initPiano,
        setAccompanimentEnabled: setAccompanimentEnabled,
        isAccompanimentEnabled: isAccompanimentEnabled,
        buildPianoSchedule: buildPianoSchedule,
        playAccompaniment: playAccompaniment,
        stopAccompaniment: stopAccompaniment,
        setPianoVolume: setPianoVolume,
        setPianoMuted: setPianoMuted,
        isAvailable: isAvailable
    };

})(typeof window !== 'undefined' ? window : this);
