#!/usr/bin/env bash
# ==============================================================================
# tern-bot 一键安装与环境配置脚本
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== [1/6] 检查前置运行环境 ==="
command -v bun >/dev/null 2>&1 || { echo "错误: 未找到 bun，请先安装 Bun (https://bun.sh)" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "错误: 未找到 docker，请先启动 Docker / OrbStack" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "错误: 未找到 python3" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "错误: 未找到 tar" >&2; exit 1; }

echo "  ✓ Bun: $(bun --version)"
echo "  ✓ Docker: $(docker --version | head -n1)"
echo "  ✓ Python: $(python3 --version)"
echo "  ✓ Tar: $(tar --version 2>&1 | head -n1)"

echo ""
echo "=== [2/6] 安装 Node 依赖 ==="
bun install

echo ""
echo "=== [3/6] 检查代码包类型与格式 ==="
bun run check

echo ""
echo "=== [4/6] 构建沙箱 Docker 镜像 (tern-bot-sandbox:dev) ==="
if [[ "${SKIP_DOCKER_BUILD:-0}" == "1" ]]; then
  echo "  [跳过] 已设置 SKIP_DOCKER_BUILD=1"
else
  echo "  开始构建 Docker 镜像 packages/sandbox-image/Dockerfile ..."
  docker build -t tern-bot-sandbox:dev packages/sandbox-image
  echo "  ✓ 沙箱镜像构建完成: tern-bot-sandbox:dev"
fi

echo ""
echo "=== [5/6] 初始化沙箱 Agent HOME 配置模板 ==="
DEFAULT_SANDBOX_CFG="${HOME}/.config/tern-bot/sandbox-cfg"
mkdir -p "${DEFAULT_SANDBOX_CFG}/.omp/agent"

if [[ ! -f "${DEFAULT_SANDBOX_CFG}/.omp/agent/config.yml" ]]; then
  cp templates/sandbox-cfg/.omp/agent/config.yml "${DEFAULT_SANDBOX_CFG}/.omp/agent/config.yml"
  echo "  ✓ 已创建默认配置: ${DEFAULT_SANDBOX_CFG}/.omp/agent/config.yml"
else
  echo "  • 已存在配置: ${DEFAULT_SANDBOX_CFG}/.omp/agent/config.yml (保留)"
fi

if [[ ! -f "${DEFAULT_SANDBOX_CFG}/.omp/agent/models.yml" ]]; then
  cp templates/sandbox-cfg/.omp/agent/models.yml "${DEFAULT_SANDBOX_CFG}/.omp/agent/models.yml"
  echo "  ✓ 已创建模型示例: ${DEFAULT_SANDBOX_CFG}/.omp/agent/models.yml"
  echo "    提示: 请根据实际环境修改其中的 baseUrl 和 apiKey"
else
  echo "  • 已存在模型配置: ${DEFAULT_SANDBOX_CFG}/.omp/agent/models.yml (保留)"
fi

chmod 700 "${DEFAULT_SANDBOX_CFG}" || true
chmod 600 "${DEFAULT_SANDBOX_CFG}/.omp/agent/"*.yml 2>/dev/null || true

echo ""
echo "=== [6/6] 链接 Tern 插件 ==="
if command -v tern >/dev/null 2>&1; then
  PLUGIN_DIR="${ROOT_DIR}/packages/tern-plugin"
  echo "  正在链接 Tern 插件: ${PLUGIN_DIR}"
  tern plugin link "${PLUGIN_DIR}" || true
  echo "  正在重载插件..."
  tern plugin reload tern-bot 2>/dev/null || true
  echo "  ✓ Tern 插件链接就绪"
else
  echo "  提示: 未检测到 tern CLI，如已安装 Tern，可通过 'tern plugin link ${ROOT_DIR}/packages/tern-plugin' 手动安装"
fi

echo ""
echo "=============================================================================="
echo "  tern-bot 全套组件安装完毕！"
echo ""
echo "  快速启动与使用:"
echo "  1. 在 Tern 中按 Cmd+P 打开命令面板，输入 'Create Bot' 启动一个新 Bot。"
echo "  2. 选定目标项目工作区与 Bot 名称，即可在专属看板中派发 Worker 任务。"
echo "  3. 任务完成后自动提交，Bot 启动审核沙箱并利用 CDP / AX 树进行自动化验证。"
echo "=============================================================================="
