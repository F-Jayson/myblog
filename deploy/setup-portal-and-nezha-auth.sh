#!/bin/bash
set -euo pipefail

PORTAL_SRC="${PORTAL_SRC:-/tmp/fjayson-portal}"
NGINX_SRC="${NGINX_SRC:-/tmp/fjayson-nginx}"
PORTAL_ROOT=/var/www/portal
HTPASSWD_DIR=/etc/nginx/htpasswd
AUTH_FILE="$HTPASSWD_DIR/nezha"
AUTH_NOTE=/root/nezha-basic-auth.txt
DATA_DIR=/opt/nezha/dashboard/data

mkdir -p "$PORTAL_ROOT" /var/www/letsencrypt "$HTPASSWD_DIR"
chmod 755 "$PORTAL_ROOT" /var/www/letsencrypt
chmod 750 "$HTPASSWD_DIR"

if [[ ! -f "$PORTAL_SRC/index.html" || ! -f "$PORTAL_SRC/styles.css" ]]; then
  echo "missing portal files in $PORTAL_SRC" >&2
  exit 1
fi
install -m 644 "$PORTAL_SRC/index.html" "$PORTAL_ROOT/index.html"
install -m 644 "$PORTAL_SRC/styles.css" "$PORTAL_ROOT/styles.css"

python3 - <<'PY'
import crypt
import os
import pathlib
import secrets
import stat

auth_file = pathlib.Path("/etc/nginx/htpasswd/nezha")
note_file = pathlib.Path("/root/nezha-basic-auth.txt")
username = "jayson"

if auth_file.exists() and note_file.exists():
    print("reuse existing nezha basic auth")
else:
    password = secrets.token_urlsafe(18)
    hashed = crypt.crypt(password, crypt.METHOD_MD5)
    auth_file.write_text(f"{username}:{hashed}\n", encoding="utf-8")
    note_file.write_text(
        "Nezha nginx basic auth\n"
        f"username: {username}\n"
        f"password: {password}\n"
        "realm: Nezha Admin\n"
        "protects: /dashboard and /api/v1/login\n",
        encoding="utf-8",
    )
    print("created nezha basic auth")

os.chmod(auth_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP)
os.chmod(note_file, stat.S_IRUSR | stat.S_IWUSR)
PY

if [[ -d "$DATA_DIR" ]]; then
  chmod 700 "$DATA_DIR"
  if [[ -f "$DATA_DIR/sqlite.db" ]]; then
    chmod 600 "$DATA_DIR/sqlite.db"
  fi
  if [[ -f "$DATA_DIR/config.yaml" ]]; then
    chmod 600 "$DATA_DIR/config.yaml"
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

certbot certonly --webroot -w /var/www/letsencrypt \
  -d fjayson.com -d www.fjayson.com \
  --non-interactive --agree-tos --keep-until-expiring \
  --cert-name fjayson.com

install -m 644 "$NGINX_SRC/portal.conf" /etc/nginx/sites-available/portal
ln -sfn /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/portal
rm -f /etc/nginx/sites-enabled/portal-http

nginx -t
systemctl reload nginx

echo "=== auth note ==="
sed -n '1,5p' "$AUTH_NOTE"
echo "=== db perms ==="
stat -c '%a %U:%G %n' "$DATA_DIR" "$DATA_DIR/sqlite.db" "$DATA_DIR/config.yaml" "$AUTH_FILE"
echo "=== local checks ==="
curl -sS -o /dev/null -w "portal80:%{http_code}\n" -H "Host: fjayson.com" http://127.0.0.1/
curl -sS -o /dev/null -w "portal443:%{http_code}\n" -H "Host: fjayson.com" --resolve fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure
curl -sS -o /dev/null -w "status:%{http_code}\n" -H "Host: status.fjayson.com" --resolve status.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure
curl -sS -o /dev/null -w "dash:%{http_code}\n" -H "Host: status.fjayson.com" --resolve status.fjayson.com:443:127.0.0.1 https://127.0.0.1/dashboard --insecure
curl -sS -o /dev/null -w "blog:%{http_code}\n" -H "Host: blog.fjayson.com" --resolve blog.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure
curl -sS -o /dev/null -w "pm:%{http_code}\n" -H "Host: pm.fjayson.com" --resolve pm.fjayson.com:443:127.0.0.1 https://127.0.0.1/ --insecure
