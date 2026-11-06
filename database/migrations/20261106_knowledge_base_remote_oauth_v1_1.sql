-- =============================================================================
-- 个人知识库系统 V1.1 扩展：远程 Streamable HTTP MCP 与 OAuth 2.1 / PKCE 授权表
-- =============================================================================

-- 1. OAuth 客户端登记表
CREATE TABLE IF NOT EXISTS kb_oauth_clients (
  client_id VARCHAR(64) NOT NULL PRIMARY KEY,
  client_name VARCHAR(120) NOT NULL,
  redirect_uris JSON NOT NULL,
  client_secret_hash VARCHAR(64) NULL,
  is_confidential BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. OAuth 授权码与 PKCE 挑战表
CREATE TABLE IF NOT EXISTS kb_oauth_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code_hash CHAR(64) NOT NULL UNIQUE,
  client_id VARCHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  redirect_uri VARCHAR(512) NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  code_challenge_method VARCHAR(16) NOT NULL DEFAULT 'S256',
  scopes JSON NOT NULL,
  allowed_library_ids JSON NOT NULL,
  used_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oauth_code_client (client_id),
  INDEX idx_oauth_code_user (user_id),
  INDEX idx_oauth_code_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. OAuth Refresh Token 与家族防重用表
CREATE TABLE IF NOT EXISTS kb_oauth_refresh_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  family_id VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  grant_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oauth_rt_family (family_id),
  INDEX idx_oauth_rt_grant (grant_id),
  INDEX idx_oauth_rt_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
