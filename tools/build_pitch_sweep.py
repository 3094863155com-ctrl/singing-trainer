#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_pitch_sweep.py —— 生成"爱丽丝钢琴半音扫描"REAPER 工程

用途：
  一次性渲染 MIDI 36(C2) ~ 84(C6) 共 49 个半音、每音一个采样，
  供「视唱练耳」项目的「和弦听辨」页面作为钢琴音源使用。

做法：
  1. 从既有工程 demo_song.rpp 里"借"一个**空的 Kontakt 8 VST3 实例**的完整状态块
     （大型采样器状态块只能借、不能造 —— 见 reaper-rpp-programmatic SKILL 第六节第 6 条）
  2. 组装一个单轨工程：该 Kontakt 实例 + 49 个 MIDI item（每 item 一个长音）
  3. 自检通过后写出 tools/render/alicia_pitch_sweep.rpp

人工步骤（无法脚本化）：
  生成后需用户打开该工程 → 在 Kontakt 里加载 Instruments/Alicias Keys.nki → 保存 → 退出 REAPER
"""

import base64
import re
import sys
import uuid
from pathlib import Path

# ---------------------------------------------------------------- 配置

PROJ_DIR = Path("/Users/chenyiyang/Desktop/视唱练耳 github")
SRC_RPP = Path("/Users/chenyiyang/WorkBuddy/2026-09-27-15-43-55/reaper-pop-song/demo_song.rpp")
OUT_RPP = PROJ_DIR / "tools" / "render" / "alicia_pitch_sweep.rpp"
OUT_WAV = PROJ_DIR / "tools" / "render" / "pitch_sweep.wav"

VST_LINE = ('      <VST "VST3i: Kontakt 8 (Native Instruments) (64 out)" '
            '"Kontakt 8.vst3" 0 "" 952745140{5653544E694B386B6F6E74616B742038} ""')

BPM = 120
PPQ = 960
MIDI_LO, MIDI_HI = 36, 84          # C2 ~ C6
SLOT_SEC = 2.5                     # 每个音占用的时间槽
NOTE_SEC = 2.2                     # 音符实际持续（之后留 0.3s 给止音器衰减）
VELOCITY = 0x5A                    # 90

TICKS = lambda sec: round(sec * BPM * PPQ / 60.0)

# ---------------------------------------------------------------- 工具

def guid():
    return "{" + str(uuid.uuid4()).upper() + "}"


def depth_check(lines):
    """返回 (结尾深度, 最大深度, 首个提前闭合行号)"""
    depth = maxd = 0
    bad = None
    for i, l in enumerate(lines):
        s = l.strip()
        if not s:
            continue
        if s == ">":
            depth -= 1
            if depth < 0 and bad is None:
                bad = (i + 1, l)
        elif s.startswith("<"):
            depth += 1
        maxd = max(maxd, depth)
    return depth, maxd, bad


# ---------------------------------------------------------------- 1. 借空 Kontakt 状态块

def borrow_kontakt_state(src: Path):
    L = src.read_text(encoding="latin1").splitlines()
    heads = [i for i, l in enumerate(L)
             if l.strip().startswith("<VST") and "Kontakt" in l]
    if not heads:
        sys.exit(f"[FAIL] {src} 里找不到 Kontakt 实例")

    for i in heads:
        j, block = i + 1, []
        while j < len(L) and L[j].strip() != ">":
            block.append(L[j].rstrip("\n"))
            j += 1
        if not block:
            continue
        raw = base64.b64decode("".join(s.strip() for s in block))
        txt = raw.decode("latin1")
        nki = re.findall(r"(?i)[A-Za-z0-9_\-\./ ]{4,80}\.nki", txt)
        vendor = [v for v in ("Alicia", "Spitfire", "Studio Drummer", "Keyscape",
                              "Omnisphere", "Trilian", "Tokyo Scoring", "Evolution")
                  if v.lower() in txt.lower()]
        if nki or vendor:
            continue                                  # 已加载音色，跳过
        print(f"[OK] 借用空 Kontakt 实例：{src.name} 第 {i+1} 行，"
              f"{len(block)} 行状态 / {len(''.join(block))} 字符")
        return block, raw

    sys.exit("[FAIL] 没有找到「空」的 Kontakt 实例（全部都已加载音色）")


# ---------------------------------------------------------------- 2. 组装工程

def build_header():
    return [
        f'<REAPER_PROJECT 0.1 "7.67/macOS-arm64" 1790909444 0',
        '  <NOTES 0 2',
        '  >',
        '  RIPPLE 0 0',
        '  GROUPOVERRIDE 0 0 0 0',
        '  AUTOXFADE 129',
        '  ENVATTACH 3',
        '  POOLEDENVATTACH 0',
        '  TCPUIFLAGS 0',
        '  MIXERUIFLAGS 11 48',
        '  ENVFADESZ10 40',
        '  PEAKGAIN 1',
        '  FEEDBACK 0',
        '  PANLAW 1',
        '  PROJOFFS 0 0 0',
        '  MAXPROJLEN 0 0',
        '  GRID 3199 8 1 8 1 0 0 0',
        '  TIMEMODE 1 5 -1 30 0 0 -1 0',
        '  VIDEO_CONFIG 0 0 65792',
        '  PANMODE 3',
        '  PANLAWFLAGS 3',
        '  CURSOR 0',
        '  ZOOM 100 0 0',
        '  VZOOMEX 6 0',
        '  USE_REC_CFG 0',
        '  RECMODE 1',
        '  LOOP 0',
        '  LOOPGRAN 0 4',
        '  RECORD_PATH "Media" ""',
        '  <RECORD_CFG',
        '    ZXZhdxgAAQ==',
        '  >',
        '  <APPLYFX_CFG',
        '  >',
        f'  RENDER_FILE "{OUT_WAV}"',
        '  RENDER_FMT 0 2 44100',
        '  RENDER_1X 0',
        '  RENDER_RANGE 1 0 0 0 1000',
        '  RENDER_RESAMPLE 3 0 1',
        '  RENDER_ADDTOPROJ 0',
        '  RENDER_STEMS 0',
        '  RENDER_DITHER 0',
        '  RENDER_TRIM 0.000001 0.000001 0 0',
        '  TIMELOCKMODE 1',
        '  TEMPOENVLOCKMODE 1',
        '  ITEMMIX 1',
        '  DEFPITCHMODE 589824 0',
        '  TAKELANE 1',
        '  SAMPLERATE 44100 0 0',
        '  <RENDER_CFG',
        '    ZXZhdxgAAQ==',
        '  >',
        '  LOCK 1',
        '  <METRONOME 6 2',
        '    VOL 0.25 0.125',
        '    BEATLEN 4',
        '    FREQ 1760 880 1',
        '    SAMPLES "" "" "" ""',
        '  >',
        '  GLOBAL_AUTO -1',
        f'  TEMPO {BPM} 4 4 0',
        '  PLAYRATE 1 0 0.25 4',
        '  MASTERAUTOMODE 0',
        '  MASTERTRACKHEIGHT 0 0',
        '  MASTERPEAKCOL 16576',
        '  MASTERMUTESOLO 0',
        '  MASTERTRACKVIEW 0 0.6667 0.5 0.5 0 0 0 0 0 0 0 0 0 0 1',
        '  MASTERHWOUT 0 0 1 0 0 0 0 -1',
        '  MASTER_NCH 2 2',
        '  MASTER_VOLUME 1 0 -1 -1 1',
        '  MASTER_PANMODE 3',
        '  MASTER_PANLAWFLAGS 3',
        '  MASTER_FX 1',
        '  MASTER_SEL 0',
        '  <TEMPOENVEX',
        f'    EGUID {guid()}',
        '    ACT 0 -1',
        '    VIS 1 0 1',
        '    LANEHEIGHT 0 0',
        '    ARM 0',
        '    DEFSHAPE 0 -1 -1',
        '  >',
        '  <PROJBAY',
        '  >',
    ]


def build_item(midi, index):
    """一个 MIDI item：note-on 于 0，note-off 于 NOTE_SEC，item 长 SLOT_SEC"""
    off_ticks = TICKS(NOTE_SEC)
    return [
        '    <ITEM',
        f'      POSITION {index * SLOT_SEC:.9f}',
        '      SNAPOFFS 0',
        f'      LENGTH {SLOT_SEC:.9f}',
        '      LOOP 0',
        '      ALLTAKES 0',
        '      FADEIN 1 0 0 1 0 0 0',
        '      FADEOUT 1 0 0 1 0 0 0',
        '      MUTE 0 0',
        '      SEL 0',
        f'      IGUID {guid()}',
        f'      IID {index + 1}',
        f'      NAME "pitch_{midi}"',
        '      VOLPAN 1 0 1 -1',
        '      SOFFS 0 0',
        '      PLAYRATE 1 1 0 -1 0 0.0025',
        '      CHANMODE 0',
        f'      GUID {guid()}',
        '      <SOURCE MIDI',
        f'        HASDATA 1 {PPQ} QN',
        '        CCINTERP 32',
        f'        E 0 90 {midi:02X} {VELOCITY:02X}',
        f'        E {off_ticks} 80 {midi:02X} 00',
        '        CCINTERP 32',
        '        CHASE_CC_TAKEOFFS 1',
        f'        GUID {guid()}',
        f'        IGNTEMPO 0 {BPM} 4 4',
        '        SRCCOLOR 32',
        '        EVTFILTER 0 -1 -1 -1 -1 0 0 0 0 -1 -1 -1 -1 0 -1 0 -1 -1',
        '        VELLANE -1 100 0 0 1',
        '        CFGEDITVIEW 0 0 -1 12 0 0 0 0 0 0.5',
        '        KEYSNAP 0',
        '        TRACKSEL 0',
        '        CFGEDIT 1 1 0 1 0 0 1 1 1 1 1 0.125 0 84 1920 1055 0 0 0 0 0 0 0 1 0 0.5 0 0 1 64',
        '      >',
        '    >',
    ]


def build_track(state_block):
    lines = [
        f'  <TRACK {guid()}',
        '    NAME "PitchSweep"',
        '    PEAKCOL 30299334',
        '    BEAT -1',
        '    AUTOMODE 0',
        '    PANLAWFLAGS 3',
        '    VOLPAN 1 0 -1 -1 1',
        '    MUTESOLO 0 0 0',
        '    IPHASE 0',
        '    PLAYOFFS 0 1',
        '    ISBUS 0 0',
        '    BUSCOMP 0 0 0 0 0',
        '    SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0 0',
        '    FIXEDLANES 9 0 0 0 0',
        '    LANEREC -1 -1 -1 0',
        '    SEL 0',
        '    REC 0 0 1 0 0 0 0 0',
        '    VU 64',
        '    TRACKHEIGHT 0 0 0 0 0 0 0',
        '    INQ 0 0 0 0.5 100 0 0 100',
        '    NCHAN 2',
        '    FX 1',
        f'    TRACKID {guid()}',
        '    PERF 0',
        '    MIDIOUT -1',
        # 必须送到主输出，否则渲染出来是纯静音（踩过一次）
        '    MAINSEND 1 0',
        '    <FXCHAIN',
        '      WNDRECT 10 72 1502 872',
        '      SHOW 0',
        '      LASTSEL 0',
        '      DOCKED 0',
        '      BYPASS 0 0 0',
        VST_LINE,
    ]
    lines += state_block
    lines += [
        '      >',
        '      FLOATPOS 0 0 0 0',
        f'      FXID {guid()}',
        '      WAK 0 0',
        '    >',
    ]
    for k in range(MIDI_HI - MIDI_LO + 1):
        lines += build_item(MIDI_LO + k, k)
    lines.append('  >')
    return lines


# ---------------------------------------------------------------- 3. 自检

def self_check(lines, state_block):
    errs = []

    depth, maxd, bad = depth_check(lines)
    if depth != 0:
        errs.append(f"结尾嵌套深度 {depth}（应为 0）")
    if bad:
        errs.append(f"第 {bad[0]} 行提前闭合：{bad[1]!r}")
    if maxd != 4:
        errs.append(f"最大嵌套深度 {maxd}（应为 4：project→TRACK→FXCHAIN→VST）")

    vst_i = [i for i, l in enumerate(lines) if l.strip().startswith(VST_LINE.strip())]
    if len(vst_i) != 1:
        errs.append(f"Kontakt <VST> 行数 = {len(vst_i)}（应为 1）")
    else:
        nxt = lines[vst_i[0] + 1].strip()
        if not re.fullmatch(r"[A-Za-z0-9+/=]+", nxt):
            errs.append("Kontakt <VST> 行后面没有状态块")

    # 每个 item 的 note-on/off 成对
    ons = [l for l in lines if re.match(r"\s+E 0 90 [0-9A-F]{2} [0-9A-F]{2}$", l)]
    offs = [l for l in lines if re.match(r"\s+E \d+ 80 [0-9A-F]{2} 00$", l)]
    n = MIDI_HI - MIDI_LO + 1
    if len(ons) != n or len(offs) != n:
        errs.append(f"note-on {len(ons)} / note-off {len(offs)}（应各为 {n}）")

    # 音高覆盖 36..84 且无重复
    got = sorted(int(l.split()[3], 16) for l in ons)
    if got != list(range(MIDI_LO, MIDI_HI + 1)):
        errs.append(f"音高覆盖不正确：{got[:3]}…{got[-3:]}")

    # GUID 唯一
    gs = re.findall(r"\{[0-9A-Fa-f\-]{36}\}", "\n".join(lines))
    dup = {g for g in gs if gs.count(g) > 1}
    if dup:
        errs.append(f"重复 GUID {len(dup)} 个：{sorted(dup)[:3]}")

    # 状态块未被改动
    rebuilt = "".join(s.strip() for s in state_block)
    if not rebuilt:
        errs.append("状态块为空")

    return errs


# ---------------------------------------------------------------- main

def main():
    if OUT_RPP.exists():
        print(f"[SKIP] {OUT_RPP} 已存在（防重复执行护栏）。"
              f"如需重建请先删除该文件。")
        sys.exit(2)

    state_block, _raw = borrow_kontakt_state(SRC_RPP)

    lines = build_header() + build_track(state_block) + ['>']

    errs = self_check(lines, state_block)
    if errs:
        print("[FAIL] 自检未通过：")
        for e in errs:
            print("   -", e)
        sys.exit(1)

    OUT_RPP.parent.mkdir(parents=True, exist_ok=True)
    # 注意：RENDER_FILE 里含中文路径，必须用 utf-8 写（RPP 支持 UTF-8）
    OUT_RPP.write_text("\n".join(lines) + "\n", encoding="utf-8")

    n = MIDI_HI - MIDI_LO + 1
    dur = n * SLOT_SEC
    print(f"[OK] 已写出 {OUT_RPP}")
    print(f"     {n} 个音（MIDI {MIDI_LO}~{MIDI_HI}），"
          f"{SLOT_SEC}s/音，总时长约 {dur:.0f}s")
    print(f"     渲染目标 {OUT_WAV}")


if __name__ == "__main__":
    main()
