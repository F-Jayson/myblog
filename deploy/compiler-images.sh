#!/usr/bin/env bash
# 在线编译器镜像清单与拉取工具。
#
# 背景：apps/api/src/compiler.ts 运行时固定使用 `docker run --pull=never`，
# 所以镜像必须在部署阶段就以「原始名称」存在本机。服务器直连 Docker Hub 或
# mcr.microsoft.com 可能被重置连接，此时回退到镜像站拉取，再 retag 回原始
# 名称，运行时的 --pull=never 才能命中。
#
# 用法：由 deploy/manage.sh 或 deploy/pull-compiler-images.sh source。

COMPILER_IMAGE_MIRROR_PREFIX="${COMPILER_IMAGE_MIRROR_PREFIX:-docker.m.daocloud.io}"
COMPILER_IMAGE_PULL_ATTEMPTS="${COMPILER_IMAGE_PULL_ATTEMPTS:-2}"

# 与 manage.sh 的日志函数同名；单独运行时提供兜底实现。
if ! declare -F info >/dev/null 2>&1; then
  info() { printf '[compiler-images] %s\n' "$*"; }
fi
if ! declare -F warn >/dev/null 2>&1; then
  warn() { printf '[compiler-images] WARN: %s\n' "$*" >&2; }
fi
if ! declare -F error >/dev/null 2>&1; then
  error() { printf '[compiler-images] ERROR: %s\n' "$*" >&2; }
fi
if ! declare -F die >/dev/null 2>&1; then
  die() { error "$*"; exit 1; }
fi

compiler_images_fallback() {
  cat <<'EOF'
python:3.12-alpine
node:22-alpine
eclipse-temurin:21-jdk-alpine
gcc:14-bookworm
mcr.microsoft.com/dotnet/sdk:8.0-alpine
golang:1.23-alpine
rust:1.82-alpine
php:8.3-cli-alpine
ruby:3.3-alpine
zenika/kotlin:1.4.10-jdk12
swift:5.10-jammy
bash:5.2
EOF
}

# 优先从仓库源码读取镜像，保证部署脚本与 API 实际请求的镜像一致；
# 仓库尚未 clone 时退回静态清单。
compiler_image_list() {
  local app_dir="${1:-}" source
  if [[ -n "${app_dir}" ]]; then
    source="${app_dir}/apps/api/src/compiler.ts"
    if [[ -f "${source}" ]]; then
      sed -nE 's/.*image:[[:space:]]*"([^"]+)".*/\1/p' "${source}" | sort -u
      return 0
    fi
  fi
  compiler_images_fallback
}

compiler_image_mirror_ref() {
  local image="$1"
  [[ -n "${COMPILER_IMAGE_MIRROR_PREFIX}" ]] || { printf '%s\n' "${image}"; return 0; }
  printf '%s/%s\n' "${COMPILER_IMAGE_MIRROR_PREFIX%/}" "${image}"
}

compiler_image_present() {
  docker image inspect "$1" >/dev/null 2>&1
}

# 先直连拉取，失败后走镜像站并 retag 回原始名称。
pull_compiler_image() {
  local image="$1" mirror attempt
  compiler_image_present "${image}" && return 0

  for ((attempt = 1; attempt <= COMPILER_IMAGE_PULL_ATTEMPTS; attempt++)); do
    info "拉取编译器镜像 ${image}（直连第 ${attempt} 次）。"
    docker pull -- "${image}" && return 0
    sleep $((attempt * 5))
  done

  mirror="$(compiler_image_mirror_ref "${image}")"
  if [[ "${mirror}" != "${image}" ]]; then
    for ((attempt = 1; attempt <= COMPILER_IMAGE_PULL_ATTEMPTS; attempt++)); do
      warn "直连 ${image} 失败，改用镜像源 ${mirror}（第 ${attempt} 次）。"
      if docker pull -- "${mirror}"; then
        docker tag "${mirror}" "${image}"
        info "已把 ${mirror} 标记为 ${image}。"
        return 0
      fi
      sleep $((attempt * 5))
    done
  fi
  return 1
}

# 准备全部编译器镜像；任何镜像最终缺失都会让部署失败，而不是留到用户运行时。
ensure_compiler_images() {
  local app_dir="${1:-}" image failed=0
  command -v docker >/dev/null 2>&1 || die "缺少 Docker，无法准备在线编译器镜像。"
  docker info >/dev/null 2>&1 || die "Docker daemon 未就绪，无法准备在线编译器镜像。"

  while IFS= read -r image; do
    [[ -n "${image}" ]] || continue
    [[ "${image}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || die "编译器镜像引用无效：${image}"
    if compiler_image_present "${image}"; then
      continue
    fi
    if pull_compiler_image "${image}"; then
      continue
    fi
    error "无法拉取编译器镜像 ${image}。"
    failed=1
  done < <(compiler_image_list "${app_dir}")

  if (( failed != 0 )); then
    die "在线编译器镜像未准备完整。请检查服务器到 Docker Hub / mcr.microsoft.com 的网络，或设置 COMPILER_IMAGE_MIRROR_PREFIX 后重试。"
  fi
  info "在线编译器镜像已全部就绪。"
}
