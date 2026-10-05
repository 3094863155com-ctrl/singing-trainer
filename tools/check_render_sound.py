#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_render_sound.py —— 判定「REAPER 工程渲染出来到底有没有声音」

★ 为什么要渲染才知道答案
  两个「静态判据」实测都会假阴性，都不能用：
    1. 搜库名（`b"Alicias" in blob`）
       → 假阴性。Kontakt 状态块是高熵二进制/加密，已加载的实例里也搜不到库名、`.nki` 路径。
    2. 量状态块体积
       → 也假阴性。实测 366,008 字节的块（空基线 365,896）照样装着音色、渲染有声。
         原因推测：受保护的加密 Player 库在 chunk 里只留少量引用。
  唯一可靠的判据是 **渲染一次 + 量电平**，本脚本默认就干这件事（约 20~40 秒）。

★ 而且它会先查 MAINSEND
  `MAINSEND 0 0` = 轨道不送主输出 = 渲染纯静音。这是最容易把锅甩给插件、冤枉用户的地方。
  排查顺序必须是「先查路由、再查音色」。

用法：
  python3 tools/check_render_sound.py                 # 默认查 tools/render/alicia_pitch_sweep.rpp
  python3 tools/check_render_sound.py 某个工程.rpp
  python3 tools/check_render_sound.py --static        # 只做静态检查，不渲染
退出码：0 = 渲染有声音；1 = 静音 / 配置有问题 / 出错
"""
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PROJ = HERE / "render" / "alicia_pitch_sweep.rpp"

REAPER = "/Applications/REAPER.app/Contents/MacOS/REAPER"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
SILENT_DB = -80.0          # 平均电平低于此值即判定为静音

B64_LINE = re.compile(r"^[A-Za-z0-9+/=]+$")
VST_LINE = re.compile(r'<VST "([^"]*)"')
AU_LINE = re.compile(r'<AU "([^"]*)"')


# ------------------------------------------------------------------ 静态检查

def collect_base64(lines, start):
    """状态块跨多行：从 `<VST ...>` 那行的 `{` 之后开始，收连续 base64 行。"""
    head = lines[start]
    inline = head.split("{", 1)[1] if "{" in head else ""
    chunks = [inline] if inline else []
    j = start + 1
    while j < len(lines):
        s = lines[j].strip()
        if not s or not B64_LINE.match(s):
            break
        chunks.append(s)
        j += 1
    if not chunks:
        return 0
    body = "".join(chunks)
    return len(body) * 3 // 4          # base64 解码后的近似字节数


def instances(lines):
    out = []
    for i, l in enumerate(lines):
        m = VST_LINE.search(l) or AU_LINE.search(l)
        if not m or "Kontakt" not in m.group(1):
            continue
        out.append((i + 1, "AU" if l.strip().startswith("<AU") else "VST3",
                    m.group(1)[:48], collect_base64(lines, i)))
    return out


def mainsends(lines):
    out = []
    for i, l in enumerate(lines):
        m = re.match(r"\s*MAINSEND\s+(\S+)\s+(\S+)", l)
        if m:
            out.append((i + 1, m.group(1)))
    return out


def render_file(lines):
    for l in lines:
        m = re.match(r'\s*RENDER_FILE\s+"(.*)"\s*$', l)
        if m:
            return m.group(1)
    return None


# ------------------------------------------------------------------ 渲染判据

def reaper_running():
    r = subprocess.run(["pgrep", "-f", "REAPER.app/Contents/MacOS/REAPER"],
                       capture_output=True, text=True)
    return r.returncode == 0


def measure(wav):
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", wav,
                        "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    txt = r.stderr
    mean = re.search(r"mean_volume:\s*([-\d.]+) dB", txt)
    peak = re.search(r"max_volume:\s*([-\d.]+) dB", txt)
    return (float(mean.group(1)) if mean else None,
            float(peak.group(1)) if peak else None)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    static_only = "--static" in sys.argv
    proj = Path(args[0]) if args else DEFAULT_PROJ

    if not proj.exists():
        print("✗ 找不到工程：%s" % proj)
        return 1

    lines = proj.read_text(encoding="utf-8", errors="replace").splitlines()
    print("工程：%s" % proj)

    # ---- 1. 路由（静音第一嫌疑）
    ms = mainsends(lines)
    bad_ms = [x for x in ms if x[1] == "0"]
    if bad_ms:
        print("\n✗ 路由有问题：第 %s 行 MAINSEND = 0（轨道不送主输出 → 渲染必然静音）。"
              % ", ".join(str(x[0]) for x in bad_ms))
        print("  → 把这几个 MAINSEND 改成 `MAINSEND 1 0` 再重试。")
        print("  （先修这个，再去怀疑插件/音色。）")
        return 1
    if ms:
        print("✓ 路由正常（%d 条轨道全部 MAINSEND 1 0）" % len(ms))

    # ---- 2. 实例清单（体积仅供参考，不下结论）
    inst = instances(lines)
    if inst:
        print("\nKontakt 实例（体积仅供参考 —— 它判不准，别据此下结论）：")
        for ln, fmt, name, size in inst:
            print("  行%-6d %-5s %-48s 状态块 ≈ %s 字节" % (ln, fmt, name, "{:,}".format(size)))
    else:
        print("\n⚠ 工程里没找到 Kontakt 实例。")

    if static_only:
        print("\n（--static：未渲染。要判定有没有声音，去掉该参数。）")
        return 0

    # ---- 3. 渲染判据（唯一硬判据）
    wav = render_file(lines)
    if not wav:
        print("\n✗ 工程头里没有 RENDER_FILE，无法自动渲染。")
        return 1
    wav = Path(wav)
    if not Path(FFMPEG).exists():
        print("\n✗ 找不到 ffmpeg：%s" % FFMPEG)
        return 1
    if reaper_running():
        print("\n✗ REAPER 正在运行 —— 单实例转发会吃掉命令行渲染，请先完全退出 REAPER（⌘Q）。")
        return 1

    print("\n渲染中（约 20~40 秒）…")
    wav.unlink(missing_ok=True)          # 先删掉旧产物，确保量的是这次的结果
    r = subprocess.run([REAPER, "-nosplash", "-renderproject", str(proj)],
                       capture_output=True, text=True, timeout=600)

    if not wav.exists():
        print("✗ 渲染没有产出文件：%s" % wav)
        if r.stderr.strip():
            print("  REAPER 输出：%s" % r.stderr.strip()[-400:])
        return 1

    size_mb = wav.stat().st_size / 1024 / 1024
    mean, peak = measure(str(wav))
    print("输出：%s（%.1f MB）" % (wav.name, size_mb))
    print("电平：mean %s dB / max %s dB"
          % ("?" if mean is None else "%.1f" % mean,
             "?" if peak is None else "%.1f" % peak))

    if mean is not None and mean <= SILENT_DB:
        print("\n✗ 判定：静音 —— 渲染没有声音。")
        print("  MAINSEND 已确认正常，所以问题在音源侧：")
        print("  → 确认 Kontakt 里已加载 .nki，且**机架中间出现钢琴界面、点虚拟键盘能出声**，")
        print("     然后 ⌘S 保存、⌘Q 退出 REAPER。")
        return 1

    print("\n✓ 判定：渲染有声音。音源侧是通的，可以继续后续流程。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
