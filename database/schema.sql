CREATE DATABASE IF NOT EXISTS firefly_blog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE firefly_blog;

CREATE TABLE IF NOT EXISTS authors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  bio VARCHAR(255) NOT NULL DEFAULT '',
  avatar VARCHAR(500) NOT NULL DEFAULT '',
  email VARCHAR(190) NULL,
  github_url VARCHAR(500) NULL,
  qq_url VARCHAR(500) NULL,
  rss_url VARCHAR(500) NULL,
  links JSON NOT NULL DEFAULT (JSON_ARRAY()),
  profile JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS posts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(180) NOT NULL UNIQUE,
  filename VARCHAR(255) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  excerpt TEXT NOT NULL,
  content LONGTEXT NOT NULL,
  cover VARCHAR(500) NULL,
  top_image VARCHAR(500) NULL,
  category_id BIGINT UNSIGNED NULL,
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  words INT UNSIGNED NOT NULL DEFAULT 0,
  minutes SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  published_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_posts_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_posts_status_date (status, published_at),
  INDEX idx_posts_category (category_id)
) ENGINE=InnoDB;

-- A post may be shown in more than one category. Keep category_id as the
-- first-category compatibility column used by older queries and clients.
CREATE TABLE IF NOT EXISTS post_categories (
  post_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, category_id),
  CONSTRAINT fk_post_categories_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_post_categories_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  INDEX idx_post_categories_category (category_id)
) ENGINE=InnoDB;

-- Idempotent upgrades for databases created before article editor metadata
-- was added. Existing filenames use the stable URL slug as their fallback.
SET @firefly_post_filename_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'filename') = 0,
  'ALTER TABLE posts ADD COLUMN filename VARCHAR(255) NOT NULL DEFAULT '''' AFTER slug',
  'SELECT 1'
);
PREPARE firefly_post_filename_statement FROM @firefly_post_filename_sql;
EXECUTE firefly_post_filename_statement;
DEALLOCATE PREPARE firefly_post_filename_statement;

SET @firefly_post_top_image_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'top_image') = 0,
  'ALTER TABLE posts ADD COLUMN top_image VARCHAR(500) NULL AFTER cover',
  'SELECT 1'
);
PREPARE firefly_post_top_image_statement FROM @firefly_post_top_image_sql;
EXECUTE firefly_post_top_image_statement;
DEALLOCATE PREPARE firefly_post_top_image_statement;

-- Backfill only when there is work to do. This keeps repeated startup migrations
-- read-only once legacy rows have been normalized.
SET @firefly_post_filename_backfill_sql = IF(
  EXISTS (SELECT 1 FROM posts WHERE filename = '' OR filename IS NULL),
  'UPDATE posts SET filename = slug WHERE filename = '''' OR filename IS NULL',
  'SELECT 1'
);
PREPARE firefly_post_filename_backfill_statement FROM @firefly_post_filename_backfill_sql;
EXECUTE firefly_post_filename_backfill_statement;
DEALLOCATE PREPARE firefly_post_filename_backfill_statement;

SET @firefly_post_categories_backfill_sql = IF(
  EXISTS (
    SELECT 1
    FROM posts p
    LEFT JOIN post_categories pc ON pc.post_id = p.id AND pc.category_id = p.category_id
    WHERE p.category_id IS NOT NULL AND pc.post_id IS NULL
  ),
  'INSERT IGNORE INTO post_categories (post_id, category_id) SELECT p.id, p.category_id FROM posts p WHERE p.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id AND pc.category_id = p.category_id)',
  'SELECT 1'
);
PREPARE firefly_post_categories_backfill_statement FROM @firefly_post_categories_backfill_sql;
EXECUTE firefly_post_categories_backfill_statement;
DEALLOCATE PREPARE firefly_post_categories_backfill_statement;

