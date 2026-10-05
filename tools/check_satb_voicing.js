'use strict';
// 四部和声配声批量审计 + 三和弦模式回归快照
// 用法：
//   node tools/check_satb_voicing.js [目标文件] [段数]
// 例：
//   node tools/check_satb_voicing.js tools/chord_recognition.baseline.js 3000   # 改前基线
//   node tools/check_satb_voicing.js chord_recognition.js 3000                  # 改后

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---- 固定种子 PRNG 覆盖 Math.random，保证改前/改后可复现、可逐字节对比 ----
let _seed = 0x12345678 >>> 0;
const rand = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };
Math.random = rand;
const reseed = () => { _seed = 0x12345678 >>> 0; };

const target = process.argv[2] || path.join(__dirname, '..', 'chord_recognition.js');
const N = parseInt(process.argv[3] || '3000', 10);
const LEN = 16;
const CR = require(path.resolve(target)).ChordRecognition;

function makeSettings(voicingMode) {
    return {
        length: LEN, tempo: 70, allowInversion: false, allowSecondInv: false,
        voicingMode: voicingMode || 'fourpart', legato: 1.0,
        degrees: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true },
        seventhProb: { 1: 0, 2: 40, 3: 0, 4: 10, 5: 70, 6: 0, 7: 30 }
    };
}

// ---- 独立重实现判定（不复用被测模块，避免自证）----
const PAIRS = [[0, 1], [1, 2], [2, 3], [0, 3]];
function isParallel(a, b) {
    for (const [i, j] of PAIRS) {
        const dp = a[j] - a[i], dc = b[j] - b[i];
        if (Math.sign(dp) !== Math.sign(dc)) continue;
        const ap = Math.abs(dp);
        if (ap !== Math.abs(dc)) continue;
        if (ap === 7 || ap === 0 || ap === 12) return true;
    }
    return false;
}
function isOverlap(a, b) {
    for (let i = 0; i < 3; i++) {
        if (b[i] > a[i + 1]) return true;
        if (b[i + 1] < a[i]) return true;
    }
    return false;
}

const S = {
    innerHist: {}, sHist: {},
    innerSteps: 0, innerThirds: 0, innerLeaps: 0, innerBadLeap7: 0,
    overlaps: 0, parallels: 0, similarAll: 0, transitions: 0,
    chords: 0, badLen: 0, badOrder: 0, badRange: 0, dupLeading: 0,
    outOfStd: 0, progs: 0, progsWithOutOfStd: 0, cleanWithin3rd: 0
};

reseed();
for (let t = 0; t < N; t++) {
    const data = CR._generateChordProgression(makeSettings('fourpart'));
    const ch = data.chords;
    S.progs++;
    let anyOut = false;
    for (const c of ch) {
        S.chords++;
        if (c.midis.length !== 4) S.badLen++;
        for (let i = 0; i < 3; i++) if (!(c.midis[i] < c.midis[i + 1])) S.badOrder++;
        c.midis.forEach((m, i) => {
            const r = CR._FOUR_RANGES[i];
            // ±6 = 常规阶梯最多 ±4 + 回溯修补的深度枚举最多 ±6（只为消除超越，极罕见）
            if (m < r[0] - 6 || m > r[1] + 6) S.badRange++;
            if (m < r[0] || m > r[1]) { S.outOfStd++; anyOut = true; }
        });
    }
    if (anyOut) S.progsWithOutOfStd++;
    for (let m = 1; m < ch.length; m++) {
        const a = ch[m - 1].midis, b = ch[m].midis;
        S.transitions++;
        for (const i of [1, 2]) {                       // 内声部 T、A
            const d = Math.abs(b[i] - a[i]);
            S.innerHist[d] = (S.innerHist[d] || 0) + 1;
            if (d <= 2) S.innerSteps++;
            else if (d <= 4) S.innerThirds++;
            else S.innerLeaps++;
            if (d >= 7) S.innerBadLeap7++;
        }
        { const d = Math.abs(b[3] - a[3]); S.sHist[d] = (S.sHist[d] || 0) + 1; }
        if (isOverlap(a, b)) S.overlaps++;
        if (isParallel(a, b)) S.parallels++;
        let up = 0, down = 0;
        for (let i = 0; i < 4; i++) { const d = b[i] - a[i]; if (d > 0) up++; else if (d < 0) down++; }
        if (up === 4 || down === 4) S.similarAll++;
    }
}

