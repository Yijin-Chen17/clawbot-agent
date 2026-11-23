#!/usr/bin/env bash
# ==============================================================================
# Clawbot Agent - 公共自动化拉取更新与重启服务脚本
# 适用场景: calcury 本人、其他普通用户 (如 yijin) 或 root (sudo) 登录执行
# ==============================================================================

set -euo pipefail

# 1. 确保统一的 umask，保证同组权限（可读写）
umask 0002

APP_DIR="/home/calcury/app/clawbot-agent"
SERVICE_USER="calcury"
SERVICE_NAME="clawbot-agent"

# 2. 如果当前以 root (或 sudo) 身份运行，自动切换为 calcury 执行以防文件所有权混乱
if [ "$(id -u)" -eq 0 ]; then
    echo "========================================================"
    echo "⚙️ 检测到 root 权限，自动切换为 ${SERVICE_USER} 身份执行..."
    echo "========================================================"
    if command -v runuser >/dev/null 2>&1; then
        exec runuser -u "${SERVICE_USER}" -- "$0" "$@"
    else
        exec su - "${SERVICE_USER}" -c "$0 $*"
    fi
fi

CURRENT_USER="$(whoami)"
echo "========================================================"
echo "🚀 开始更新与重启 Clawbot Agent 服务"
echo "👤 执行账号: ${CURRENT_USER} (UID: $(id -u))"
echo "📅 执行时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================"

# 3. 环境变量准备（补全 nodejs / pnpm / pm2 路径，指向公共 pm2 运行实例）
export PATH="/home/calcury/nodejs/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PM2_HOME="/home/calcury/.pm2"
export GIT_TERMINAL_PROMPT=0

# 4. 检查目录写权限，若当前用户无权修改则友好提示并尝试 sudo
if [ ! -w "${APP_DIR}" ] || [ ! -w "${PM2_HOME}" ]; then
    echo "⚠️ 权限检查: 当前用户 (${CURRENT_USER}) 对应用或 PM2 目录无直接写权限。"
    echo "👉 正在尝试自动通过 sudo 获取必要权限执行..."
    exec sudo "$0" "$@"
fi

# 5. 进入应用目录并设置 git 安全目录
cd "${APP_DIR}"
git config --global --add safe.directory "${APP_DIR}" 2>/dev/null || true

# 6. 从 GitHub main 拉取最新代码（带重试与超时控制，避免卡死）
echo ""
echo "📥 [1/4] 正在拉取 GitHub origin/main 最新代码..."
FETCH_OK=0
for i in 1 2 3; do
    if git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 fetch origin main; then
        FETCH_OK=1
        break
    else
        echo "⚠️ 访问 GitHub 超时或失败，第 $i/3 次重试..."
        sleep 2
    fi
done

if [ "$FETCH_OK" -eq 1 ]; then
    git checkout main
    git merge --ff-only origin/main || git pull origin main --ff-only
    LATEST_COMMIT="$(git log -1 --format='%h - %s (%cr) <%an>')"
    echo "✅ 已同步至最新提交: ${LATEST_COMMIT}"
else
    echo "⚠️ 无法连接至 GitHub，将使用本地最新代码继续执行构建与启动流程。"
fi

# 7. 安装依赖
echo ""
echo "📦 [2/4] 检查并安装项目依赖 (pnpm install)..."
pnpm install

# 8. 编译构建前端
echo ""
echo "🔨 [3/4] 编译前端项目 (pnpm run build)..."
mkdir -p "${APP_DIR}/client/dist"
chmod 2775 "${APP_DIR}/client/dist" 2>/dev/null || true
pnpm run build
chmod -R g+rwX "${APP_DIR}/client/dist" 2>/dev/null || true
find "${APP_DIR}/client/dist" -type d -exec chmod g+s {} + 2>/dev/null || true

# 9. 重启或启动 PM2 服务
echo ""
echo "🔄 [4/4] 重启后台服务 (${SERVICE_NAME})..."
if pm2 describe "${SERVICE_NAME}" >/dev/null 2>&1; then
    pm2 restart "${SERVICE_NAME}"
else
    echo "⚠️ 未发现已运行的 ${SERVICE_NAME} 进程，尝试通过 ecosystem.config.cjs 启动..."
    pm2 start ecosystem.config.cjs
fi

echo ""
echo "========================================================"
echo "🎉 部署完成！当前 PM2 服务状态:"
echo "========================================================"
pm2 status "${SERVICE_NAME}"

echo ""
echo "📋 最新运行日志预览:"
echo "--------------------------------------------------------"
pm2 logs "${SERVICE_NAME}" --lines 15 --nostream
echo "--------------------------------------------------------"
echo "✅ Clawbot Agent 更新并启动成功！"