CREATE TABLE IF NOT EXISTS post_tags (
  post_id BIGINT UNSIGNED NOT NULL,
  tag_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  CONSTRAINT fk_post_tags_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dynamics (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  body TEXT NOT NULL,
  images JSON NOT NULL DEFAULT (JSON_ARRAY()),
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dynamics_date (published_at)
) ENGINE=InnoDB;

-- Keep normal startup migrations idempotent for databases created before the
-- configurable profile and image-enabled dynamics were introduced.
SET @firefly_author_links_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'authors' AND COLUMN_NAME = 'links') = 0,
  'ALTER TABLE authors ADD COLUMN links JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER rss_url',
  'SELECT 1'
);
PREPARE firefly_author_links_statement FROM @firefly_author_links_sql;
EXECUTE firefly_author_links_statement;
DEALLOCATE PREPARE firefly_author_links_statement;

-- Extra profile data is deliberately kept as one JSON document. It lets the
-- author homepage grow without fragmenting the single-author site model.
SET @firefly_author_profile_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'authors' AND COLUMN_NAME = 'profile') = 0,
  'ALTER TABLE authors ADD COLUMN profile JSON NOT NULL DEFAULT (JSON_OBJECT()) AFTER links',
  'SELECT 1'
);
PREPARE firefly_author_profile_statement FROM @firefly_author_profile_sql;
EXECUTE firefly_author_profile_statement;
DEALLOCATE PREPARE firefly_author_profile_statement;

SET @firefly_dynamic_images_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dynamics' AND COLUMN_NAME = 'images') = 0,
  'ALTER TABLE dynamics ADD COLUMN images JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER body',
  'SELECT 1'
);
PREPARE firefly_dynamic_images_statement FROM @firefly_dynamic_images_sql;
EXECUTE firefly_dynamic_images_statement;
DEALLOCATE PREPARE firefly_dynamic_images_statement;

SET @firefly_dynamic_updated_at_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dynamics' AND COLUMN_NAME = 'updated_at') = 0,
  'ALTER TABLE dynamics ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at',
  'SELECT 1'
);
PREPARE firefly_dynamic_updated_at_statement FROM @firefly_dynamic_updated_at_sql;
EXECUTE firefly_dynamic_updated_at_statement;
DEALLOCATE PREPARE firefly_dynamic_updated_at_statement;

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  post_id BIGINT UNSIGNED NULL,
  author_name VARCHAR(120) NOT NULL,
  author_email VARCHAR(190) NULL,
  body TEXT NOT NULL,
  status ENUM('pending', 'approved', 'spam') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  INDEX idx_comments_post_status (post_id, status, created_at)
) ENGINE=InnoDB;

