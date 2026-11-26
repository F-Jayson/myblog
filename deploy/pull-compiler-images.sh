#!/usr/bin/env bash
# 独立预拉取 / 修复在线编译器镜像，适用于已经部署好的服务器：
#   sudo bash deploy/pull-compiler-images.sh
# 可用环境变量：
#   APP_DIR=/var/www/jayson-blog
#   COMPILER_IMAGE_MIRROR_PREFIX=docker.m.daocloud.io
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/compiler-images.sh
source "${SCRIPT_DIR}/compiler-images.sh"

APP_DIR="${APP_DIR:-/var/www/jayson-blog}"
[[ -d "${APP_DIR}" ]] || die "部署目录不存在：${APP_DIR}"

ensure_compiler_images "${APP_DIR}"
