#!/bin/bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "this script must run as root" >&2
  exit 1
fi

PORTAL_SRC="${PORTAL_SRC:-/tmp/fjayson-portal}"
NGINX_SRC="${NGINX_SRC:-/tmp/fjayson-nginx}"
PORTAL_ROOT=/var/www/portal
HTPASSWD_DIR=/etc/nginx/htpasswd
AUTH_FILE="$HTPASSWD_DIR/nezha"
AUTH_NOTE=/root/nezha-basic-auth.txt
DATA_DIR=/opt/nezha/dashboard/data
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NEZHA_USER="${NEZHA_USER:-}"

mkdir -p "$PORTAL_ROOT" /var/www/letsencrypt "$HTPASSWD_DIR"
chmod 755 "$PORTAL_ROOT" /var/www/letsencrypt
# nginx worker 进程以非 root 身份读取 htpasswd，目录和文件都必须对它可见
chmod 755 "$HTPASSWD_DIR"

if [[ ! -f "$PORTAL_SRC/index.html" || ! -f "$PORTAL_SRC/styles.css" ]]; then
  echo "missing portal files in $PORTAL_SRC" >&2
  exit 1
fi
install -m 644 "$PORTAL_SRC/index.html" "$PORTAL_ROOT/index.html"
install -m 644 "$PORTAL_SRC/styles.css" "$PORTAL_ROOT/styles.css"

python3 - <<'PY'
import os
import pathlib
import secrets
import stat
import subprocess
import sys

auth_file = pathlib.Path("/etc/nginx/htpasswd/nezha")
note_file = pathlib.Path("/root/nezha-basic-auth.txt")
username = "jayson"

def apr1_hash(password: str) -> str:
    """nginx 的 basic auth 只认 apr1/SHA/bcrypt 这几种格式；Python 3.13 起 crypt 模块已移除。"""
    try:
        result = subprocess.run(
            ["openssl", "passwd", "-apr1", "-stdin"],
            input=password,
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        sys.exit("openssl is required to generate the htpasswd entry")
    except subprocess.CalledProcessError as error:
        sys.exit(f"openssl passwd failed: {error.stderr.strip()}")
    hashed = result.stdout.strip()
    if not hashed.startswith("$apr1$"):
        sys.exit("openssl did not return an apr1 hash")
    return hashed

def write_private(path: pathlib.Path, text: str) -> None:
    """先以 0600 创建再写入，避免 umask 让明文口令短暂可读。"""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)

auth_exists = auth_file.is_file() and auth_file.stat().st_size > 0
note_exists = note_file.is_file()

if auth_exists and note_exists:
    print("reuse existing nezha basic auth")
elif auth_exists:
    # 只丢了记录文件时绝不能覆盖已有口令，否则后台会突然登录失败
    print("nezha basic auth exists but the note is missing; keeping the existing password")
elif note_exists:
    # 有记录但凭证被删：按记录里的口令重新生成，保证两者一致
    password = ""
    for line in note_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("password:"):
            password = line.split(":", 1)[1].strip()
    if not password:
        password = secrets.token_urlsafe(18)
    write_private(auth_file, f"{username}:{apr1_hash(password)}\n")
    note_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print("recreated nezha basic auth from the existing note")
else:
    password = secrets.token_urlsafe(18)
    write_private(auth_file, f"{username}:{apr1_hash(password)}\n")
    write_private(
        note_file,
        "Nezha nginx basic auth\n"
        f"username: {username}\n"
        f"password: {password}\n"
        "realm: Nezha Admin\n"
        "protects: /dashboard and /api/v1/login\n",
    )
    print("created nezha basic auth")

# 口令哈希本身不是机密，但必须让 nginx worker 读得到
auth_file.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
PY

if [[ -d "$DATA_DIR" ]]; then
  if [[ -z "$NEZHA_USER" ]] && id -u nezha >/dev/null 2>&1; then
    NEZHA_USER=nezha
  fi
  if [[ -n "$NEZHA_USER" ]]; then
    # 只改权限不改属主会把非 root 运行的 Nezha 锁在数据目录外面
    chown -R "$NEZHA_USER":"$NEZHA_USER" "$DATA_DIR"
    chmod 700 "$DATA_DIR"
    find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} +
  else
    echo "warning: no nezha user found, leaving $DATA_DIR ownership untouched" >&2
    chmod 700 "$DATA_DIR"
    find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} +
  fi
fi

install -m 644 "$NGINX_SRC/nezha.conf" /etc/nginx/sites-available/nezha
ln -sfn /etc/nginx/sites-available/nezha /etc/nginx/sites-enabled/nezha

cat > /etc/nginx/sites-available/portal-http <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name fjayson.com www.fjayson.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }

    location / {
        root /var/www/portal;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/portal-http /etc/nginx/sites-enabled/portal-http
rm -f /etc/nginx/sites-enabled/portal

nginx -t
systemctl reload nginx

# certbot 的非交互模式必须明确给出邮箱或显式声明不注册账号，否则会卡在提示上
if [[ -n "$CERTBOT_EMAIL" ]]; then
  certbot certonly --webroot -w /var/www/letsencrypt \
    -d fjayson.com -d www.fjayson.com \
    --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --keep-until-expiring \
    --cert-name fjayson.com
else
  certbot certonly --webroot -w /var/www/letsencrypt \
    -d fjayson.com -d www.fjayson.com \
    --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
    --cert-name fjayson.com
fi

install -m 644 "$NGINX_SRC/portal.conf" /etc/nginx/sites-available/portal
ln -sfn /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/portal
rm -f /etc/nginx/sites-enabled/portal-http

nginx -t
systemctl reload nginx

echo "=== auth note ==="
# 不要把口令打到 stdout：部署日志会被长期保留
echo "credentials stored in $AUTH_NOTE (owner root, mode 600)"
echo "=== db perms ==="
# 文件可能不存在：直接 stat 全部路径会在 set -e 下中断脚本
existing_paths=()
for candidate in "$DATA_DIR" "$DATA_DIR/sqlite.db" "$DATA_DIR/config.yaml" "$AUTH_FILE"; do
  if [[ -e "$candidate" ]]; then
    existing_paths+=("$candidate")
  fi
done
if ((${#existing_paths[@]})); then
  stat -c '%a %U:%G %n' "${existing_paths[@]}"
fi

echo "=== local checks ==="
check_failed=0
check_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ ! "$actual" =~ ^($expected)$ ]]; then
    echo "$label unexpected status $actual" >&2
    check_failed=1
  fi
}

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: fjayson.com" http://127.0.0.1/ || true)
echo "portal80:$status"
check_status portal80 '200|301|302|308' "$status"

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: fjayson.com" --resolve fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure || true)
echo "portal443:$status"
check_status portal443 '200|301|302|308' "$status"

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: status.fjayson.com" --resolve status.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure || true)
echo "status:$status"
check_status status '200|301|302|308' "$status"

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: status.fjayson.com" --resolve status.fjayson.com:443:127.0.0.1 https://127.0.0.1/dashboard --insecure || true)
echo "dash:$status"
check_status dash '401' "$status"

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: blog.fjayson.com" --resolve blog.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure || true)
echo "blog:$status"
check_status blog '200|301|302|308' "$status"

status=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: pm.fjayson.com" --resolve pm.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure || true)
echo "pm:$status"
check_status pm '200|301|302|308' "$status"

if ((check_failed)); then
  echo "one or more local checks failed" >&2
  exit 1
fi
echo "all local checks passed"