-- User accounts and public comment data. These tables intentionally use the
-- existing comments table instead of replacing it, so installations upgraded
-- from the first Firefly schema keep their published comments.
CREATE TABLE IF NOT EXISTS comment_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account VARCHAR(64) NOT NULL UNIQUE,
  nickname VARCHAR(120) NOT NULL,
  email VARCHAR(190) NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(512) NOT NULL DEFAULT '',
  avatar_source ENUM('preset', 'upload', 'url') NOT NULL DEFAULT 'preset',
  signature VARCHAR(500) NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  registration_ip VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  INDEX idx_comment_users_active (is_active),
  INDEX idx_comment_users_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comment_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comment_sessions_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_comment_sessions_expiry (expires_at),
  INDEX idx_comment_sessions_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comment_email_codes (
  email VARCHAR(190) NOT NULL PRIMARY KEY,
  code_hash CHAR(64) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_comment_email_codes_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comment_stickers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  image_url VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(128) NOT NULL DEFAULT 'image/png',
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_comment_stickers_active (is_active, sort_order, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comment_user_stickers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  image_url VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(128) NOT NULL DEFAULT 'image/png',
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_comment_user_stickers_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_comment_user_stickers_user (user_id, created_at)
) ENGINE=InnoDB;

-- Unified per-user storage. Images uploaded for the image host, avatars,
-- comment images and personal stickers are tracked here when they belong to
-- an authenticated user. Clipboard bodies are kept in a separate table so
-- they can be edited without rewriting image metadata; both tables share the
-- same 30MB quota in the API.
CREATE TABLE IF NOT EXISTS user_storage_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'image',
  name VARCHAR(255) NOT NULL DEFAULT '',
  storage_url VARCHAR(1000) NOT NULL,
  storage_key VARCHAR(255) NOT NULL DEFAULT '',
  mime_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  public_token CHAR(43) NULL UNIQUE,
  view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_storage_items_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_user_storage_items_user (user_id, created_at),
  INDEX idx_user_storage_items_kind (user_id, kind),
  INDEX idx_user_storage_items_public (is_public, public_token)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_clipboards (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  public_token CHAR(43) NULL UNIQUE,
  view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_clipboards_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_user_clipboards_user (user_id, updated_at),
  INDEX idx_user_clipboards_public (is_public, public_token)
) ENGINE=InnoDB;

-- The original comments table predates user sessions and threaded replies.
-- Add the new columns only when they are missing so this file remains safe to
-- run repeatedly against an existing database.
SET @firefly_comment_user_id_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'user_id') = 0, 'ALTER TABLE comments ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER post_id', 'SELECT 1');
PREPARE firefly_comment_user_id_statement FROM @firefly_comment_user_id_sql; EXECUTE firefly_comment_user_id_statement; DEALLOCATE PREPARE firefly_comment_user_id_statement;
SET @firefly_comment_parent_id_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'parent_id') = 0, 'ALTER TABLE comments ADD COLUMN parent_id BIGINT UNSIGNED NULL AFTER user_id', 'SELECT 1');
PREPARE firefly_comment_parent_id_statement FROM @firefly_comment_parent_id_sql; EXECUTE firefly_comment_parent_id_statement; DEALLOCATE PREPARE firefly_comment_parent_id_statement;
SET @firefly_comment_avatar_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'author_avatar') = 0, 'ALTER TABLE comments ADD COLUMN author_avatar VARCHAR(512) NOT NULL DEFAULT '''' AFTER author_name', 'SELECT 1');
PREPARE firefly_comment_avatar_statement FROM @firefly_comment_avatar_sql; EXECUTE firefly_comment_avatar_statement; DEALLOCATE PREPARE firefly_comment_avatar_statement;
SET @firefly_comment_ip_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'client_ip') = 0, 'ALTER TABLE comments ADD COLUMN client_ip VARCHAR(128) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_ip_statement FROM @firefly_comment_ip_sql; EXECUTE firefly_comment_ip_statement; DEALLOCATE PREPARE firefly_comment_ip_statement;
SET @firefly_comment_ip_location_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'ip_location') = 0, 'ALTER TABLE comments ADD COLUMN ip_location VARCHAR(255) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_ip_location_statement FROM @firefly_comment_ip_location_sql; EXECUTE firefly_comment_ip_location_statement; DEALLOCATE PREPARE firefly_comment_ip_location_statement;
SET @firefly_comment_client_browser_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'client_browser') = 0, 'ALTER TABLE comments ADD COLUMN client_browser VARCHAR(128) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_client_browser_statement FROM @firefly_comment_client_browser_sql; EXECUTE firefly_comment_client_browser_statement; DEALLOCATE PREPARE firefly_comment_client_browser_statement;
SET @firefly_comment_client_os_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'client_os') = 0, 'ALTER TABLE comments ADD COLUMN client_os VARCHAR(128) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_client_os_statement FROM @firefly_comment_client_os_sql; EXECUTE firefly_comment_client_os_statement; DEALLOCATE PREPARE firefly_comment_client_os_statement;
SET @firefly_comment_client_device_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'client_device') = 0, 'ALTER TABLE comments ADD COLUMN client_device VARCHAR(64) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_client_device_statement FROM @firefly_comment_client_device_sql; EXECUTE firefly_comment_client_device_statement; DEALLOCATE PREPARE firefly_comment_client_device_statement;
SET @firefly_comment_client_ua_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'client_ua') = 0, 'ALTER TABLE comments ADD COLUMN client_ua VARCHAR(512) NOT NULL DEFAULT ''''', 'SELECT 1');
PREPARE firefly_comment_client_ua_statement FROM @firefly_comment_client_ua_sql; EXECUTE firefly_comment_client_ua_statement; DEALLOCATE PREPARE firefly_comment_client_ua_statement;
SET @firefly_comment_images_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'images') = 0, 'ALTER TABLE comments ADD COLUMN images JSON NOT NULL DEFAULT (JSON_ARRAY())', 'SELECT 1');
PREPARE firefly_comment_images_statement FROM @firefly_comment_images_sql; EXECUTE firefly_comment_images_statement; DEALLOCATE PREPARE firefly_comment_images_statement;
SET @firefly_comment_admin_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'is_admin') = 0, 'ALTER TABLE comments ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE', 'SELECT 1');
PREPARE firefly_comment_admin_statement FROM @firefly_comment_admin_sql; EXECUTE firefly_comment_admin_statement; DEALLOCATE PREPARE firefly_comment_admin_statement;
SET @firefly_comment_sticker_id_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'sticker_id') = 0, 'ALTER TABLE comments ADD COLUMN sticker_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE firefly_comment_sticker_id_statement FROM @firefly_comment_sticker_id_sql; EXECUTE firefly_comment_sticker_id_statement; DEALLOCATE PREPARE firefly_comment_sticker_id_statement;
SET @firefly_comment_personal_sticker_id_sql = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'personal_sticker_id') = 0, 'ALTER TABLE comments ADD COLUMN personal_sticker_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE firefly_comment_personal_sticker_id_statement FROM @firefly_comment_personal_sticker_id_sql; EXECUTE firefly_comment_personal_sticker_id_statement; DEALLOCATE PREPARE firefly_comment_personal_sticker_id_statement;

