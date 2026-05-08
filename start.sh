#!/usr/bin/env bash
# ============================================================
# Vox 一键启动
#   - 根据 MUSIC_PROVIDER 决定要不要启动 QQMusicApi
#     * qq:     启 QQMusicApi (localhost:3300) + 推 cookie
#     * netease: 无需额外服务
#   - 启动 Vox (localhost:8080)
#   - 日志输出到 logs/
#   - Ctrl+C 时一起清理
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

QQMUSIC_DIR="$ROOT/QQMusicApi"
API_ENHANCED_DIR="$ROOT/api-enhanced"
VOX_DIR="$ROOT/vox"
LOG_DIR="$ROOT/logs"
QQ_COOKIE_FILE="$ROOT/data/qq_cookie.json"

# ---------- 读 MUSIC_PROVIDER ----------
# 优先级：环境变量 > .env > 交互式弹问（仅首次）
HAS_PROVIDER_LINE=0
if [ -f "$VOX_DIR/.env" ] && grep -qE '^MUSIC_PROVIDER=' "$VOX_DIR/.env"; then
  HAS_PROVIDER_LINE=1
fi

if [ -z "${MUSIC_PROVIDER:-}" ] && [ "$HAS_PROVIDER_LINE" = "1" ]; then
  MUSIC_PROVIDER=$(grep -E '^MUSIC_PROVIDER=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
fi

# 还是没值 → 首次启动，交互式问用户
if [ -z "${MUSIC_PROVIDER:-}" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo ""
    echo "[vox] 第一次启动，先选个音乐源..."
    (cd "$VOX_DIR" && [ -d node_modules ] || npm install --silent)
    (cd "$VOX_DIR" && node scripts/setup-provider.js) || {
      echo "❌ setup:provider 失败，请手动编辑 $VOX_DIR/.env 添加 MUSIC_PROVIDER=qq 或 MUSIC_PROVIDER=netease"
      exit 1
    }
    MUSIC_PROVIDER=$(grep -E '^MUSIC_PROVIDER=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
  else
    echo "❌ 没设 MUSIC_PROVIDER，且当前不在交互式终端，无法弹问"
    echo "   请编辑 $VOX_DIR/.env 添加一行：MUSIC_PROVIDER=netease （或 qq）"
    exit 1
  fi
fi
MUSIC_PROVIDER="${MUSIC_PROVIDER:-}"

case "$MUSIC_PROVIDER" in
  qq|netease) ;;
  *) echo "❌ 不支持的 MUSIC_PROVIDER=\"$MUSIC_PROVIDER\"，支持: qq / netease"; exit 1 ;;
esac

echo "[vox] music provider = $MUSIC_PROVIDER"

mkdir -p "$LOG_DIR"

# ---------- 清理老进程 ----------
echo "[vox] 清理老进程..."
pkill -f "QQMusicApi/bin/www" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# ============================================================
# 分支 A：qq provider —— 需要 QQMusicApi 服务 + QQ_UIN
# ============================================================
if [ "$MUSIC_PROVIDER" = "qq" ]; then
  # QQ_UIN 检查 / 交互
  if [ -z "${QQ_UIN:-}" ] && [ -f "$VOX_DIR/.env" ]; then
    QQ_UIN=$(grep -E '^QQ_UIN=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
  fi
  QQ_UIN="${QQ_UIN:-}"
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
      QQ_UIN=$(grep -E '^QQ_UIN=' "$VOX_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
      case "$QQ_UIN" in
        ''|123456789|1234567890|YOUR_QQ|your_qq)
          echo "❌ QQ_UIN 仍未填，退出"; exit 1 ;;
      esac
      echo "[vox] ✅ QQ_UIN 已保存到 $VOX_DIR/.env"
      echo ""
      ;;
  esac

  # 启动 QQMusicApi
  if ! curl -sf -o /dev/null "http://127.0.0.1:3300" 2>/dev/null; then
    if [ ! -d "$QQMUSIC_DIR" ]; then
      echo "❌ 找不到 QQMusicApi 目录: $QQMUSIC_DIR"
      echo "   仓库里正常自带；如果缺失："
      echo "     git clone https://github.com/jsososo/QQMusicApi.git"
      echo "     cd QQMusicApi && npm install"
      exit 1
    fi
    if [ ! -d "$QQMUSIC_DIR/node_modules" ]; then
      echo "[vox] QQMusicApi 首次使用，自动装依赖..."
      (cd "$QQMUSIC_DIR" && npm install --silent) || {
        echo "❌ QQMusicApi 装依赖失败"; exit 1
      }
    fi
    echo "[vox] 启动 QQMusicApi (QQ=$QQ_UIN) ..."
    (cd "$QQMUSIC_DIR" && QQ="$QQ_UIN" yarn start > "$LOG_DIR/qqmusicapi.log" 2>&1) &
    for i in {1..20}; do
      if curl -sf -o /dev/null "http://127.0.0.1:3300"; then break; fi
      sleep 0.5
    done
  else
    echo "[vox] QQMusicApi 已在运行"
  fi

  # 每次启动都重推 cookie（cookie 可能更新 / 重启后进程内 cookie 也要重推）
  if [ -f "$QQ_COOKIE_FILE" ]; then
    echo "[vox] 推送 cookie 到 QQMusicApi..."
    RESP=$(curl -s -X POST http://127.0.0.1:3300/user/setCookie \
      -H "Content-Type: application/json" \
      -d @"$QQ_COOKIE_FILE")
    if echo "$RESP" | grep -q '"result":100'; then
      echo "[vox] cookie 推送成功"
    else
      echo "[vox] ⚠️  cookie 推送响应异常: $RESP"
      echo "[vox]    （继续启动，但可能只能播非 VIP 歌曲）"
    fi
  fi
fi

# ============================================================
# 分支 B：netease provider —— 只需 api-enhanced 依赖装好
# ============================================================
# api-enhanced 不打包进本仓库（避免和上游冲突 + 减小体积）
# 用 pin 的 commit 保证用户拿到的是我们测过的版本，避免上游突然改 breaking
# 升级方法见 README "网易云 API 版本管理" 一节
API_ENHANCED_REPO="https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git"
API_ENHANCED_PIN="15fa49a2e8e63456a58e0ec1e81f7283176bd4b2"  # main @ 2026-05

if [ "$MUSIC_PROVIDER" = "netease" ]; then
  if [ ! -d "$API_ENHANCED_DIR" ]; then
    echo "[vox] 没找到 api-enhanced，自动 clone（一次性，需要联网）..."
    if ! command -v git >/dev/null 2>&1; then
      echo "❌ 没装 git，无法 clone api-enhanced。"
      echo "   请先装 git，或手动跑：git clone $API_ENHANCED_REPO $API_ENHANCED_DIR"
      exit 1
    fi
    if ! git clone "$API_ENHANCED_REPO" "$API_ENHANCED_DIR"; then
      echo "❌ clone api-enhanced 失败（网络问题？）"
      echo "   手动跑：git clone $API_ENHANCED_REPO $API_ENHANCED_DIR"
      exit 1
    fi
    # checkout 到 pin 的 commit，保证版本可控
    if ! (cd "$API_ENHANCED_DIR" && git checkout "$API_ENHANCED_PIN" 2>/dev/null); then
      echo "[vox] ⚠️  checkout pin commit ($API_ENHANCED_PIN) 失败，使用上游 main 最新版"
      echo "[vox]    如果遇到接口报错，可能是上游 breaking 了，提个 issue"
    else
      echo "[vox] ✅ api-enhanced 已 checkout 到 pin commit ${API_ENHANCED_PIN:0:7}"
    fi
  fi
  if [ ! -d "$API_ENHANCED_DIR/node_modules" ]; then
    echo "[vox] api-enhanced 首次使用，自动装依赖..."
    (cd "$API_ENHANCED_DIR" && npm install --silent) || {
      echo "❌ api-enhanced 装依赖失败，手动跑: cd api-enhanced && npm install"
      exit 1
    }
  fi
  echo "[vox] api-enhanced 已就绪（作为进程内模块，不额外启服务）"
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
echo " 🎧 Vox 启动中（${MUSIC_PROVIDER}）"
echo "   前端       : http://localhost:8080"
if [ "${MUSIC_PROVIDER}" = "qq" ]; then
  echo "   QQMusicApi : http://localhost:3300"
fi
echo "   日志       : ${LOG_DIR}/"
echo "   Ctrl+C 一起退出"
echo "============================================="
echo ""

wait "$VOX_PID"
