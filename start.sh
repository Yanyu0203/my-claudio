#!/usr/bin/env bash
# ============================================================
# Vox 一键启动
#   - 启动 QQMusicApi (localhost:3300, 带你的 QQ 号)
#   - 启动 Vox    (localhost:8080)
#   - 日志分别输出到 logs/
#   - Ctrl+C 时一起清理
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

QQMUSIC_DIR="$ROOT/QQMusicApi"
VOX_DIR="$ROOT/vox"
LOG_DIR="$ROOT/logs"
COOKIE_FILE="$ROOT/data/qq_cookie.json"

# ---------- 读 QQ_UIN：优先 env 变量 > vox/.env > 占位 ----------
# 真实的 QQ 号只会存在 vox/.env（已被 .gitignore），脚本里不写死任何个人信息
if [ -z "${QQ_UIN:-}" ] && [ -f "$VOX_DIR/.env" ]; then
  QQ_UIN=$(grep -E '^QQ_UIN=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
fi
QQ_UIN="${QQ_UIN:-}"

# 如果 QQ_UIN 仍空/占位 → 引导用户现在就填（否则 QQMusicApi 的 globalCookie 会对不上）
case "$QQ_UIN" in
  ''|123456789|1234567890|YOUR_QQ|your_qq)
    echo ""
    echo "[vox] ⚠️  没检测到真实 QQ_UIN"
    echo "[vox]    现在帮你填一下（需要你的 QQ 号，不用密码）"
    echo ""
    (cd "$VOX_DIR" && [ -d node_modules ] || npm install --silent)
    (cd "$VOX_DIR" && node scripts/setup-qquin.js) || {
      echo "❌ setup:qquin 失败，请手动编辑 $VOX_DIR/.env 添加 QQ_UIN=你的QQ号"
      exit 1
    }
    # 重新读
    QQ_UIN=$(grep -E '^QQ_UIN=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
    case "$QQ_UIN" in
      ''|123456789|1234567890|YOUR_QQ|your_qq)
        echo "❌ QQ_UIN 仍未填，退出"
        exit 1
        ;;
    esac
    echo "[vox] ✅ QQ_UIN 已保存到 $VOX_DIR/.env"
    echo ""
    ;;
esac

mkdir -p "$LOG_DIR"

# ---------- 清理老进程 ----------
echo "[vox] 清理老进程..."
pkill -f "QQMusicApi/bin/www" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# ---------- 启动 QQMusicApi ----------
if ! curl -sf -o /dev/null "http://127.0.0.1:3300" 2>/dev/null; then
  if [ ! -d "$QQMUSIC_DIR" ]; then
    echo ""
    echo "❌ 找不到 QQMusicApi 目录: $QQMUSIC_DIR"
    echo ""
    echo "   正常情况下 my-vox 仓库里自带这个目录。你这份似乎缺失，"
    echo "   可以重新拉一次仓库，或手动 clone 兜底:"
    echo "     cd $ROOT"
    echo "     git clone https://github.com/jsososo/QQMusicApi.git"
    echo "     cd QQMusicApi && npm install"
    echo ""
    echo "   完整指引看 SETUP.md 「步骤 3」"
    echo ""
    exit 1
  fi
  if [ ! -d "$QQMUSIC_DIR/node_modules" ]; then
    echo "[vox] QQMusicApi 首次使用，自动装依赖..."
    (cd "$QQMUSIC_DIR" && npm install --silent) || {
      echo "❌ QQMusicApi 装依赖失败，手动跑:"
      echo "     cd $QQMUSIC_DIR && npm install"
      echo ""
      exit 1
    }
  fi
  echo "[vox] 启动 QQMusicApi (QQ=$QQ_UIN) ..."
  (cd "$QQMUSIC_DIR" && QQ="$QQ_UIN" yarn start > "$LOG_DIR/qqmusicapi.log" 2>&1) &
  QQMUSIC_PID=$!

  # 等它起来
  for i in {1..20}; do
    if curl -sf -o /dev/null "http://127.0.0.1:3300"; then break; fi
    sleep 0.5
  done
  echo "[vox] QQMusicApi PID=$QQMUSIC_PID"
else
  echo "[vox] QQMusicApi 已在运行"
fi

# ---------- 喂 cookie (如果 cookie 文件存在) ----------
# 每次启动都重推：cookie 可能已更新；QQMusicApi 进程内的 cookie 也会在上面重启时丢失
if [ -f "$COOKIE_FILE" ]; then
  echo "[vox] 推送 cookie 到 QQMusicApi..."
  RESP=$(curl -s -X POST http://127.0.0.1:3300/user/setCookie \
    -H "Content-Type: application/json" \
    -d @"$COOKIE_FILE")
  if echo "$RESP" | grep -q '"result":100'; then
    echo "[vox] cookie 推送成功"
  else
    echo "[vox] ⚠️  cookie 推送响应异常: $RESP"
    echo "[vox]    （继续启动，但可能只能播非 VIP 歌曲）"
  fi
fi

# ---------- 启动 Vox ----------
echo "[vox] 启动 Vox..."
(cd "$VOX_DIR" && node server.js 2>&1 | tee "$LOG_DIR/vox.log") &
VOX_PID=$!

# ---------- Ctrl+C 优雅退出 ----------
cleanup() {
  echo ""
  echo "[vox] 收到退出信号，清理..."
  kill "$VOX_PID" 2>/dev/null || true
  pkill -f "QQMusicApi/bin/www" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "[vox] 已退出"
  exit 0
}
trap cleanup INT TERM

echo ""
echo "============================================="
echo " 🎧 Vox 启动中"
echo "   前端     : http://localhost:8080"
echo "   QQMusicApi: http://localhost:3300"
echo "   日志     : $LOG_DIR/"
echo "   Ctrl+C 一起退出"
echo "============================================="
echo ""

wait "$VOX_PID"
