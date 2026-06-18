<?php
/**
 * Database Connection & Auto-Setup
 * PDO singleton with automatic table creation on first run
 */

require_once __DIR__ . '/config.php';

class Database {
    private static ?PDO $instance = null;

    /**
     * Get PDO instance (singleton)
     */
    public static function get(): PDO {
        if (self::$instance === null) {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=%s',
                DB_HOST, DB_PORT, DB_NAME, DB_CHARSET
            );

            try {
                self::$instance = new PDO($dsn, DB_USER, DB_PASS, [
                    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES   => false,
                ]);
            } catch (PDOException $e) {
                // Try to create database if it doesn't exist
                if (strpos($e->getMessage(), 'Unknown database') !== false) {
                    self::createDatabase();
                    return self::get(); // Retry
                }
                http_response_code(500);
                die(json_encode(['error' => 'Database connection failed: ' . $e->getMessage()]));
            }

            self::ensureTables();
        }

        return self::$instance;
    }

    /**
     * Create the database if it doesn't exist
     */
    private static function createDatabase(): void {
        $dsn = sprintf('mysql:host=%s;port=%s;charset=%s', DB_HOST, DB_PORT, DB_CHARSET);
        $pdo = new PDO($dsn, DB_USER, DB_PASS);
        $pdo->exec('CREATE DATABASE IF NOT EXISTS `' . DB_NAME . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    }

    /**
     * Create tables if they don't exist (auto-setup)
     */
    private static function ensureTables(): void {
        $pdo = self::$instance;

        // Check if tables exist
        $stmt = $pdo->query("SHOW TABLES LIKE 'users'");
        if ($stmt->rowCount() > 0) return; // Already set up

        $pdo->exec("
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
        ");

        $pdo->exec("
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
        ");

        $pdo->exec("
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
        ");

        $pdo->exec("
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
        ");
    }
}

/**
 * Helper: Send JSON response
 */
function jsonResponse(mixed $data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Helper: Get authenticated user from Authorization header
 * Returns user row from DB or null
 */
function getAuthUser(): ?array {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/Bearer\s+(.+)/', $header, $matches)) {
        return null;
    }

    $token = $matches[1];

    // Decode JWT token (signed with JWT_SECRET)
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;

    $payload = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
    if (!$payload) return null;

    // Verify signature
    $headerB64 = $parts[0];
    $payloadB64 = $parts[1];
    $signature = hash_hmac('sha256', "$headerB64.$payloadB64", JWT_SECRET, true);
    $expectedSig = rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');

    if (!hash_equals($expectedSig, $parts[2])) return null;

    // Check expiration
    if (isset($payload['exp']) && $payload['exp'] < time()) return null;

    // Get user from DB
    $pdo = Database::get();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE uid = ? LIMIT 1');
    $stmt->execute([$payload['uid']]);
    return $stmt->fetch() ?: null;
}

/**
 * Helper: Require authentication (returns user or dies with 401)
 */
function requireAuth(): array {
    $user = getAuthUser();
    if (!$user) {
        jsonResponse(['error' => 'Unauthorized'], 401);
    }
    return $user;
}