-- Add nullable comment relationships only when their semantic foreign key is missing.
-- Legacy orphan IDs are cleared only in that case. A mismatched existing constraint
-- is left for explicit operator repair instead of being dropped automatically.
SET @firefly_comments_user_fk_present = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'comments' AND k.COLUMN_NAME = 'user_id' AND k.REFERENCED_TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'comment_users' AND k.REFERENCED_COLUMN_NAME = 'id' AND r.DELETE_RULE = 'SET NULL' AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE member WHERE member.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND member.TABLE_NAME = k.TABLE_NAME AND member.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1);
SET @firefly_comments_user_fk_count = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @firefly_comments_user_fixed_name_count = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_comments_user');
-- The deliberately unknown identifiers abort PREPARE on a conflict without
-- requiring CREATE ROUTINE privileges or leaving a persistent helper object.
SET @firefly_comments_user_fk_validation_sql = CASE WHEN @firefly_comments_user_fk_present > 1 THEN 'SELECT `ff_abort_comments_user_multiple_fks`' WHEN @firefly_comments_user_fk_count > @firefly_comments_user_fk_present THEN 'SELECT `ff_abort_comments_user_conflicting_fk`' WHEN @firefly_comments_user_fk_present = 0 AND @firefly_comments_user_fixed_name_count > 0 THEN 'SELECT `ff_abort_comments_user_fk_name_occupied`' ELSE 'SELECT 1' END;
PREPARE firefly_comments_user_fk_validation_statement FROM @firefly_comments_user_fk_validation_sql; EXECUTE firefly_comments_user_fk_validation_statement; DEALLOCATE PREPARE firefly_comments_user_fk_validation_statement;
SET @firefly_comments_user_fk_cleanup_sql = IF(@firefly_comments_user_fk_present = 0, 'UPDATE comments c LEFT JOIN comment_users p ON p.id = c.user_id SET c.user_id = NULL WHERE c.user_id IS NOT NULL AND p.id IS NULL', 'SELECT 1');
PREPARE firefly_comments_user_fk_cleanup_statement FROM @firefly_comments_user_fk_cleanup_sql; EXECUTE firefly_comments_user_fk_cleanup_statement; DEALLOCATE PREPARE firefly_comments_user_fk_cleanup_statement;
SET @firefly_comments_user_fk_add_sql = IF(@firefly_comments_user_fk_present = 0, 'ALTER TABLE comments ADD CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE firefly_comments_user_fk_add_statement FROM @firefly_comments_user_fk_add_sql; EXECUTE firefly_comments_user_fk_add_statement; DEALLOCATE PREPARE firefly_comments_user_fk_add_statement;
SET @firefly_comments_parent_fk_present = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'comments' AND k.COLUMN_NAME = 'parent_id' AND k.REFERENCED_TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'comments' AND k.REFERENCED_COLUMN_NAME = 'id' AND r.DELETE_RULE = 'SET NULL' AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE member WHERE member.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND member.TABLE_NAME = k.TABLE_NAME AND member.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1);
SET @firefly_comments_parent_fk_count = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'parent_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @firefly_comments_parent_fixed_name_count = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_comments_parent');
SET @firefly_comments_parent_fk_validation_sql = CASE WHEN @firefly_comments_parent_fk_present > 1 THEN 'SELECT `ff_abort_comments_parent_multiple_fks`' WHEN @firefly_comments_parent_fk_count > @firefly_comments_parent_fk_present THEN 'SELECT `ff_abort_comments_parent_conflicting_fk`' WHEN @firefly_comments_parent_fk_present = 0 AND @firefly_comments_parent_fixed_name_count > 0 THEN 'SELECT `ff_abort_comments_parent_fk_name_occupied`' ELSE 'SELECT 1' END;
PREPARE firefly_comments_parent_fk_validation_statement FROM @firefly_comments_parent_fk_validation_sql; EXECUTE firefly_comments_parent_fk_validation_statement; DEALLOCATE PREPARE firefly_comments_parent_fk_validation_statement;
SET @firefly_comments_parent_fk_cleanup_sql = IF(@firefly_comments_parent_fk_present = 0, 'UPDATE comments c LEFT JOIN comments p ON p.id = c.parent_id SET c.parent_id = NULL WHERE c.parent_id IS NOT NULL AND p.id IS NULL', 'SELECT 1');
PREPARE firefly_comments_parent_fk_cleanup_statement FROM @firefly_comments_parent_fk_cleanup_sql; EXECUTE firefly_comments_parent_fk_cleanup_statement; DEALLOCATE PREPARE firefly_comments_parent_fk_cleanup_statement;
SET @firefly_comments_parent_fk_add_sql = IF(@firefly_comments_parent_fk_present = 0, 'ALTER TABLE comments ADD CONSTRAINT fk_comments_parent FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE firefly_comments_parent_fk_add_statement FROM @firefly_comments_parent_fk_add_sql; EXECUTE firefly_comments_parent_fk_add_statement; DEALLOCATE PREPARE firefly_comments_parent_fk_add_statement;
SET @firefly_comments_sticker_fk_present = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'comments' AND k.COLUMN_NAME = 'sticker_id' AND k.REFERENCED_TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'comment_stickers' AND k.REFERENCED_COLUMN_NAME = 'id' AND r.DELETE_RULE = 'SET NULL' AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE member WHERE member.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND member.TABLE_NAME = k.TABLE_NAME AND member.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1);
SET @firefly_comments_sticker_fk_count = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'sticker_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @firefly_comments_sticker_fixed_name_count = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_comments_sticker');
SET @firefly_comments_sticker_fk_validation_sql = CASE WHEN @firefly_comments_sticker_fk_present > 1 THEN 'SELECT `ff_abort_comments_sticker_multiple_fks`' WHEN @firefly_comments_sticker_fk_count > @firefly_comments_sticker_fk_present THEN 'SELECT `ff_abort_comments_sticker_conflicting_fk`' WHEN @firefly_comments_sticker_fk_present = 0 AND @firefly_comments_sticker_fixed_name_count > 0 THEN 'SELECT `ff_abort_comments_sticker_fk_name_occupied`' ELSE 'SELECT 1' END;
PREPARE firefly_comments_sticker_fk_validation_statement FROM @firefly_comments_sticker_fk_validation_sql; EXECUTE firefly_comments_sticker_fk_validation_statement; DEALLOCATE PREPARE firefly_comments_sticker_fk_validation_statement;
SET @firefly_comments_sticker_fk_cleanup_sql = IF(@firefly_comments_sticker_fk_present = 0, 'UPDATE comments c LEFT JOIN comment_stickers p ON p.id = c.sticker_id SET c.sticker_id = NULL WHERE c.sticker_id IS NOT NULL AND p.id IS NULL', 'SELECT 1');
PREPARE firefly_comments_sticker_fk_cleanup_statement FROM @firefly_comments_sticker_fk_cleanup_sql; EXECUTE firefly_comments_sticker_fk_cleanup_statement; DEALLOCATE PREPARE firefly_comments_sticker_fk_cleanup_statement;
SET @firefly_comments_sticker_fk_add_sql = IF(@firefly_comments_sticker_fk_present = 0, 'ALTER TABLE comments ADD CONSTRAINT fk_comments_sticker FOREIGN KEY (sticker_id) REFERENCES comment_stickers(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE firefly_comments_sticker_fk_add_statement FROM @firefly_comments_sticker_fk_add_sql; EXECUTE firefly_comments_sticker_fk_add_statement; DEALLOCATE PREPARE firefly_comments_sticker_fk_add_statement;
SET @firefly_comments_personal_sticker_fk_present = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'comments' AND k.COLUMN_NAME = 'personal_sticker_id' AND k.REFERENCED_TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME = 'comment_user_stickers' AND k.REFERENCED_COLUMN_NAME = 'id' AND r.DELETE_RULE = 'SET NULL' AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE member WHERE member.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND member.TABLE_NAME = k.TABLE_NAME AND member.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1);
SET @firefly_comments_personal_sticker_fk_count = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND COLUMN_NAME = 'personal_sticker_id' AND REFERENCED_TABLE_NAME IS NOT NULL);
SET @firefly_comments_personal_sticker_fixed_name_count = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_comments_personal_sticker');
SET @firefly_comments_personal_sticker_fk_validation_sql = CASE WHEN @firefly_comments_personal_sticker_fk_present > 1 THEN 'SELECT `ff_abort_comments_personal_sticker_multiple_fks`' WHEN @firefly_comments_personal_sticker_fk_count > @firefly_comments_personal_sticker_fk_present THEN 'SELECT `ff_abort_comments_personal_sticker_conflicting_fk`' WHEN @firefly_comments_personal_sticker_fk_present = 0 AND @firefly_comments_personal_sticker_fixed_name_count > 0 THEN 'SELECT `ff_abort_comments_personal_sticker_fk_name_occupied`' ELSE 'SELECT 1' END;
PREPARE firefly_comments_personal_sticker_fk_validation_statement FROM @firefly_comments_personal_sticker_fk_validation_sql; EXECUTE firefly_comments_personal_sticker_fk_validation_statement; DEALLOCATE PREPARE firefly_comments_personal_sticker_fk_validation_statement;
SET @firefly_comments_personal_sticker_fk_cleanup_sql = IF(@firefly_comments_personal_sticker_fk_present = 0, 'UPDATE comments c LEFT JOIN comment_user_stickers p ON p.id = c.personal_sticker_id SET c.personal_sticker_id = NULL WHERE c.personal_sticker_id IS NOT NULL AND p.id IS NULL', 'SELECT 1');
PREPARE firefly_comments_personal_sticker_fk_cleanup_statement FROM @firefly_comments_personal_sticker_fk_cleanup_sql; EXECUTE firefly_comments_personal_sticker_fk_cleanup_statement; DEALLOCATE PREPARE firefly_comments_personal_sticker_fk_cleanup_statement;
SET @firefly_comments_personal_sticker_fk_add_sql = IF(@firefly_comments_personal_sticker_fk_present = 0, 'ALTER TABLE comments ADD CONSTRAINT fk_comments_personal_sticker FOREIGN KEY (personal_sticker_id) REFERENCES comment_user_stickers(id) ON DELETE SET NULL', 'SELECT 1');
PREPARE firefly_comments_personal_sticker_fk_add_statement FROM @firefly_comments_personal_sticker_fk_add_sql; EXECUTE firefly_comments_personal_sticker_fk_add_statement; DEALLOCATE PREPARE firefly_comments_personal_sticker_fk_add_statement;
SET @firefly_comment_parent_index_sql = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND INDEX_NAME = 'idx_comments_parent') = 0, 'ALTER TABLE comments ADD INDEX idx_comments_parent (parent_id)', 'SELECT 1');
PREPARE firefly_comment_parent_index_statement FROM @firefly_comment_parent_index_sql; EXECUTE firefly_comment_parent_index_statement; DEALLOCATE PREPARE firefly_comment_parent_index_statement;
SET @firefly_comment_user_index_sql = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments' AND INDEX_NAME = 'idx_comments_user') = 0, 'ALTER TABLE comments ADD INDEX idx_comments_user (user_id)', 'SELECT 1');
PREPARE firefly_comment_user_index_statement FROM @firefly_comment_user_index_sql; EXECUTE firefly_comment_user_index_statement; DEALLOCATE PREPARE firefly_comment_user_index_statement;

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Markdown-backed standalone pages. The transfer page keeps its friend links
-- as JSON so the page body and its presentation metadata can be edited as one
-- atomic record from the admin workspace.
CREATE TABLE IF NOT EXISTS managed_pages (
  page_key VARCHAR(32) NOT NULL PRIMARY KEY,
  title VARCHAR(255) NOT NULL DEFAULT '',
  content LONGTEXT NOT NULL,
  friend_links_intro VARCHAR(500) NOT NULL DEFAULT '',
  friend_links JSON NOT NULL DEFAULT (JSON_ARRAY()),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Release notes are stored as Markdown source. Rendering remains a frontend
-- concern, matching normal article and dynamic content handling.
CREATE TABLE IF NOT EXISTS changelogs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(180) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  version VARCHAR(80) NOT NULL DEFAULT '',
  release_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  content LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_changelogs_published_date (published, release_date, id),
  INDEX idx_changelogs_date (release_date, id)
) ENGINE=InnoDB;

