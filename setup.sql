-- ================================================
-- MsicFree Database Schema
-- Import via phpMyAdmin atau CLI: mysql -u root -p < setup.sql
-- ================================================

CREATE DATABASE IF NOT EXISTS `msicfree` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `msicfree`;

CREATE TABLE IF NOT EXISTS `users` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `uid` VARCHAR(128) NOT NULL UNIQUE,
    `email` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(255) DEFAULT '',
    `photo_url` TEXT DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `last_login` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_uid` (`uid`),
    INDEX `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `liked_songs` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT UNSIGNED NOT NULL,
    `track_id` VARCHAR(255) NOT NULL,
    `title` VARCHAR(500) NOT NULL,
    `artist` VARCHAR(500) DEFAULT '',
    `cover` TEXT DEFAULT NULL,
    `duration` INT DEFAULT 0,
    `bitrate` INT DEFAULT 0,
    `source` VARCHAR(50) DEFAULT '',
    `liked_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_user_track` (`user_id`, `track_id`),
    INDEX `idx_user` (`user_id`),
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `playlists` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT UNSIGNED NOT NULL,
    `playlist_id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_user_playlist` (`user_id`, `playlist_id`),
    INDEX `idx_user` (`user_id`),
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `playlist_tracks` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `playlist_id` INT UNSIGNED NOT NULL,
    `track_id` VARCHAR(255) NOT NULL,
    `title` VARCHAR(500) NOT NULL,
    `artist` VARCHAR(500) DEFAULT '',
    `cover` TEXT DEFAULT NULL,
    `duration` INT DEFAULT 0,
    `bitrate` INT DEFAULT 0,
    `source` VARCHAR(50) DEFAULT '',
    `position` INT UNSIGNED DEFAULT 0,
    INDEX `idx_playlist` (`playlist_id`),
    FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
