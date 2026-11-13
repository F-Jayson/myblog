-- Migration: WebDAV drive tree and lock table
-- The same DDL exists in database/schema.sql (CREATE TABLE IF NOT EXISTS), so
-- `pnpm db:migrate` on an empty database creates these tables as well. Run this
-- file by hand only on a database that was migrated before this feature.

CREATE TABLE IF NOT EXISTS drive_nodes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('admin','user') NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  path VARCHAR(700) COLLATE utf8mb4_bin NOT NULL,
  name VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  node_type ENUM('file','folder') NOT NULL DEFAULT 'file',
  storage_key VARCHAR(255) NOT NULL DEFAULT '',
  mime_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  etag CHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_drive_nodes_owner_path (owner_type, owner_id, path),
  KEY idx_drive_nodes_parent (owner_type, owner_id, parent_id),
  KEY idx_drive_nodes_storage (storage_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS drive_locks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('admin','user') NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  path VARCHAR(700) COLLATE utf8mb4_bin NOT NULL,
  lock_token VARCHAR(80) NOT NULL,
  lock_owner VARCHAR(255) NOT NULL DEFAULT '',
  depth VARCHAR(16) NOT NULL DEFAULT 'infinity',
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_drive_locks_owner_path (owner_type, owner_id, path),
  KEY idx_drive_locks_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
