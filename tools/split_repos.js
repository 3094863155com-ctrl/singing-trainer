#!/usr/bin/env node
// ============================================================================
// 拆库脚本：把当前 index.html 拆成「和弦听辨页」与「视唱旋律页」两份
//   chord = 和声仓库（本目录）     melody = /Users/chenyiyang/Desktop/melody-trainer/
// 幂等可重跑：每次都从当前 index.html 重新生成两份。
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/chenyiyang/Desktop/视唱练耳 github';
const MELODY = '/Users/chenyiyang/Desktop/melody-trainer';
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lines = src.split('\n');

// ---- 行号一律 1-based ----
const find1 = (pred, from1 = 1) => {
  for (let i = from1 - 1; i < lines.length; i++) if (pred(lines[i])) return i + 1;
  throw new Error('marker not found');
};
const eq = (s) => (l) => l.trim() === s;
const has = (s) => (l) => l.includes(s);
const slice = (a, b) => lines.slice(a - 1, b);   // 1-based 闭区间 [a, b]

// 从 start1 起做花括号计数，返回函数结束行（1-based）
function braceEnd(start1) {
  let depth = 0, started = false;
  for (let i = start1 - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) return i + 1;
  }
  throw new Error('brace end not found from line ' + start1);
}

const scriptOpen = find1(eq('<script>'));
const scriptClose = find1(eq('</script>'), scriptOpen);

const audioCtx = find1(has('let audioContext = null;'));
const bufferCache = find1(has('const bufferCache = new Map();'));
const initAudioStart = find1(eq('function initAudio() {'));
const initAudioEnd = braceEnd(initAudioStart);
const getAudioStart = find1(has('async function getAudioBuffer'));
const getAudioEnd = braceEnd(getAudioStart);
const wavComment = find1(has('AudioBuffer → WAV Blob'));
const wavStart = find1(eq('function audioBufferToWav(buffer) {'));
const wavEnd = braceEnd(wavStart);
const mediaStart = find1(has('// 共享 MediaSession')) - 1;    // 含上面的 // ==== 行
const ensureFnStart = find1(eq('function ensureMediaSession() {'));
const ensureFnEnd = braceEnd(ensureFnStart);
const chordHostStart = find1(has('「和弦听辨」模块桥接')) - 1;
const ensureCall = find1(eq('ensureMediaSession();'), chordHostStart);
const routeStart = find1(has('页面级路由（顶部按钮）')) - 1;
const bodyEnd = scriptClose - 1;

console.log('anchors:', JSON.stringify({
  scriptOpen, audioCtx, bufferCache, initAudioStart, initAudioEnd,
  getAudioStart, getAudioEnd, wavComment, wavEnd, mediaStart,
  ensureFnStart, ensureFnEnd, chordHostStart, ensureCall, routeStart, bodyEnd
}));

// ---- 和弦页内联脚本 = 公共音频能力 + 媒体会话/ChordHost + 路由 ----
const chordBody = [
  '        // ============================================================',
  '        // 宿主音频能力（Web Audio）：供 chord_recognition.js 离线渲染采样用',
  '        // ============================================================',
  '',
  ...slice(audioCtx, bufferCache),              // audioContext + bufferCache
  '',
  ...slice(initAudioStart, initAudioEnd),
  '',
  ...slice(getAudioStart - 2, getAudioEnd),     // 两行注释 + 函数
  '',
  ...slice(wavComment, wavEnd),
  '',
  ...slice(mediaStart, ensureFnEnd),            // 媒体会话中枢（activeMedia* + ensureMediaSession）
  '',
  ...slice(chordHostStart, ensureCall),         // ChordHost 桥接 + ensureMediaSession() 调用
  '',
  ...slice(routeStart, bodyEnd),
  '    '
];

// ---- 视唱页内联脚本 = 全部视唱逻辑（含媒体会话） + ChordHost ----
const melodyBody = [
  ...slice(scriptOpen + 1, chordHostStart - 1),
  ...slice(chordHostStart, ensureCall),
  '    '
];

function dropScriptSrc(text, srcFile) {
  return text.split('\n').filter((l) => !l.includes(`<script src="${srcFile}"`)).join('\n');
}
// 删 [startMark 所在行 .. endMark 所在行]；inclusive=false 时保留 endMark 那一行
function dropBlock(text, startMark, endMark, inclusive = true) {
  const ls = text.split('\n');
  const s = ls.findIndex((l) => l.includes(startMark));
  let e = ls.findIndex((l) => l.includes(endMark));
  if (s < 0 || e < s) throw new Error('block not found: ' + startMark);
  if (!inclusive) e -= 1;
  return ls.slice(0, s).concat(ls.slice(e + 1)).join('\n');
}
function replaceOnce(text, from, to) {
  if (!text.includes(from)) throw new Error('replace target not found: ' + from.slice(0, 60));
  return text.replace(from, to);
}

// ================= 和弦页 =================
let chord = lines.slice(0, scriptOpen).concat(chordBody, lines.slice(scriptClose - 1)).join('\n');
chord = dropScriptSrc(chord, 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js');
chord = dropScriptSrc(chord, 'harmony_melody.js');
chord = dropBlock(chord, '<!-- ============ 视图一：视唱旋律生成', '/#view-singing -->');

// ================= 视唱页 =================
let melody = lines.slice(0, scriptOpen).concat(melodyBody, lines.slice(scriptClose - 1)).join('\n');
melody = dropScriptSrc(melody, 'chord_recognition.js');
melody = dropBlock(melody, '<nav class="app-nav">', '</nav>');
melody = dropBlock(melody, '<!-- ============ 视图二：和弦听辨', '/#view-chord -->');
melody = dropBlock(melody, '<!-- ============ 视图三：数据库', '/.container -->', false);
melody = replaceOnce(melody,
  '<div id="view-singing" style="display: none">',
  '<div id="view-singing">');

fs.writeFileSync(path.join(ROOT, 'index.html'), chord);
fs.mkdirSync(MELODY, { recursive: true });
fs.writeFileSync(path.join(MELODY, 'index.html'), melody);

// 语法自检：两份内联脚本都要能 parse；残留检查只看"会生效"的部分（脚本 + DOM），死 CSS 不算
for (const [name, p, bannedInScript, bannedInDom] of [
  ['chord', path.join(ROOT, 'index.html'),
    ['HarmonyMelody', 'Tone.', 'stopMelody', 'preloadSamples', 'renderToAudio', 'view-singing'],
    ['<script src="harmony_melody.js"', '<script src="https://cdnjs.cloudflare.com', 'id="view-singing"']],
  ['melody', path.join(MELODY, 'index.html'),
    ['ChordRecognition', 'appRouter', 'switchRoot', 'viewChord', 'viewDb'],
    ['<script src="chord_recognition.js"', 'id="view-chord"', 'id="view-db"', '<nav class="app-nav"']]
]) {
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/<script>([\s\S]*)<\/script>/);
  new Function(m[1]);
  const badScript = bannedInScript.filter((w) => m[1].includes(w));
  const badDom = bannedInDom.filter((w) => t.includes(w));
  if (badScript.length || badDom.length) {
    throw new Error(name + ' 页仍有残留: 脚本[' + badScript.join(', ') + '] DOM[' + badDom.join(', ') + ']');
  }
  console.log(name, 'OK,', t.split('\n').length, 'lines, 脚本/DOM 无残留');
}
console.log('DONE');
