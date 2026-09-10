#!/usr/bin/env bash
set -Eeuo pipefail

# Firefly React production deployment manager for Debian/Ubuntu.
# Repository updates never run git clean or a destructive reset, so application
# secrets, uploads and other untracked persistent data remain intact.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_DIR="/etc/firefly-react"
CONFIG_FILE="${CONFIG_DIR}/deploy.env"
LOCK_DIR="/var/lock/firefly-react"
LOCK_FILE="${LOCK_DIR}/deploy.lock"
SYSTEMD_UNIT="firefly-react.service"
PNPM_VERSION="11.22.0"
BOOTSTRAP_ADMIN_HASH_PREFIX='scrypt$firefly-default$'
COMPILER_IMAGES=(
  "python:3.12-alpine"
  "node:22-alpine"
  "eclipse-temurin:21-jdk-alpine"
  "gcc:14-bookworm"
  "mcr.microsoft.com/dotnet/sdk:8.0-alpine"
  "golang:1.23-alpine"
  "rust:1.82-alpine"
  "php:8.3-cli-alpine"
  "ruby:3.3-alpine"
  "zenika/kotlin:1.4.10-jdk12"
  "swift:5.10-jammy"
  "bash:5.2"
)

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
info() { log "INFO: $*"; }
warn() { log "WARN: $*" >&2; }
error() { log "ERROR: $*" >&2; }
die() { error "$*"; exit 1; }

APP_DIR=""
REPO_URL=""
BRANCH="main"
DOMAIN=""
API_PORT="5180"
APP_USER="firefly"
NODE_MAJOR="22"
NGINX_SITE="firefly-react"
DB_MODE="local"
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_DATABASE="firefly_blog"
MYSQL_USER="firefly"
SSL_EMAIL=""
PUBLIC_SCHEME="http"
DB_PASSWORD=""
MYSQL_ROOT_PASSWORD=""
RUN_SEED="false"
ENABLE_SSL="false"
ADMIN_PASSWORD=""
MENU_COMMAND=""
LOCK_ACQUIRED="false"

DEFAULT_REPO_URL="$(git -C "${REPO_ROOT}" config --get remote.origin.url 2>/dev/null || true)"
DEFAULT_REPO_URL="${DEFAULT_REPO_URL:-https://github.com/example/firefly-react.git}"
DEFAULT_BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

SECRET_TEMP_FILES=()
cleanup_secret_files() {
  local file
  for file in "${SECRET_TEMP_FILES[@]:-}"; do
    if [[ -n "${file}" ]]; then
      rm -f -- "${file}"
    fi
  done
  return 0
}
trap cleanup_secret_files EXIT
trap 'error "操作失败（第 ${LINENO} 行）。"' ERR

ensure_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "请使用 root 或安装 sudo 后运行。"
  exec sudo -E bash "$0" "$@"
}

acquire_lock() {
  [[ "${LOCK_ACQUIRED}" == true ]] && return
  if ! command -v flock >/dev/null 2>&1; then
    info "缺少 flock，正在自动安装 util-linux。"
    require_supported_os
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends util-linux
    command -v flock >/dev/null 2>&1 || die "util-linux 安装后仍找不到 flock。"
  fi
  if ! mkdir -m 700 -- "${LOCK_DIR}" 2>/dev/null; then
    [[ -d "${LOCK_DIR}" && ! -L "${LOCK_DIR}" ]] || die "部署锁目录不安全：${LOCK_DIR}"
    [[ "$(stat -c '%u' -- "${LOCK_DIR}")" == 0 ]] || die "部署锁目录不属于 root：${LOCK_DIR}"
    chmod 700 -- "${LOCK_DIR}"
  fi
  exec 9>"${LOCK_FILE}"
  flock -n 9 || die "已有另一个部署操作正在运行。"
  LOCK_ACQUIRED=true
}

