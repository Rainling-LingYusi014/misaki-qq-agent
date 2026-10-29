#!/usr/bin/env bash
# B 站投稿封面生成：视频抽帧 → 压暗底栏 → 中文标题（1280x720 JPEG）
# 用法: make-cover.sh <video> <title> <out.jpg> [seek_seconds]
# 不加署名水印 —— 水印交给 B 站自带的投稿选项（主人 2026-10-29 定）。
# 依赖: ffmpeg + 中文字体（fonts-wqy-zenhei）；没有中文字体时自动退回可用字体。
set -euo pipefail
# 标题折行不能用 fold：本机 glibc 的 fold 无论 locale 都按**字节**计数，
# 16 字节正好把「氛」劈成两半 → 渲染成方块（实测两次）。改用 python3 按字符折行。
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

VIDEO="${1:?video path required}"
TITLE="${2:-}"
OUT="${3:?output path required}"
SEEK="${4:-2}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FONT="/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
if [ ! -f "$FONT" ]; then
  FONT="$(fc-match -f '%{file}' 'WenQuanYi Zen Hei:lang=zh' 2>/dev/null | head -1 || true)"
fi
if [ -z "${FONT:-}" ] || [ ! -f "$FONT" ]; then
  FONT="$(fc-match -f '%{file}' 'sans' 2>/dev/null | head -1 || true)"
fi
[ -n "${FONT:-}" ] && [ -f "$FONT" ] || { echo "no usable font" >&2; exit 2; }

# 标题最多两行，每行 16 个字符；多余部分截断（B 站标题最长 80 字，封面上放不下那么多）
python3 - "$TITLE" > "$TMP/title.txt" <<'PY'
import sys, textwrap
t = ' '.join(str(sys.argv[1] if len(sys.argv) > 1 else '').split())
lines = textwrap.wrap(t, width=16)[:2]
print('\n'.join(lines))
PY

ffmpeg -hide_banner -loglevel error -y -ss "$SEEK" -i "$VIDEO" -frames:v 1 \
  -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,\
drawbox=x=0:y=420:w=1280:h=300:color=black@0.58:t=fill,\
drawtext=fontfile='${FONT}':textfile='${TMP}/title.txt':fontcolor=white:fontsize=52:x=64:y=470:line_spacing=12" \
  -q:v 2 "$OUT"

echo "cover: $OUT ($(stat -c%s "$OUT") bytes, font=${FONT##*/})"
