#!/bin/bash
# ============================================================
# render_pitch_sweep.sh —— 无头渲染爱丽丝钢琴半音扫描工程
#
# 前置条件（由用户手动完成一次）：
#   已在 REAPER 中打开 tools/render/alicia_pitch_sweep.rpp，
#   在 Kontakt 里加载了 Instruments/Alicias Keys.nki 并 ⌘S 保存，
#   且**已完全退出 REAPER**。
#
# 产出：tools/render/pitch_sweep.wav（约 21 MB / 122 秒）
# ============================================================
set -u

DIR="/Users/chenyiyang/Desktop/视唱练耳 github"
PROJ="$DIR/tools/render/alicia_pitch_sweep.rpp"
OUT="$DIR/tools/render/pitch_sweep.wav"
REAPER="/Applications/REAPER.app/Contents/MacOS/REAPER"
LOG="/tmp/reaper_render.log"
MIN_SIZE=5000000        # 5 MB 下限（实际约 21 MB）

# --- 1. REAPER 单实例转发会把渲染吃掉，必须确认没有实例在跑
if pgrep -f "REAPER.app/Contents/MacOS/REAPER" >/dev/null 2>&1; then
    echo "✗ 检测到 REAPER 正在运行。"
    echo "  命令行渲染会被转发给已开的实例、结果不生效。"
    echo "  请先保存工程并**完全退出 REAPER**，再重跑本脚本。"
    exit 1
fi

if [ ! -f "$PROJ" ]; then
    echo "✗ 找不到工程：$PROJ"
    exit 1
fi

rm -f "$OUT"
echo "▶ 无头渲染中（预计 1~3 分钟）…"
"$REAPER" -nosplash -renderproject "$PROJ" >"$LOG" 2>&1

# --- 2. 完成判定：尺寸连续 3 次相同且超过下限（不要用固定 sleep 猜）
prev=0
same=0
for _ in $(seq 1 150); do
    sleep 2
    sz=$(stat -f%z "$OUT" 2>/dev/null || echo 0)
    if [ "$sz" = "$prev" ] && [ "$sz" -gt "$MIN_SIZE" ]; then
        same=$((same + 1))
    else
        same=0
    fi
    prev=$sz
    if [ "$same" -ge 3 ]; then
        break
    fi
done

sz=$(stat -f%z "$OUT" 2>/dev/null || echo 0)
echo "文件大小：$sz 字节"

if [ "$sz" -lt "$MIN_SIZE" ]; then
    echo "✗ 渲染结果异常（太小或为空）。日志末尾："
    tail -20 "$LOG" 2>/dev/null
    echo
    echo "排查顺序："
    echo "  1) Kontakt 是否已加载 Alicia's Keys.nki（空实例 = 静音）"
    echo "  2) 插件是否离线：/Applications/REAPER.app/Contents/MacOS/REAPER -nosplash -splashlog /tmp/splash.txt \"$PROJ\""
    echo "  3) 库是否处于 Demo / 未授权状态"
    exit 1
fi

echo "✓ 渲染完成：$OUT"
/usr/bin/afinfo "$OUT" 2>/dev/null | head -6