read_env_value() {
  local file="$1" key="$2" line value
  [[ -f "${file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == "${key}="* ]] || continue
    value="${line#*=}"
    if [[ "${value}" == \"* && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "${value}"
    return 0
  done < "${file}"
}

load_config() {
  [[ -f "${CONFIG_FILE}" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "${key}" ]]; do
    [[ "${key}" =~ ^[A-Z0-9_]+$ ]] || continue
    case "${key}" in
      APP_DIR|REPO_URL|BRANCH|DOMAIN|API_PORT|APP_USER|NODE_MAJOR|NGINX_SITE|DB_MODE|MYSQL_HOST|MYSQL_PORT|MYSQL_DATABASE|MYSQL_USER|SSL_EMAIL|PUBLIC_SCHEME)
        printf -v "${key}" '%s' "${value}" ;;
    esac
  done < "${CONFIG_FILE}"
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_id() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; }
valid_db_id() { [[ "$1" =~ ^[A-Za-z0-9_]+$ ]]; }
valid_mysql_user() { [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$ ]]; }
valid_node() { [[ "$1" == 22 ]]; }
valid_branch() {
  [[ "$1" != -* && "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  ! command -v git >/dev/null 2>&1 || git check-ref-format --branch "$1" >/dev/null 2>&1
}
valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }
valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || return 1
  [[ "$1" != *';'* && "$1" != *'#'* && "$1" != *'{'* && "$1" != *'}'* ]]
}
valid_host() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] && [[ "$1" != *[[:space:]]* ]]; }
valid_repo() {
  [[ -n "$1" && "$1" != -* && "$1" != *$'\n'* && "$1" != *';'* && "$1" != *'#'* && "$1" != *'{'* && "$1" != *'}'* && "$1" != *[[:space:]]* ]]
}
valid_app_dir() {
  local path="$1" resolved
  [[ "${path}" =~ ^/[A-Za-z0-9._/-]+$ && "${path}" != */ && "${path}" != *..* ]] || return 1
  resolved="$(readlink -m -- "${path}")"
  case "${resolved}" in /var/www/*|/srv/*|/opt/*) ;; *) return 1 ;; esac
  case "${resolved}" in /var/www|/srv|/opt|/etc|/usr|/var|/) return 1 ;; esac
}
valid_secret() {
  [[ "$1" != *[[:cntrl:]]* && ${#1} -ge 8 && ${#1} -le 256 ]]
}
valid_local_secret() {
  valid_secret "$1" && [[ "$1" =~ ^[A-Za-z0-9_!%+=,@:./-]+$ ]]
}
valid_admin_password() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* && ${#1} -ge 12 && ${#1} -le 128 ]]
}
valid_database_secret() {
  if [[ "${DB_MODE}" == local ]]; then
    valid_local_secret "$1"
  else
    valid_secret "$1"
  fi
}

prompt() {
  local name="$1" label="$2" default="${3-}" value
  if [[ -n "${default}" ]]; then
    read -r -p "${label} [${default}]: " value
    value="${value:-${default}}"
  else
    read -r -p "${label}: " value
  fi
  printf -v "${name}" '%s' "${value}"
}

prompt_secret() {
  local name="$1" label="$2" default="${3-}" value
  if [[ -n "${default}" ]]; then
    read -r -s -p "${label} [留空沿用当前值]: " value
  else
    read -r -s -p "${label}: " value
  fi
  printf '\n' >&2
  printf -v "${name}" '%s' "${value:-${default}}"
}

yes_no() {
  local name="$1" label="$2" default="${3:-n}" value hint='y/N'
  [[ "${default}" == y || "${default}" == true ]] && hint='Y/n'
  read -r -p "${label} [${hint}]: " value
  value="${value:-${default}}"
  case "${value,,}" in
    y|yes|true|是) printf -v "${name}" '%s' true ;;
    *) printf -v "${name}" '%s' false ;;
  esac
}

prompt_validated() {
  local name="$1" label="$2" default="$3" validator="$4" value
  while true; do
    prompt value "${label}" "${default}"
    if "${validator}" "${value}"; then
      printf -v "${name}" '%s' "${value}"
      return
    fi
    warn "输入无效，请重试。"
  done
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

write_config() {
  mkdir -p "${CONFIG_DIR}"
  chmod 700 "${CONFIG_DIR}"
  local tmp
  tmp="$(mktemp "${CONFIG_DIR}/deploy.env.XXXXXX")"
  SECRET_TEMP_FILES+=("${tmp}")
  chmod 600 "${tmp}"
  {
    printf '# Firefly React deployment settings; passwords are intentionally excluded\n'
    printf 'APP_DIR=%s\n' "${APP_DIR}"
    printf 'REPO_URL=%s\n' "${REPO_URL}"
    printf 'BRANCH=%s\n' "${BRANCH}"
    printf 'DOMAIN=%s\n' "${DOMAIN}"
    printf 'API_PORT=%s\n' "${API_PORT}"
    printf 'APP_USER=%s\n' "${APP_USER}"
    printf 'NODE_MAJOR=%s\n' "${NODE_MAJOR}"
    printf 'NGINX_SITE=%s\n' "${NGINX_SITE}"
    printf 'DB_MODE=%s\n' "${DB_MODE}"
    printf 'MYSQL_HOST=%s\n' "${MYSQL_HOST}"
    printf 'MYSQL_PORT=%s\n' "${MYSQL_PORT}"
    printf 'MYSQL_DATABASE=%s\n' "${MYSQL_DATABASE}"
    printf 'MYSQL_USER=%s\n' "${MYSQL_USER}"
    printf 'SSL_EMAIL=%s\n' "${SSL_EMAIL}"
    printf 'PUBLIC_SCHEME=%s\n' "${PUBLIC_SCHEME}"
  } > "${tmp}"
  mv -f "${tmp}" "${CONFIG_FILE}"
  chmod 600 "${CONFIG_FILE}"
}

validate_loaded_config() {
  [[ -f "${CONFIG_FILE}" ]] || die "尚未找到 ${CONFIG_FILE}，请先执行首次部署或配置向导。"
  valid_app_dir "${APP_DIR}" || die "配置中的 APP_DIR 无效。"
  valid_repo "${REPO_URL}" || die "配置中的 REPO_URL 无效。"
  valid_branch "${BRANCH}" || die "配置中的 Git 分支无效。"
  valid_domain "${DOMAIN}" || die "配置中的域名无效。"
  valid_port "${API_PORT}" || die "配置中的 API 端口无效。"
  valid_id "${APP_USER}" || die "配置中的服务用户无效。"
  valid_node "${NODE_MAJOR}" || die "配置中的 Node.js 版本无效。"
  valid_id "${NGINX_SITE}" || die "配置中的 Nginx 站点名无效。"
  [[ "${DB_MODE}" == local || "${DB_MODE}" == cloud ]] || die "配置中的数据库模式无效。"
  valid_host "${MYSQL_HOST}" || die "配置中的数据库主机无效。"
  valid_port "${MYSQL_PORT}" || die "配置中的数据库端口无效。"
  valid_db_id "${MYSQL_DATABASE}" || die "配置中的数据库名无效。"
  valid_mysql_user "${MYSQL_USER}" || die "配置中的数据库用户无效。"
  [[ "${PUBLIC_SCHEME}" == http || "${PUBLIC_SCHEME}" == https ]] || die "配置中的协议无效。"
}

load_existing_password() {
  [[ -z "${DB_PASSWORD}" ]] || return
  local encoded="" decoded=""
  encoded="$(read_env_value "${APP_DIR}/.env" MYSQL_PASSWORD_BASE64)"
  if [[ -n "${encoded}" ]]; then
    command -v base64 >/dev/null 2>&1 || die "无法读取数据库密码：系统缺少 base64。"
    if ! decoded="$(printf '%s' "${encoded}" | base64 --decode 2>/dev/null)"; then
      die "应用 .env 中的 MYSQL_PASSWORD_BASE64 无效。"
    fi
    [[ "$(printf '%s' "${decoded}" | base64 | tr -d '\n')" == "${encoded}" ]] || die "应用 .env 中的 MYSQL_PASSWORD_BASE64 无效。"
    DB_PASSWORD="${decoded}"
    return
  fi
  DB_PASSWORD="$(read_env_value "${APP_DIR}/.env" MYSQL_PASSWORD)"
}

collect_database_settings() {
  local use_cloud
  yes_no use_cloud "是否使用云数据库（选择否将安装本地 MySQL）" "$([[ "${DB_MODE}" == cloud ]] && echo y || echo n)"
  if [[ "${use_cloud}" == true ]]; then
    DB_MODE=cloud
    prompt_validated MYSQL_HOST "云数据库主机" "${MYSQL_HOST:-db.example.com}" valid_host
    prompt_validated MYSQL_PORT "云数据库端口" "${MYSQL_PORT:-3306}" valid_port
    prompt_validated MYSQL_DATABASE "云数据库名" "${MYSQL_DATABASE:-firefly_blog}" valid_db_id
    prompt_validated MYSQL_USER "云数据库用户" "${MYSQL_USER:-firefly}" valid_mysql_user
    load_existing_password
    prompt_secret DB_PASSWORD "云数据库密码" "${DB_PASSWORD:-}"
    valid_secret "${DB_PASSWORD}" || die "云数据库密码须为 8-256 位，且不能包含控制字符。"
  else
    DB_MODE=local
    MYSQL_HOST=127.0.0.1
    MYSQL_PORT=3306
    info "本地数据库使用仅在回环地址开放的 3306 端口。"
    prompt_validated MYSQL_DATABASE "应用数据库名" "${MYSQL_DATABASE:-firefly_blog}" valid_db_id
    prompt_validated MYSQL_USER "应用数据库用户" "${MYSQL_USER:-firefly}" valid_mysql_user
    load_existing_password
    prompt_secret DB_PASSWORD "应用数据库密码（留空自动生成）" "${DB_PASSWORD:-}"
    [[ -n "${DB_PASSWORD}" ]] || DB_PASSWORD="$(random_secret)"
    valid_local_secret "${DB_PASSWORD}" || die "本地数据库密码须为 8-256 位，并仅使用字母、数字和 _!%+=,@:./-。"
    prompt_secret MYSQL_ROOT_PASSWORD "MySQL root 密码（socket 登录可留空）" ""
    [[ -z "${MYSQL_ROOT_PASSWORD}" ]] || valid_secret "${MYSQL_ROOT_PASSWORD}" || die "MySQL root 密码须为 8-256 位，且不能包含控制字符。"
  fi
}

collect_settings() {
  load_config
  prompt_validated APP_DIR "部署目录" "${APP_DIR:-/var/www/firefly-react}" valid_app_dir
  prompt_validated REPO_URL "Git 仓库地址" "${REPO_URL:-${DEFAULT_REPO_URL}}" valid_repo
  prompt_validated BRANCH "Git 分支" "${BRANCH:-${DEFAULT_BRANCH}}" valid_branch
  prompt_validated DOMAIN "站点域名（不含协议和路径）" "${DOMAIN:-firefly.example.com}" valid_domain
  prompt_validated API_PORT "API 监听端口" "${API_PORT:-5180}" valid_port
  prompt_validated APP_USER "服务运行用户" "${APP_USER:-firefly}" valid_id
  NODE_MAJOR=22
  prompt_validated NGINX_SITE "Nginx 站点名" "${NGINX_SITE:-firefly-react}" valid_id
  prompt SSL_EMAIL "Let's Encrypt 通知邮箱（可留空，之后用 ssl 命令配置）" "${SSL_EMAIL:-}"
  [[ -z "${SSL_EMAIL}" ]] || valid_email "${SSL_EMAIL}" || die "邮箱格式无效。"
  collect_database_settings
}

show_summary() {
  printf '\n部署摘要\n'
  printf '  目录: %s\n  仓库: %s\n  分支: %s\n' "${APP_DIR}" "${REPO_URL}" "${BRANCH}"
  printf '  域名: %s\n  API 端口: %s\n  服务用户: %s\n' "${DOMAIN}" "${API_PORT}" "${APP_USER}"
  printf '  Node.js: %s\n  数据库模式: %s\n' "${NODE_MAJOR}" "${DB_MODE}"
  printf '  数据库: %s:%s/%s（密码已设置，不显示）\n' "${MYSQL_HOST}" "${MYSQL_PORT}" "${MYSQL_DATABASE}"
  [[ -n "${SSL_EMAIL}" ]] && printf '  SSL 邮箱: %s\n' "${SSL_EMAIL}"
  printf '\n'
}

confirm_action() {
  local confirmed
  yes_no confirmed "确认执行以上操作" y
  [[ "${confirmed}" == true ]]
}

require_supported_os() {
  [[ -r /etc/os-release ]] || die "仅支持 Debian/Ubuntu systemd 服务器。"
  # shellcheck disable=SC1091
  if ! source /etc/os-release; then
    die "无法解析 /etc/os-release，文件可能已损坏。"
  fi
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|*:debian*) ;;
    *) die "当前系统不受支持，仅支持 Debian/Ubuntu。" ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die "当前系统未使用 systemd。"
  command -v apt-get >/dev/null 2>&1 || die "当前系统缺少 apt-get。"
}

install_base_dependencies() {
  require_supported_os
  local packages=(ca-certificates curl git gnupg nginx openssl build-essential default-mysql-client util-linux)
  if ! command -v docker >/dev/null 2>&1; then
    packages+=(docker.io)
  fi
  if [[ "${DB_MODE}" == local ]]; then
    packages+=(default-mysql-server)
  fi
  info "安装系统依赖。"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${packages[@]}"
}

install_node_pnpm() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  fi
  if [[ "${current_major}" != "${NODE_MAJOR}" ]]; then
    local setup_script
    setup_script="$(mktemp /tmp/firefly-nodesource.XXXXXX)"
    SECRET_TEMP_FILES+=("${setup_script}")
    info "安装 Node.js ${NODE_MAJOR}.x。"
    curl --proto '=https' --tlsv1.2 -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "${setup_script}"
    bash "${setup_script}"
    apt-get install -y --no-install-recommends nodejs
  fi
  [[ "$(node --version)" == v"${NODE_MAJOR}".* ]] || die "Node.js ${NODE_MAJOR}.x 安装验证失败。"

  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
  else
    npm install --global "pnpm@${PNPM_VERSION}"
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm 安装失败。"
  [[ "$(pnpm --version)" == "${PNPM_VERSION}" ]] || die "需要 pnpm ${PNPM_VERSION}，当前为 $(pnpm --version)。"
}

ensure_service_user() {
  if ! id "${APP_USER}" >/dev/null 2>&1; then
    info "创建服务用户 ${APP_USER}。"
    useradd --system --create-home --home-dir "/var/lib/firefly-react" --shell /usr/sbin/nologin "${APP_USER}"
  fi
  [[ "$(id -u "${APP_USER}")" -ne 0 ]] || die "服务用户不能拥有 root 权限。"
}

ensure_compiler_runtime() {
  command -v docker >/dev/null 2>&1 || die "缺少 Docker，无法部署在线编译器。"
  systemctl enable --now docker
  docker info >/dev/null 2>&1 || die "Docker daemon 未就绪，无法部署在线编译器。"
  getent group docker >/dev/null 2>&1 || groupadd --system docker
  usermod -aG docker "${APP_USER}"
  info "准备在线编译器 Docker 沙箱镜像。"
  local image compiler_source="${APP_DIR}/apps/api/src/compiler.ts"
  local -a images=()

  # On updates, the repository may add or replace a compiler image. Read the
  # synchronized source so this invocation prepares the same images that the
  # API will request; the static list remains the bootstrap fallback before a
  # repository has been cloned.
  if [[ -f "${compiler_source}" ]]; then
    while IFS= read -r image; do
      [[ -n "${image}" ]] && images+=("${image}")
    done < <(sed -nE 's/.*image:[[:space:]]*"([^"]+)".*/\1/p' "${compiler_source}" | sort -u)
  fi
  (( ${#images[@]} > 0 )) || images=("${COMPILER_IMAGES[@]}")

  for image in "${images[@]}"; do
    [[ "${image}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || die "编译器镜像引用无效：${image}"
    if docker image inspect "${image}" >/dev/null 2>&1; then
      continue
    fi
    info "拉取编译器镜像 ${image}。"
    docker pull -- "${image}"
  done
}

ensure_repository() {
  local parent
  parent="$(dirname "${APP_DIR}")"
  mkdir -p "${parent}"

  if [[ ! -e "${APP_DIR}" ]]; then
    clone_repository_atomically "${parent}"
    return
  fi

  [[ -d "${APP_DIR}" ]] || die "部署路径存在但不是目录：${APP_DIR}"
  if [[ ! -d "${APP_DIR}/.git" ]]; then
    if [[ -n "$(find "${APP_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      die "部署目录非空且不是 Git 仓库，不会覆盖：${APP_DIR}"
    fi
    rmdir -- "${APP_DIR}"
    clone_repository_atomically "${parent}"
    return
  fi
  safe_git_sync
}

clone_repository_atomically() {
  local parent="$1" staging_root staging_repo
  staging_root="$(mktemp -d "${parent}/.firefly-react-clone.XXXXXX")"
  staging_repo="${staging_root}/repository"
  info "先克隆到临时目录，成功后再切换到 ${APP_DIR}。"
  if ! git clone --branch "${BRANCH}" --single-branch -- "${REPO_URL}" "${staging_repo}"; then
    warn "克隆失败；未修改部署目录。可检查后删除临时目录：${staging_root}"
    return 1
  fi
  [[ ! -e "${APP_DIR}" ]] || die "克隆期间部署目录被其他进程创建，拒绝覆盖：${APP_DIR}"
  mv -- "${staging_repo}" "${APP_DIR}"
  rmdir -- "${staging_root}"
}

assert_clean_tracked_files() {
  if ! git -C "${APP_DIR}" diff --quiet --ignore-submodules -- || ! git -C "${APP_DIR}" diff --cached --quiet --ignore-submodules --; then
    git -C "${APP_DIR}" status --short >&2 || true
    die "检测到受 Git 跟踪文件的本地修改；为避免覆盖，已中止同步。"
  fi
}

safe_git_sync() {
  [[ -d "${APP_DIR}/.git" ]] || die "部署目录不是 Git 仓库：${APP_DIR}"
  assert_clean_tracked_files

  if git -C "${APP_DIR}" remote get-url origin >/dev/null 2>&1; then
    local current_remote
    current_remote="$(git -C "${APP_DIR}" remote get-url origin)"
    if [[ "${current_remote}" != "${REPO_URL}" ]]; then
      info "按部署配置更新 origin 地址。"
      git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"
    fi
  else
    git -C "${APP_DIR}" remote add origin "${REPO_URL}"
  fi

  info "获取 origin/${BRANCH}。"
  git -C "${APP_DIR}" fetch --prune origin "${BRANCH}"
  git -C "${APP_DIR}" show-ref --verify --quiet "refs/remotes/origin/${BRANCH}" || die "远程分支不存在：origin/${BRANCH}"

  if git -C "${APP_DIR}" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git -C "${APP_DIR}" switch "${BRANCH}"
  else
    git -C "${APP_DIR}" switch --track -c "${BRANCH}" "origin/${BRANCH}"
  fi
  assert_clean_tracked_files
  git -C "${APP_DIR}" merge-base --is-ancestor HEAD "origin/${BRANCH}" || die "本地分支包含远程没有的提交或已分叉，拒绝自动覆盖。"
  git -C "${APP_DIR}" merge --ff-only "origin/${BRANCH}"
  [[ "$(git -C "${APP_DIR}" rev-parse HEAD)" == "$(git -C "${APP_DIR}" rev-parse "origin/${BRANCH}")" ]] || die "Git 同步后版本不一致。"
}

make_mysql_defaults_file() {
  local output_var="$1" user="$2" password="$3" host="$4" port="$5" file
  file="$(mktemp /tmp/firefly-mysql.XXXXXX)"
  SECRET_TEMP_FILES+=("${file}")
  chmod 600 "${file}"
  {
    printf '[client]\n'
    printf 'user=%s\n' "$(mysql_option_value "${user}")"
    printf 'password=%s\n' "$(mysql_option_value "${password}")"
    printf 'host=%s\n' "$(mysql_option_value "${host}")"
    printf 'port=%s\n' "$(mysql_option_value "${port}")"
    printf 'protocol=tcp\n'
  } > "${file}"
  printf -v "${output_var}" '%s' "${file}"
}

mysql_option_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}

mysql_root_sql() {
  local sql="$1" defaults_file=""
  if mysql --protocol=socket -uroot -e 'SELECT 1' >/dev/null 2>&1; then
    printf '%s\n' "${sql}" | mysql --protocol=socket -uroot
    return
  fi
  [[ -n "${MYSQL_ROOT_PASSWORD}" ]] || die "无法通过 MySQL root socket 登录，请在向导中输入 root 密码。"
  make_mysql_defaults_file defaults_file root "${MYSQL_ROOT_PASSWORD}" 127.0.0.1 "${MYSQL_PORT}"
  printf '%s\n' "${sql}" | mysql "--defaults-extra-file=${defaults_file}"
}

prepare_database() {
  if [[ "${DB_MODE}" == local ]]; then
    systemctl enable --now mysql 2>/dev/null || systemctl enable --now mariadb
    local sql
    sql="CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;"
    mysql_root_sql "${sql}"
  fi

  verify_database_connection
}

verify_database_connection() {
  local defaults_file=""
  make_mysql_defaults_file defaults_file "${MYSQL_USER}" "${DB_PASSWORD}" "${MYSQL_HOST}" "${MYSQL_PORT}"
  mysql "--defaults-extra-file=${defaults_file}" --database="${MYSQL_DATABASE}" -e 'SELECT 1' >/dev/null || die "无法连接目标数据库，请检查地址、权限与安全组。"
  info "数据库连接验证通过。"
}

write_application_env() {
  [[ -d "${APP_DIR}" ]] || die "应用目录不存在。"
  [[ ! -L "${APP_DIR}/.env" ]] || die "拒绝写入符号链接 .env。"
  load_existing_password
  valid_database_secret "${DB_PASSWORD}" || die "应用 .env 中没有可用的数据库密码，请运行 configure。"

  local tmp line key managed password_base64
  tmp="$(mktemp "${APP_DIR}/.env.XXXXXX")"
  SECRET_TEMP_FILES+=("${tmp}")
  chmod 600 "${tmp}"
  managed=' API_HOST API_PORT CLIENT_ORIGIN VITE_API_ORIGIN MYSQL_HOST MYSQL_PORT MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD MYSQL_PASSWORD_BASE64 MYSQL_CONNECTION_LIMIT NODE_ENV COMPILER_WORKDIR COMPILER_DOCKER_BIN COMPILER_DOCKER_NETWORK '
  if [[ -f "${APP_DIR}/.env" ]]; then
    while IFS= read -r line || [[ -n "${line}" ]]; do
      key="${line%%=*}"
      if [[ "${line}" == *=* && "${managed}" == *" ${key} "* ]]; then
        continue
      fi
      printf '%s\n' "${line}" >> "${tmp}"
    done < "${APP_DIR}/.env"
  fi
  password_base64="$(printf '%s' "${DB_PASSWORD}" | base64 | tr -d '\n')"
  {
    printf 'API_HOST=127.0.0.1\n'
    printf 'API_PORT=%s\n' "${API_PORT}"
    printf 'CLIENT_ORIGIN=%s://%s\n' "${PUBLIC_SCHEME}" "${DOMAIN}"
    printf 'VITE_API_ORIGIN=\n'
    printf 'MYSQL_HOST=%s\n' "${MYSQL_HOST}"
    printf 'MYSQL_PORT=%s\n' "${MYSQL_PORT}"
    printf 'MYSQL_DATABASE=%s\n' "${MYSQL_DATABASE}"
    printf 'MYSQL_USER=%s\n' "${MYSQL_USER}"
    printf 'MYSQL_PASSWORD_BASE64=%s\n' "${password_base64}"
    printf 'MYSQL_CONNECTION_LIMIT=10\n'
    printf 'COMPILER_WORKDIR=%s/.compiler-work\n' "${APP_DIR}"
    printf 'COMPILER_DOCKER_BIN=docker\n'
    printf 'COMPILER_DOCKER_NETWORK=none\n'
    printf 'NODE_ENV=production\n'
  } >> "${tmp}"
  chown "${APP_USER}:${APP_USER}" "${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${APP_DIR}/.env"
}

prepare_persistent_directories() {
  mkdir -p "${APP_DIR}/uploads/user-space"
  mkdir -p "${APP_DIR}/.compiler-work"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/uploads"
  chmod 750 "${APP_DIR}/uploads" "${APP_DIR}/uploads/user-space"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.compiler-work"
  chmod 750 "${APP_DIR}/.compiler-work"
}

install_and_build_application() {
  [[ -f "${APP_DIR}/pnpm-lock.yaml" ]] || die "缺少 pnpm-lock.yaml，部署目录可能不是 Firefly React。"
  info "按锁文件安装项目依赖。"
  (cd "${APP_DIR}" && NODE_ENV=development pnpm install --frozen-lockfile)
  info "构建 API 与前端。"
  (cd "${APP_DIR}" && VITE_API_ORIGIN='' pnpm build)
  [[ -f "${APP_DIR}/apps/api/dist/server.js" ]] || die "API 构建产物不存在。"
  [[ -f "${APP_DIR}/apps/web/dist/index.html" ]] || die "前端构建产物不存在。"
}

apply_database_migrations() {
  info "执行数据库迁移。"
  (cd "${APP_DIR}" && pnpm db:migrate)
  if [[ "${RUN_SEED}" == true ]]; then
    info "正在写入演示数据；seed 不会创建或修改管理员凭据。"
    (cd "${APP_DIR}" && pnpm db:seed)
  fi
}

write_systemd_unit() {
  local node_path tmp target
  node_path="$(command -v node)"
  [[ "${node_path}" == /* && "${node_path}" != *[[:space:]]* ]] || die "无法确定安全的 Node.js 可执行路径。"
  target="/etc/systemd/system/${SYSTEMD_UNIT}"
  tmp="$(mktemp /etc/systemd/system/.firefly-react.XXXXXX)"
  SECRET_TEMP_FILES+=("${tmp}")
  {
    printf '[Unit]\n'
    printf 'Description=Firefly React API\n'
    printf 'Wants=network-online.target\n'
    printf 'After=network-online.target\n\n'
    printf '[Service]\n'
    printf 'Type=simple\n'
    printf 'User=%s\n' "${APP_USER}"
    printf 'Group=%s\n' "${APP_USER}"
    printf 'WorkingDirectory=%s/apps/api\n' "${APP_DIR}"
    printf 'EnvironmentFile=%s/.env\n' "${APP_DIR}"
    printf 'SupplementaryGroups=docker\n'
    printf 'ExecStart=%s %s/apps/api/dist/server.js\n' "${node_path}" "${APP_DIR}"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=5s\n'
    printf 'TimeoutStopSec=30s\n'
    printf 'UMask=0027\n'
    printf 'NoNewPrivileges=true\n'
    printf 'PrivateTmp=true\n'
    printf 'ProtectHome=true\n'
    printf 'ProtectSystem=full\n'
    printf 'ReadWritePaths=%s/uploads %s/.compiler-work\n\n' "${APP_DIR}" "${APP_DIR}"
    printf '[Install]\n'
    printf 'WantedBy=multi-user.target\n'
  } > "${tmp}"
  chmod 644 "${tmp}"
  mv -f "${tmp}" "${target}"
  systemctl daemon-reload
  systemctl enable "${SYSTEMD_UNIT}" >/dev/null
}

certificate_pair_exists() {
  [[ -s "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" && -s "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]]
}

render_nginx_site() {
  local scheme="$1"
  if [[ "${scheme}" == https ]]; then
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    root ${APP_DIR}/apps/web/dist;
    index index.html;
    client_max_body_size 64m;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_request_buffering off;
    }

    location ~ /\\. {
        deny all;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
    return
  fi

  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${APP_DIR}/apps/web/dist;
    index index.html;
    client_max_body_size 64m;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_request_buffering off;
    }

    location ~ /\\. {
        deny all;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
}

validate_staged_nginx_site() {
  local site_file="$1" validation_file
  validation_file="$(mktemp /tmp/firefly-nginx-test.XXXXXX)"
  SECRET_TEMP_FILES+=("${validation_file}")
  {
    printf 'events {}\n'
    printf 'http {\n'
    printf '  include /etc/nginx/mime.types;\n'
    printf '  include %s;\n' "${site_file}"
    printf '}\n'
  } > "${validation_file}"
  nginx -t -q -c "${validation_file}"
}

restore_nginx_config() {
  local target="$1" enabled="$2" backup="$3" had_target="$4" old_link="$5" had_link="$6" was_active="$7" was_enabled="$8"
  local restored=true

  if [[ "${had_target}" == true ]]; then
    cp -a -- "${backup}" "${target}" || restored=false
  else
    rm -f -- "${target}" || restored=false
  fi
  if [[ "${had_link}" == true ]]; then
    ln -sfn -- "${old_link}" "${enabled}" || restored=false
  else
    rm -f -- "${enabled}" || restored=false
  fi

  if nginx -t >/dev/null 2>&1; then
    if [[ "${was_active}" == true ]]; then
      systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || restored=false
    else
      systemctl stop nginx >/dev/null 2>&1 || restored=false
    fi
  else
    restored=false
  fi
  if [[ "${was_enabled}" != true ]]; then
    systemctl disable nginx >/dev/null 2>&1 || restored=false
  fi

  if [[ "${restored}" == true ]]; then
    [[ -z "${backup}" ]] || rm -f -- "${backup}"
    warn "Nginx 更新失败，已恢复此前配置和服务状态。"
  else
    warn "Nginx 自动恢复未完全成功；旧配置备份保留在 ${backup:-（无旧站点文件）}。"
  fi
}

write_nginx_config() {
  local scheme="${PUBLIC_SCHEME}" target enabled staged backup="" old_link=""
  local had_target=false had_link=false was_active=false was_enabled=false
  target="/etc/nginx/sites-available/${NGINX_SITE}"
  enabled="/etc/nginx/sites-enabled/${NGINX_SITE}"
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/letsencrypt

  if [[ "${scheme}" == https ]]; then
    certificate_pair_exists || die "HTTPS 已启用，但域名证书不完整。"
  fi
  [[ ! -L "${target}" && ( ! -e "${target}" || -f "${target}" ) ]] || die "${target} 不是普通文件，拒绝覆盖。"
  [[ ! -e "${enabled}" || -L "${enabled}" ]] || die "${enabled} 已存在且不是符号链接，拒绝覆盖。"

  staged="$(mktemp /etc/nginx/sites-available/.firefly-react.XXXXXX)"
  SECRET_TEMP_FILES+=("${staged}")
  render_nginx_site "${scheme}" > "${staged}"
  chmod 644 "${staged}"
  validate_staged_nginx_site "${staged}" || die "Nginx 候选配置校验失败。"

  if [[ -f "${target}" ]]; then
    backup="$(mktemp /etc/nginx/sites-available/.firefly-react-backup.XXXXXX)"
    cp -a "${target}" "${backup}"
    had_target=true
  fi
  if [[ -L "${enabled}" ]]; then
    old_link="$(readlink "${enabled}")"
    had_link=true
  fi
  systemctl is-active --quiet nginx && was_active=true
  systemctl is-enabled --quiet nginx && was_enabled=true

  if ! mv -f "${staged}" "${target}"; then
    [[ -z "${backup}" ]] || rm -f -- "${backup}"
    die "无法安装 Nginx 候选配置；原配置未改变。"
  fi
  if ! ln -sfn "${target}" "${enabled}"; then
    restore_nginx_config "${target}" "${enabled}" "${backup}" "${had_target}" "${old_link}" "${had_link}" "${was_active}" "${was_enabled}"
    die "无法启用 Nginx 站点。"
  fi
  if ! nginx -t; then
    restore_nginx_config "${target}" "${enabled}" "${backup}" "${had_target}" "${old_link}" "${had_link}" "${was_active}" "${was_enabled}"
    die "Nginx 完整配置校验失败。"
  fi
  if ! systemctl enable --now nginx || ! systemctl reload nginx; then
    restore_nginx_config "${target}" "${enabled}" "${backup}" "${had_target}" "${old_link}" "${had_link}" "${was_active}" "${was_enabled}"
    die "Nginx 启动或重载失败。"
  fi
  [[ -z "${backup}" ]] || rm -f -- "${backup}"
}

restart_application() {
  systemctl restart "${SYSTEMD_UNIT}"
  wait_for_health
}

wait_for_health() {
  local attempt
  info "等待 API 与数据库健康检查。"
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
      info "API 健康检查通过。"
      return 0
    fi
    sleep 2
  done
  systemctl status "${SYSTEMD_UNIT}" --no-pager || true
  journalctl -u "${SYSTEMD_UNIT}" -n 80 --no-pager || true
  die "API 健康检查超时。"
}

verify_public_proxy() {
  local health_url resolve_target
  if [[ "${PUBLIC_SCHEME}" == https ]]; then
    health_url="https://${DOMAIN}/api/health"
    resolve_target="${DOMAIN}:443:127.0.0.1"
  else
    health_url="http://${DOMAIN}/api/health"
    resolve_target="${DOMAIN}:80:127.0.0.1"
  fi
  if curl -fsS --max-time 10 --resolve "${resolve_target}" "${health_url}" >/dev/null; then
    info "Nginx 代理健康检查通过。"
  else
    warn "API 本机健康，但 Nginx 代理检查失败；请检查 Nginx 日志和域名配置。"
  fi
}

install_certbot() {
  require_supported_os
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends certbot
}

write_certbot_reload_hook() {
  local hook_dir='/etc/letsencrypt/renewal-hooks/deploy' hook
  hook="${hook_dir}/firefly-reload-nginx"
  mkdir -p "${hook_dir}"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -e\n'
    printf 'nginx -t\n'
    printf 'systemctl reload nginx\n'
  } > "${hook}"
  chmod 750 "${hook}"
}

issue_or_renew_ssl() {
  valid_domain "${DOMAIN}" || die "域名格式无效。"
  valid_email "${SSL_EMAIL}" || die "申请 SSL 需要有效邮箱。"
  install_certbot
  mkdir -p /var/www/letsencrypt

  local had_certificate=false
  certificate_pair_exists && had_certificate=true
  if [[ "${had_certificate}" != true ]]; then
    PUBLIC_SCHEME=http
    write_nginx_config
  fi
  info "为 ${DOMAIN} 申请或续用 Let's Encrypt 证书。"
  if ! certbot certonly --non-interactive --agree-tos --email "${SSL_EMAIL}" --webroot --webroot-path /var/www/letsencrypt --cert-name "${DOMAIN}" -d "${DOMAIN}" --keep-until-expiring; then
    if [[ "${had_certificate}" != true ]]; then
      PUBLIC_SCHEME=http
      write_config
      load_existing_password
      write_application_env
      die "证书申请失败；站点已保持 HTTP 可用，请检查 DNS 和 80 端口后重试。"
    fi
    die "证书申请或续期失败；现有 HTTPS 证书和站点配置未改变，请检查 Certbot 日志后重试。"
  fi
  certificate_pair_exists || die "Certbot 未生成完整证书。"

  PUBLIC_SCHEME=https
  write_nginx_config
  load_existing_password
  write_application_env
  write_config
  write_certbot_reload_hook
  systemctl enable --now certbot.timer
  systemctl restart "${SYSTEMD_UNIT}"
  wait_for_health
  verify_public_proxy
  if ! certbot renew --dry-run; then
    die "HTTPS 已启用，但自动续期演练失败；请检查 Certbot 日志后再次运行 ssl。"
  fi
  info "HTTPS 已启用，Certbot 自动续期计时器已启动。"
}

normalize_public_scheme() {
  if [[ "${PUBLIC_SCHEME}" == https ]] && ! certificate_pair_exists; then
    warn "当前域名没有可用证书，先使用 HTTP；部署完成后可运行 ssl 命令。"
    PUBLIC_SCHEME=http
  fi
}

load_runtime_config() {
  load_config
  validate_loaded_config
  load_existing_password
  valid_database_secret "${DB_PASSWORD}" || die "应用 .env 中没有有效的数据库密码，请先运行 configure。"
}

prompt_admin_password() {
  local first second
  while true; do
    prompt_secret first "初始管理员 admin 密码（12-128 位）" ""
    if ! valid_admin_password "${first}"; then
      warn "管理员密码必须为 12-128 位且不能包含换行。"
      continue
    fi
    prompt_secret second "再次输入管理员密码" ""
    if [[ "${first}" != "${second}" ]]; then
      warn "两次输入不一致，请重试。"
      continue
    fi
    ADMIN_PASSWORD="${first}"
    first=""
    second=""
    return
  done
}

set_initial_admin_password() {
  valid_admin_password "${ADMIN_PASSWORD}" || die "未提供有效的初始管理员密码。"
  info "设置初始管理员密码。"
  (cd "${APP_DIR}" && printf '%s' "${ADMIN_PASSWORD}" | pnpm --filter @firefly-rebuild/api exec tsx src/cli.ts set-admin-password)
  ADMIN_PASSWORD=""
  if database_needs_admin_password; then
    die "管理员密码写入后校验失败。"
  fi
}

database_needs_admin_password() {
  local defaults_file="" table_count password_hash
  make_mysql_defaults_file defaults_file "${MYSQL_USER}" "${DB_PASSWORD}" "${MYSQL_HOST}" "${MYSQL_PORT}"
  table_count="$(mysql "--defaults-extra-file=${defaults_file}" --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${MYSQL_DATABASE}' AND TABLE_NAME = 'admin_users';")"
  [[ "${table_count}" == 1 ]] || return 0
  password_hash="$(mysql "--defaults-extra-file=${defaults_file}" --database="${MYSQL_DATABASE}" --batch --skip-column-names -e "SELECT password_hash FROM admin_users WHERE username = 'admin' AND is_active <> 0 LIMIT 1;")"
  [[ -n "${password_hash}" ]] || return 0
  [[ "${password_hash}" != "${BOOTSTRAP_ADMIN_HASH_PREFIX}"* ]] || return 0
  [[ "${password_hash}" =~ ^scrypt\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{128}$ ]] || return 0
  return 1
}

show_operation_flags() {
  printf '  初始化演示数据: %s\n' "${RUN_SEED}"
  printf '  部署后申请 SSL: %s\n' "${ENABLE_SSL}"
  printf '  管理员密码: 已安全输入，不显示\n\n'
}

run_first_deploy() {
  collect_settings
  prompt_admin_password
  yes_no RUN_SEED "是否初始化演示文章和站点数据" n
  yes_no ENABLE_SSL "部署完成后是否立即申请 SSL 证书" "$([[ -n "${SSL_EMAIL}" ]] && echo y || echo n)"
  if [[ "${ENABLE_SSL}" == true && -z "${SSL_EMAIL}" ]]; then
    prompt_validated SSL_EMAIL "Let's Encrypt 通知邮箱" "admin@${DOMAIN}" valid_email
  fi
  normalize_public_scheme
  show_summary
  show_operation_flags
  if ! confirm_action; then
    warn "已取消首次部署。"
    return
  fi

  install_base_dependencies
  install_node_pnpm
  ensure_service_user
  ensure_repository
  ensure_compiler_runtime
  write_config
  prepare_database
  write_application_env
  prepare_persistent_directories
  install_and_build_application
  apply_database_migrations
  set_initial_admin_password
  write_systemd_unit
  write_nginx_config
  restart_application
  verify_public_proxy
  if [[ "${ENABLE_SSL}" == true ]]; then
    issue_or_renew_ssl
  fi
  info "首次部署完成：${PUBLIC_SCHEME}://${DOMAIN}"
}

run_pull_only() {
  load_config
  validate_loaded_config
  safe_git_sync
  info "代码已安全快进到 origin/${BRANCH}；未安装依赖、迁移、构建或重启。"
}

run_update() {
  load_runtime_config
  install_base_dependencies
  install_node_pnpm
  ensure_service_user
  # Sync the application first so compiler image changes shipped with the
  # update are included before the runtime preparation step below.
  safe_git_sync
  ensure_compiler_runtime
  if [[ "${DB_MODE}" == local ]]; then
    systemctl enable --now mysql 2>/dev/null || systemctl enable --now mariadb
  fi
  verify_database_connection
  normalize_public_scheme
  write_config
  write_application_env
  prepare_persistent_directories
  install_and_build_application
  RUN_SEED=false
  apply_database_migrations
  if database_needs_admin_password; then
    die "数据库迁移后未检测到有效 admin 管理员；请运行 configure 设置唯一密码。"
  fi
  write_systemd_unit
  write_nginx_config
  restart_application
  verify_public_proxy
  info "拉取并更新完成。"
}

run_configure() {
  collect_settings
  normalize_public_scheme
  show_summary
  if ! confirm_action; then
    warn "已取消配置。"
    return
  fi

  install_base_dependencies
  install_node_pnpm
  ensure_service_user
  [[ -d "${APP_DIR}/.git" ]] || die "部署目录尚无应用代码，请先运行 first。"
  ensure_compiler_runtime
  prepare_database
  write_config
  write_application_env
  prepare_persistent_directories
  install_and_build_application
  apply_database_migrations
  if database_needs_admin_password; then
    warn "目标数据库尚无 admin 管理员，需要设置初始密码。"
    prompt_admin_password
  fi
  if [[ -n "${ADMIN_PASSWORD}" ]]; then
    set_initial_admin_password
  fi
  write_systemd_unit
  write_nginx_config
  restart_application
  verify_public_proxy
  info "配置已保存并应用。"
}

run_status() {
  load_config
  validate_loaded_config
  printf '\nFirefly API 服务\n'
  systemctl status "${SYSTEMD_UNIT}" --no-pager || true
  printf '\nNginx 服务\n'
  systemctl status nginx --no-pager || true
  printf '\n健康检查\n'
  if curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/api/health"; then
    printf '\nAPI 正常\n'
  else
    printf 'API 不可用\n' >&2
  fi
  if systemctl cat certbot.timer >/dev/null 2>&1; then
    printf '\n证书续期计时器\n'
    systemctl status certbot.timer --no-pager || true
  fi
}

run_start() {
  load_config
  validate_loaded_config
  systemctl start "${SYSTEMD_UNIT}"
  wait_for_health
}

run_stop() {
  load_config
  validate_loaded_config
  systemctl stop "${SYSTEMD_UNIT}"
  info "Firefly API 已停止。"
}

run_restart() {
  load_config
  validate_loaded_config
  restart_application
}

run_logs() {
  load_config
  validate_loaded_config
  journalctl -u "${SYSTEMD_UNIT}" -n 100 -f
}

run_migrate() {
  load_runtime_config
  command -v pnpm >/dev/null 2>&1 || die "缺少 pnpm，请先运行 update 或 first。"
  [[ -f "${APP_DIR}/package.json" ]] || die "应用目录不完整。"
  verify_database_connection
  (cd "${APP_DIR}" && pnpm db:migrate)
  if systemctl cat "${SYSTEMD_UNIT}" >/dev/null 2>&1; then
    restart_application
  fi
  info "数据库迁移完成。"
}

run_ssl() {
  load_runtime_config
  prompt_validated SSL_EMAIL "Let's Encrypt 通知邮箱" "${SSL_EMAIL:-admin@${DOMAIN}}" valid_email
  issue_or_renew_ssl
}

show_usage() {
  cat <<'EOF'
Firefly React 部署管理器

用法: sudo ./deploy/manage.sh <command>

命令:
  first       首次部署（配置、依赖、数据库、构建、服务、Nginx、可选 SSL）
  pull        仅安全拉取代码，不构建、不迁移、不重启
  update      安全拉取并安装依赖、迁移、构建和重启
  configure   修改并应用全部部署配置
  status      查看 API、Nginx、健康检查和证书续期状态
  start       启动 API
  stop        停止 API
  restart     重启 API 并执行健康检查
  logs        跟随 API 日志
  migrate     单独执行数据库迁移
  ssl         申请/更新 SSL 并验证自动续期
  help        显示帮助
EOF
}

interactive_menu() {
  local choice
  cat <<'EOF'

==========================================
       Firefly React 部署管理器
==========================================
  1. 首次部署
  2. 仅拉取代码
  3. 拉取并更新
  4. 修改部署配置
  5. 查看状态
  6. 启动服务
  7. 停止服务
  8. 重启服务
  9. 查看日志
 10. 数据库迁移
 11. 申请/更新 SSL
  0. 退出
EOF
  read -r -p '请选择操作: ' choice
  case "${choice}" in
    1) MENU_COMMAND=first ;;
    2) MENU_COMMAND=pull ;;
    3) MENU_COMMAND=update ;;
    4) MENU_COMMAND=configure ;;
    5) MENU_COMMAND=status ;;
    6) MENU_COMMAND=start ;;
    7) MENU_COMMAND=stop ;;
    8) MENU_COMMAND=restart ;;
    9) MENU_COMMAND=logs ;;
    10) MENU_COMMAND=migrate ;;
    11) MENU_COMMAND=ssl ;;
    0) MENU_COMMAND=exit ;;
    *) die "无效选择：${choice}" ;;
  esac
}

main() {
  local command="${1:-}"
  case "${command}" in
    help|-h|--help) show_usage; return ;;
    '') ensure_root "$@"; interactive_menu; command="${MENU_COMMAND}" ;;
    *) ensure_root "$@" ;;
  esac

  case "${command}" in
    exit) return ;;
    status|logs) ;;
    first|pull|update|configure|start|stop|restart|migrate|ssl) acquire_lock ;;
    *) show_usage; die "未知命令：${command}" ;;
  esac

  case "${command}" in
    first) run_first_deploy ;;
    pull) run_pull_only ;;
    update) run_update ;;
    configure) run_configure ;;
    status) run_status ;;
    start) run_start ;;
    stop) run_stop ;;
    restart) run_restart ;;
    logs) run_logs ;;
    migrate) run_migrate ;;
    ssl) run_ssl ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
