'use strict';
// 诊断：找出"既无平行、又无超越"的候选不存在的那些和弦连接
const path = require('path');
const CR = require(path.resolve(__dirname, '..', process.argv[2] || 'chord_recognition.js')).ChordRecognition;

let _seed = 0x12345678 >>> 0;
Math.random = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };

const settings = {
    length: 16, tempo: 70, allowInversion: false, allowSecondInv: false,
    voicingMode: 'fourpart', legato: 1.0,
    degrees: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
    seventhProb: { 1: 0, 2: 40, 3: 0, 4: 10, 5: 70, 6: 0, 7: 30 }
};

let tr = 0, none = 0, samples = [];
for (let t = 0; t < 400; t++) {
    const d = CR._generateChordProgression(settings);
    for (let m = 1; m < d.chords.length; m++) {
        const a = d.chords[m - 1].midis;
        const c = d.chords[m];
        if (CR._hasOverlap(a, c.midis) === false) {
            // 不看结果，只看"空间"：所有 relax 下有没有既无平行又无超越的候选
        }
        tr++;
        let found = null;
        const counts = [];
        for (let relax = 0; relax <= 3; relax++) {
            const cands = CR._buildFourPartCandidates(d.scale, c.degree, !!c.seventh, false, false, relax);
            const ok = cands.filter((x) => !CR._hasParallel(a, x.midis) && !CR._hasOverlap(a, x.midis));
            counts.push(ok.length);
            if (ok.length && !found) found = { relax: relax, n: ok.length };
        }
        if (!found) {
            none++;
            if (samples.length < 8) samples.push({ prev: a, deg: c.degree, sev: !!c.seventh, counts: counts, mode: d.key });
        }
    }
}
console.log('连接数:', tr, ' 完全无"无平行且无超越"候选:', none, '(' + (100 * none / tr).toFixed(4) + '%)');
console.log(JSON.stringify(samples, null, 1));
