#!/usr/bin/env bash
# ============================================================
# Claudio 一键启动
#   - 启动 QQMusicApi (localhost:3300, 带你的 QQ 号)
#   - 启动 Claudio    (localhost:8080)
#   - 日志分别输出到 logs/
#   - Ctrl+C 时一起清理
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

QQ_UIN="${QQ_UIN:-1829981984}"
QQMUSIC_DIR="$ROOT/QQMusicApi"
CLAUDIO_DIR="$ROOT/claudio"
LOG_DIR="$ROOT/logs"
COOKIE_FILE="$ROOT/data/qq_cookie.json"

mkdir -p "$LOG_DIR"

# ---------- 清理老进程 ----------
echo "[claudio] 清理老进程..."
pkill -f "QQMusicApi/bin/www" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# ---------- 启动 QQMusicApi ----------
if ! curl -sf -o /dev/null "http://127.0.0.1:3300" 2>/dev/null; then
  if [ ! -d "$QQMUSIC_DIR" ]; then
    echo ""
    echo "❌ 找不到 QQMusicApi 目录: $QQMUSIC_DIR"
    echo ""
    echo "   QQMusicApi 不在本 repo 里，需要单独 clone:"
    echo "     cd $ROOT"
    echo "     git clone https://github.com/jsososo/QQMusicApi.git"
    echo "     cd QQMusicApi && npm install"
    echo ""
    echo "   完整指引看 SETUP.md 「步骤 3」"
    echo ""
    exit 1
  fi
  if [ ! -d "$QQMUSIC_DIR/node_modules" ]; then
    echo "❌ QQMusicApi 还没装依赖。请先跑:"
    echo "     cd $QQMUSIC_DIR && npm install"
    echo ""
    echo "   如果报 'certificate has expired'，看 SETUP.md「步骤 3.2」"
    exit 1
  fi
  echo "[claudio] 启动 QQMusicApi (QQ=$QQ_UIN) ..."
  (cd "$QQMUSIC_DIR" && QQ="$QQ_UIN" yarn start > "$LOG_DIR/qqmusicapi.log" 2>&1) &
  QQMUSIC_PID=$!

  # 等它起来
  for i in {1..20}; do
    if curl -sf -o /dev/null "http://127.0.0.1:3300"; then break; fi
    sleep 0.5
  done
  echo "[claudio] QQMusicApi PID=$QQMUSIC_PID"
else
  echo "[claudio] QQMusicApi 已在运行"
fi

# ---------- 喂 cookie (如果 cookie 文件存在) ----------
if [ -f "$COOKIE_FILE" ]; then
  if [ ! -f "$QQMUSIC_DIR/data/cookie.json" ] || \
     [ $(stat -f %z "$QQMUSIC_DIR/data/cookie.json" 2>/dev/null || echo 0) -lt 100 ]; then
    echo "[claudio] 喂 cookie 到 QQMusicApi..."
    curl -s -X POST http://127.0.0.1:3300/user/setCookie \
      -H "Content-Type: application/json" \
      -d @"$COOKIE_FILE" > /dev/null
    echo "[claudio] cookie 已设置"
  fi
fi

# ---------- 启动 Claudio ----------
echo "[claudio] 启动 Claudio..."
(cd "$CLAUDIO_DIR" && node server.js 2>&1 | tee "$LOG_DIR/claudio.log") &
CLAUDIO_PID=$!

# ---------- Ctrl+C 优雅退出 ----------
cleanup() {
  echo ""
  echo "[claudio] 收到退出信号，清理..."
  kill "$CLAUDIO_PID" 2>/dev/null || true
  pkill -f "QQMusicApi/bin/www" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "[claudio] 已退出"
  exit 0
}
trap cleanup INT TERM

echo ""
echo "============================================="
echo " 🎧 Claudio 启动中"
echo "   前端     : http://localhost:8080"
echo "   QQMusicApi: http://localhost:3300"
echo "   日志     : $LOG_DIR/"
echo "   Ctrl+C 一起退出"
echo "============================================="
echo ""

wait "$CLAUDIO_PID"
