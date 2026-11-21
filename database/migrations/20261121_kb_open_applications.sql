-- 个人知识库：用户「直接开通」申请与管理员审核
-- 通过后写入 kb_admin_grants，实现永久开通（账号封禁仍会拦截）

CREATE TABLE IF NOT EXISTS kb_open_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  admin_id BIGINT UNSIGNED NULL,
  admin_note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_kb_open_app_user FOREIGN KEY (user_id) REFERENCES comment_users(id) ON DELETE CASCADE,
  INDEX idx_kb_open_app_status (status, created_at),
  INDEX idx_kb_open_app_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