const innerTotal = S.innerSteps + S.innerThirds + S.innerLeaps;
const pct = (x, y) => (y ? (100 * x / y).toFixed(3) + '%' : 'n/a');
console.log('==== 目标文件:', target);
console.log('段数:', N, ' 和弦总数:', S.chords, ' 相邻进行数:', S.transitions);
console.log('每和弦 4 音:', S.badLen === 0 ? 'OK' : ('FAIL ' + S.badLen));
console.log('严格升序(无和弦内交叉):', S.badOrder === 0 ? 'OK' : ('FAIL ' + S.badOrder));
console.log('音域(标准+放宽4):', S.badRange === 0 ? 'OK' : ('FAIL ' + S.badRange));
console.log('--- 声部进行 ---');
console.log('内声部 级进(≤2)  :', pct(S.innerSteps, innerTotal));
console.log('内声部 三度(3~4) :', pct(S.innerThirds, innerTotal));
console.log('内声部 三度及以内(= 教材"平稳进行"):', pct(S.innerSteps + S.innerThirds, innerTotal));
console.log('内声部 四度以上(≥5):', pct(S.innerLeaps, innerTotal), ' 其中 ≥7 :', S.innerBadLeap7);
console.log('声部超越 :', S.overlaps, S.overlaps === 0 ? 'OK' : 'FAIL');
console.log('平行五八度 :', S.parallels, S.parallels === 0 ? 'OK' : 'FAIL');
console.log('四部同向 :', S.similarAll, '(' + pct(S.similarAll, S.transitions) + ')');
console.log('超出标准音域的声部数 :', S.outOfStd, '(' + pct(S.outOfStd, S.chords * 4) + ' 的声部)',
    ' 含越界的小节段:', S.progsWithOutOfStd, '/', S.progs,
    '(' + pct(S.progsWithOutOfStd, S.progs) + ')');
console.log('内声部 |运动| 直方图:', JSON.stringify(S.innerHist));
console.log('高音S  |运动| 直方图:', JSON.stringify(S.sHist));
if (CR._getFourPartStats) {
    const st = CR._getFourPartStats();
    const steps = st.cleanStep || st.cleanRelax;
    const tot = steps.reduce((a, b) => a + b, 0) +
        st.fbNoCap + st.fbNoOverlap + st.fbAny + st.fallback;
    console.log('--- 决策路径（阶梯号 : 命中次数）---');
    console.log('cleanStep:', JSON.stringify(steps), ' 第0级占比:', pct(steps[0], tot));
    console.log('兜底: noCap', st.fbNoCap, ' noOverlap', st.fbNoOverlap,
        ' any', st.fbAny, ' fallback', st.fallback,
        ' 合计占比:', pct(st.fbNoCap + st.fbNoOverlap + st.fbAny + st.fallback, tot));
}

// ---- 三和弦模式回归快照（固定种子 → 应与基线逐字节一致）----
reseed();
let snap = '';
for (let t = 0; t < 200; t++) {
    snap += JSON.stringify(CR._generateChordProgression(makeSettings('triad'))) + '\n';
}
console.log('==== triad 快照 sha256:', crypto.createHash('sha256').update(snap).digest('hex'));

// ---- 分解排程断言 ----
const chords3 = [{ midis: [60, 64, 67] }, { midis: [62, 65, 69] }];
const chords4 = [{ midis: [48, 55, 64, 72] }];
function seqOf(chords, mode, tempo) {
    const ev = CR._buildChordSchedule(chords, tempo || 70, mode);
    return ev.map((e) => e.midis.join('+'));
}
console.log('==== 排程断言');
console.log('三和弦 arpeggio 第1小节:', seqOf(chords3, 'arpeggio').slice(0, 16).join(' '));
console.log('四音   arpeggio      :', seqOf(chords4, 'arpeggio').join(' '));
console.log('三和弦 block  事件数:', CR._buildChordSchedule(chords3, 70, 'block').length, '(应 8)');
console.log('三和弦 bass   事件数:', CR._buildChordSchedule(chords3, 70, 'bass').length, '(应 2)');
