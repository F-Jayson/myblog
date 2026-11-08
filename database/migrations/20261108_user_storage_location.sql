-- Migration: Add user storage location preference, switch cooldown, and storage migration tracking

ALTER TABLE comment_users
    ADD COLUMN storage_location ENUM('server', 'cloudflare') DEFAULT NULL AFTER is_admin,
    ADD COLUMN storage_location_switched_at DATETIME DEFAULT NULL AFTER storage_location;

CREATE TABLE IF NOT EXISTS storage_migrations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    from_location ENUM('server', 'cloudflare') NOT NULL,
    to_location ENUM('server', 'cloudflare') NOT NULL,
    status ENUM('pending', 'in_progress', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    total_files INT UNSIGNED NOT NULL DEFAULT 0,
    migrated_files INT UNSIGNED NOT NULL DEFAULT 0,
    total_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    migrated_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    current_file VARCHAR(255) NULL,
    error_message TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    INDEX idx_user_status (user_id, status),
    CONSTRAINT fk_storage_migrations_user FOREIGN KEY (user_id) REFERENCES comment_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