-- Basic public feedback records. Attachments can be added independently later;
-- the initial contract intentionally keeps this table text-only.
CREATE TABLE IF NOT EXISTS feedback_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(32) NOT NULL DEFAULT 'other',
  subject VARCHAR(160) NOT NULL,
  content LONGTEXT NOT NULL,
  contact VARCHAR(254) NOT NULL DEFAULT '',
  page_url VARCHAR(1024) NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  client_ip VARCHAR(128) NOT NULL DEFAULT '',
  client_ua VARCHAR(512) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_feedback_status_created (status, created_at, id),
  INDEX idx_feedback_created (created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'superadmin') NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Administrator credentials are initialized explicitly with
-- `tsx src/cli.ts set-admin-password`; no public, reusable password hash is
-- embedded in the schema.

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  INDEX idx_admin_sessions_expiry (expires_at),
  INDEX idx_admin_sessions_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip VARCHAR(128) NOT NULL DEFAULT '',
  method VARCHAR(16) NOT NULL DEFAULT '',
  path VARCHAR(512) NOT NULL DEFAULT '',
  action_name VARCHAR(255) NOT NULL DEFAULT '',
  status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  actor_role VARCHAR(32) NOT NULL DEFAULT '',
  actor_id VARCHAR(128) NOT NULL DEFAULT '',
  actor_account VARCHAR(128) NOT NULL DEFAULT '',
  client_name VARCHAR(255) NOT NULL DEFAULT '',
  client_ua VARCHAR(512) NOT NULL DEFAULT '',
  request_payload LONGTEXT NOT NULL,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  INDEX idx_audit_created (created_at, id),
  INDEX idx_audit_ip (ip),
  INDEX idx_audit_method (method),
  INDEX idx_audit_path (path(191)),
  INDEX idx_audit_actor (actor_role, actor_account)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcement_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  content LONGTEXT NOT NULL,
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_visible BOOLEAN NOT NULL DEFAULT FALSE,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_announcement_history_published (published_at),
  INDEX idx_announcement_history_display (is_visible, is_pinned, sort_order, published_at)
) ENGINE=InnoDB;
