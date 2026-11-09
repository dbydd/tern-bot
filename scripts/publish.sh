#!/usr/bin/env bash
# ==============================================================================
# tern-bot 各子包一键 npm 发布脚本
#
# 使用方式：
#   ./scripts/publish.sh           # 发布所有尚未发布过当前版本的子包
#   ./scripts/publish.sh --dry     # 只打印将执行的命令，不实际发布
#
# 前置要求：
#   - 已通过 `npm login`（或 `bun pm trust`）登录 npm 账号，scope 为 @dbydd
#   - @onlyne/* 底层依赖包已发布（本脚本不负责 onlyne）
# ==============================================================================
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry" || "${1:-}" == "-n" ]]; then
  DRY_RUN=1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 按依赖顺序排列：tavern-harness → bdfl-engine → tern-plugin → bot-daemon
PACKAGES=(
  "packages/tavern-harness"
  "packages/bdfl-engine"
  "packages/tern-plugin"
  "packages/bot-daemon"
)

echo "=== 检查 npm 登录状态 ==="
if ! npm whoami >/dev/null 2>&1; then
  echo "错误: 未登录 npm，请先执行 'npm login'（scope: @dbydd）" >&2
  exit 1
fi
NPM_USER="$(npm whoami)"
echo "  ✓ 已登录 npm 账号: ${NPM_USER}"

if [[ "$NPM_USER" != "dbydd" ]]; then
  echo "警告: 当前登录账号 '${NPM_USER}' 与 @dbydd scope 不匹配，发布可能会被拒绝" >&2
fi

echo ""
echo "=== 逐包检查版本并发布 ==="

for pkg_dir in "${PACKAGES[@]}"; do
  pkg_json="${pkg_dir}/package.json"
  pkg_name="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$pkg_json")"
  pkg_version="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$pkg_json")"

  # 判断该版本是否已在 npm 上存在
  if npm view "${pkg_name}@${pkg_version}" version >/dev/null 2>&1; then
    echo "  • ${pkg_name}@${pkg_version} 已存在，跳过"
    continue
  fi

  echo "  ▶ 发布 ${pkg_name}@${pkg_version} ..."
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    [dry-run] (cd ${pkg_dir} && npm publish --access public)"
  else
    (cd "$pkg_dir" && npm publish --access public)
  fi
  echo "  ✓ ${pkg_name}@${pkg_version} 发布完成"
done

echo ""
echo "=== 全部发布流程结束 ==="
