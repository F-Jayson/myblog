-- =====================================================================
-- 个人知识库系统 (Knowledge Base V1) 核心数据表迁移脚本
-- =====================================================================

-- 1. 用户活跃度事件流水与日聚合表
CREATE TABLE IF NOT EXISTS user_activity_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  activity_type ENUM('clipboard_save', 'image_upload', 'compiler_run', 'approved_comment', 'kb_manual_save') NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_activity_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_activity_idempotency (user_id, activity_type, idempotency_key),
  INDEX idx_user_activity_lookup (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_activity_daily (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  activity_date DATE NOT NULL,
  rule_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  login_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  clipboard_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  image_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  compiler_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  comment_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  kb_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  total_service_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_activity_daily_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_user_daily (user_id, activity_date, rule_version),
  INDEX idx_daily_date (activity_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. 知识库资格与准入表
CREATE TABLE IF NOT EXISTS kb_entitlements (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('locked', 'eligible', 'active', 'grace', 'read_only', 'suspended') NOT NULL DEFAULT 'locked',
  score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  login_days_d TINYINT UNSIGNED NOT NULL DEFAULT 0,
  service_score_u TINYINT UNSIGNED NOT NULL DEFAULT 0,
  service_days_s TINYINT UNSIGNED NOT NULL DEFAULT 0,
  time_windows_w TINYINT UNSIGNED NOT NULL DEFAULT 0,
  stat_date_cutoff DATE NOT NULL,
  rule_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  activated_at DATETIME NULL,
  grace_started_at DATETIME NULL,
  restriction_reason VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_entitlements_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. 知识库主表 (owner 外键 RESTRICT，杜绝级联误删整库)
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  cover_url VARCHAR(512) NOT NULL DEFAULT '',
  visibility ENUM('private', 'unlisted', 'public') NOT NULL DEFAULT 'private',
  discovery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_comments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_owner FOREIGN KEY (owner_user_id) REFERENCES comment_users(id) ON DELETE RESTRICT,
  INDEX idx_kb_owner (owner_user_id, deleted_at),
  INDEX idx_kb_visibility (visibility, discovery_enabled, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. 知识库成员表
CREATE TABLE IF NOT EXISTS kb_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('manager', 'editor', 'commenter', 'viewer') NOT NULL DEFAULT 'viewer',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_members_lib FOREIGN KEY (library_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_members_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_lib_user (library_id, user_id),
  INDEX idx_kb_members_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. 文档与目录树表
CREATE TABLE IF NOT EXISTS kb_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  kind ENUM('document', 'folder') NOT NULL DEFAULT 'document',
  sort_order INT NOT NULL DEFAULT 0,
  access_mode ENUM('inherit', 'members_only', 'restricted') NOT NULL DEFAULT 'inherit',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  current_revision_id BIGINT UNSIGNED NULL,
  published_revision_id BIGINT UNSIGNED NULL,
  external_key VARCHAR(255) NULL,
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_docs_lib FOREIGN KEY (library_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_docs_parent FOREIGN KEY (parent_id) REFERENCES kb_documents(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_lib_extkey (library_id, external_key),
  INDEX idx_kb_docs_tree (library_id, parent_id, sort_order, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. 单篇与子树受限 ACL 名单表
CREATE TABLE IF NOT EXISTS kb_document_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('editor', 'commenter', 'viewer') NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_doc_access_doc FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_doc_access_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_doc_user (document_id, user_id),
  INDEX idx_kb_doc_access_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. 不可变修订历史表 (含 MySQL ngram 全文检索支持)
CREATE TABLE IF NOT EXISTS kb_revisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  markdown MEDIUMTEXT NOT NULL,
  tags JSON NOT NULL,
  source_url VARCHAR(1000) NOT NULL DEFAULT '',
  content_hash CHAR(64) NOT NULL,
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_grant_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_revisions_doc FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_doc_version (document_id, version),
  INDEX idx_revisions_created (document_id, created_at),
  FULLTEXT KEY ft_revision_search (title, markdown) /*!50100 WITH PARSER ngram */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. 附件元数据与版本关联表
CREATE TABLE IF NOT EXISTS kb_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  uploader_user_id BIGINT UNSIGNED NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  status ENUM('staged', 'bound', 'marked_delete') NOT NULL DEFAULT 'staged',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_att_lib FOREIGN KEY (library_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_att_doc FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
  INDEX idx_kb_att_owner (owner_user_id, status),
  INDEX idx_kb_att_staged_cleanup (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_revision_attachments (
  revision_id BIGINT UNSIGNED NOT NULL,
  attachment_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (revision_id, attachment_id),
  CONSTRAINT fk_rev_att_rev FOREIGN KEY (revision_id) REFERENCES kb_revisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rev_att_att FOREIGN KEY (attachment_id) REFERENCES kb_attachments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. 内部与公开评论表
CREATE TABLE IF NOT EXISTS kb_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  revision_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  author_user_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  channel ENUM('internal', 'public') NOT NULL DEFAULT 'internal',
  moderation_status ENUM('pending', 'approved', 'spam') NOT NULL DEFAULT 'approved',
  resolved_at DATETIME NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_comments_doc FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_comments_user FOREIGN KEY (author_user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_comments_doc_rev (document_id, revision_id, channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. 双向文档引用关联表
CREATE TABLE IF NOT EXISTS kb_document_links (
  from_revision_id BIGINT UNSIGNED NOT NULL,
  target_document_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (from_revision_id, target_document_id),
  CONSTRAINT fk_doc_link_rev FOREIGN KEY (from_revision_id) REFERENCES kb_revisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_link_target FOREIGN KEY (target_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE,
  INDEX idx_doc_link_target (target_document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. 分享链接表
CREATE TABLE IF NOT EXISTS kb_share_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  library_id BIGINT UNSIGNED NOT NULL,
  target_document_id BIGINT UNSIGNED NULL,
  include_descendants BOOLEAN NOT NULL DEFAULT FALSE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_share_lib FOREIGN KEY (library_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  INDEX idx_kb_share_token (token_hash, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. 普通用户 MCP Grant 与设备授权表 (与管理员 agent_grants 物理隔离)
CREATE TABLE IF NOT EXISTS kb_user_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  client_name VARCHAR(120) NOT NULL DEFAULT 'Personal AI Agent',
  scopes VARCHAR(500) NOT NULL,
  allowed_library_ids JSON NOT NULL,
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_grant_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_kb_grants_user (user_id, revoked_at),
  INDEX idx_kb_grants_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_device_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_code_hash CHAR(64) NOT NULL UNIQUE,
  user_code CHAR(8) NOT NULL,
  client_name VARCHAR(120) NOT NULL,
  requested_scopes VARCHAR(500) NOT NULL,
  status ENUM('pending', 'approved', 'denied', 'expired') NOT NULL DEFAULT 'pending',
  user_id BIGINT UNSIGNED NULL,
  grant_id BIGINT UNSIGNED NULL,
  encrypted_delivery_token TEXT NULL,
  expires_at DATETIME NOT NULL,
  approved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_dev_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_dev_grant FOREIGN KEY (grant_id) REFERENCES kb_user_grants(id) ON DELETE CASCADE,
  INDEX idx_kb_dev_user_code (user_code, status, expires_at),
  INDEX idx_kb_dev_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. 幂等操作凭证表
CREATE TABLE IF NOT EXISTS kb_mutation_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  grant_id BIGINT UNSIGNED NULL,
  action_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  result_payload JSON NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_mutation_key (user_id, action_type, idempotency_key),
  INDEX idx_mutation_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
