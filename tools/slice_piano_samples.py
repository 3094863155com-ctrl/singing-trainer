#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
slice_piano_samples.py —— 把 pitch_sweep.wav 切成 49 个单音钢琴采样

输入：tools/render/pitch_sweep.wav（由 render_pitch_sweep.sh 渲染，44.1k/立体声；
      16 或 24bit 都能读 —— REAPER 默认渲 24bit，非 16bit 时自动用 ffmpeg 转一道）
输出：音源/和弦钢琴/piano_<midi>.mp3（MIDI 36 ~ 84 每个半音一个）

处理：
  1. 每个 2.5s 时间槽内做 **onset 检测**（首个超过 −60 dBFS 的采样点）作为起点
     —— 比固定偏移稳，能吸收 Kontakt / 渲染链路的缓冲延迟
  2. 从 onset 起截 2.2s
  3. 峰值归一化到 −1 dBFS（各音等响，利于听辨）
  4. 5ms 淡入 / 40ms 淡出（防爆音）
  5. ffmpeg 编码成 160k mp3

纯标准库实现（wave + array），不需要 numpy。
"""

import array
import os
import subprocess
import sys
import wave
from pathlib import Path

PROJ = Path("/Users/chenyiyang/Desktop/视唱练耳 github")
SRC = PROJ / "tools" / "render" / "pitch_sweep.wav"
OUTDIR = PROJ / "音源" / "和弦钢琴"
TMPDIR = Path("/tmp/piano_slice")
FFMPEG = "/opt/homebrew/bin/ffmpeg"

MIDI_LO, MIDI_HI = 36, 84
SLOT = 2.5          # 每个音占用的时间槽（秒），与 build_pitch_sweep.py 一致
CUT = 2.2           # 截取长度（秒）
TARGET_PEAK = 10 ** (-1 / 20)   # −1 dBFS
THRESH = 10 ** (-60 / 20)       # −60 dBFS 起始阈值
FADE_IN = 0.005
FADE_OUT = 0.040


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        nframes = w.getnframes()
        raw = w.readframes(nframes)
    if nch != 2:
        sys.exit(f"[FAIL] 期望立体声，实际 {nch} 声道")
    if sw != 2:
        # REAPER 默认渲 24bit；交给 ffmpeg 转成 16bit 再读，
        # 免得每换一台机器就要改渲染位深设置
        print(f"  位深 {sw * 8}bit → 用 ffmpeg 转 16bit 读取")
        TMPDIR.mkdir(parents=True, exist_ok=True)
        tmp16 = TMPDIR / "_src16.wav"
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", str(path),
             "-sample_fmt", "s16", "-c:a", "pcm_s16le", str(tmp16)],
            check=True,
        )
        with wave.open(str(tmp16), "rb") as w2:
            nch = w2.getnchannels()
            sr = w2.getframerate()
            raw = w2.readframes(w2.getnframes())
        tmp16.unlink(missing_ok=True)
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples, nch, sr


def write_wav(path, samples, nch, sr):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nch)
        w.setsampwidth(2)
        w.setframerate(sr)
        if sys.byteorder == "big":
            samples.byteswap()
        w.writeframes(samples.tobytes())


def main():
    if not SRC.exists():
        sys.exit(f"[FAIL] 找不到 {SRC}，请先跑 tools/render_pitch_sweep.sh")
    if not os.path.exists(FFMPEG):
        sys.exit(f"[FAIL] 找不到 ffmpeg：{FFMPEG}")

    print(f"读取 {SRC} …")
    samples, nch, sr = read_wav(SRC)
    total_frames = len(samples) // nch
    print(f"  采样率 {sr}，声道 {nch}，时长 {total_frames / sr:.1f}s")

    TMPDIR.mkdir(parents=True, exist_ok=True)
    OUTDIR.mkdir(parents=True, exist_ok=True)

    thresh_abs = THRESH * 32768
    cut_len = int(round(CUT * sr))
    fi_len = int(round(FADE_IN * sr))
    fo_len = int(round(FADE_OUT * sr))

    made = []
    missing = []

    for k in range(MIDI_HI - MIDI_LO + 1):
        midi = MIDI_LO + k
        slot_start = int(round(k * SLOT * sr))
        slot_end = min(total_frames, int(round((k * SLOT + SLOT) * sr)))

        onset = None
        for i in range(slot_start, slot_end):
            base = i * nch
            if abs(samples[base]) > thresh_abs or abs(samples[base + 1]) > thresh_abs:
                onset = i
                break
        if onset is None:
            missing.append(midi)
            continue

        end = min(total_frames, onset + cut_len)
        seg = samples[onset * nch: end * nch]
        n = len(seg) // nch

        peak = 0
        for v in seg:
            a = -v if v < 0 else v
            if a > peak:
                peak = a
        if peak == 0:
            missing.append(midi)
            continue
        gain = (TARGET_PEAK * 32767.0) / peak

        out = array.array("h", [0]) * len(seg)
        for i in range(n):
            g = gain
            if i < fi_len:
                g *= i / fi_len
            elif i >= n - fo_len:
                g *= max(0.0, (n - i) / fo_len)
            for c in range(nch):
                v = seg[i * nch + c] * g
                if v > 32767:
                    v = 32767
                elif v < -32768:
                    v = -32768
                out[i * nch + c] = int(v)

        tmp = TMPDIR / f"piano_{midi}.wav"
        write_wav(tmp, out, nch, sr)

        dst = OUTDIR / f"piano_{midi}.mp3"
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", str(tmp),
             "-codec:a", "libmp3lame", "-b:a", "160k", str(dst)],
            check=True,
        )
        made.append(midi)
        tmp.unlink(missing_ok=True)

    print(f"\n✓ 生成 {len(made)} 个采样到 {OUTDIR}")
    if missing:
        print(f"✗ 有 {len(missing)} 个音在槽内没检测到信号：{missing}")
        print("  多半是 Kontakt 没出声或还没加载音色 —— 请检查渲染结果。")

    # ---- 自检 ----
    bad = []
    for midi in made:
        p = OUTDIR / f"piano_{midi}.mp3"
        if not p.exists() or p.stat().st_size < 3000:
            bad.append(midi)
    if bad:
        print(f"✗ 以下文件异常（缺失或过小）：{bad}")
        return 1

    sizes = [os.path.getsize(OUTDIR / f"piano_{m}.mp3") for m in made]
    if sizes:
        print(f"  单文件大小 {min(sizes)//1024}~{max(sizes)//1024} KB"
              f"，合计 {sum(sizes)/1024/1024:.1f} MB")
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
