<?php
/**
 * Liked Songs API Endpoint
 * 
 * GET  /server-api/liked.php     → Get all liked songs for authenticated user
 * POST /server-api/liked.php     → Sync liked songs (bulk replace)
 * 
 * Headers: Authorization: Bearer <jwt-token>
 */

require_once __DIR__ . '/db.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$user = requireAuth();
$pdo = Database::get();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        handleGet($pdo, $user);
        break;
    case 'POST':
        handlePost($pdo, $user);
        break;
    default:
        jsonResponse(['error' => 'Method not allowed'], 405);
}

/**
 * GET: Return all liked songs for user
 */
function handleGet(PDO $pdo, array $user): void {
    $stmt = $pdo->prepare("
        SELECT track_id AS id, title, artist, cover, duration, bitrate, source, liked_at AS likedAt
        FROM liked_songs
        WHERE user_id = ?
        ORDER BY liked_at DESC
    ");
    $stmt->execute([$user['id']]);
    $songs = $stmt->fetchAll();

    // Cast numeric fields
    foreach ($songs as &$song) {
        $song['duration'] = (int) $song['duration'];
        $song['bitrate'] = (int) $song['bitrate'];
    }

    jsonResponse([
        'songs'     => $songs,
        'updatedAt' => date('c'),
    ]);
}

/**
 * POST: Bulk sync liked songs (replace all)
 * Body: { "songs": [ { id, title, artist, cover, duration, bitrate, source, likedAt } ] }
 */
function handlePost(PDO $pdo, array $user): void {
    $input = json_decode(file_get_contents('php://input'), true);
    $songs = $input['songs'] ?? [];

    if (!is_array($songs)) {
        jsonResponse(['error' => 'Invalid songs data'], 400);
    }

    $pdo->beginTransaction();

    try {
        // Delete existing liked songs for this user
        $stmt = $pdo->prepare("DELETE FROM liked_songs WHERE user_id = ?");
        $stmt->execute([$user['id']]);

        // Insert new songs
        if (!empty($songs)) {
            $stmt = $pdo->prepare("
                INSERT INTO liked_songs (user_id, track_id, title, artist, cover, duration, bitrate, source, liked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");

            foreach ($songs as $song) {
                $stmt->execute([
                    $user['id'],
                    $song['id'] ?? '',
                    $song['title'] ?? '',
                    $song['artist'] ?? '',
                    $song['cover'] ?? '',
                    (int) ($song['duration'] ?? 0),
                    (int) ($song['bitrate'] ?? 0),
                    $song['source'] ?? '',
                    $song['likedAt'] ?? date('c'),
                ]);
            }
        }

        $pdo->commit();
        jsonResponse([
            'success'   => true,
            'count'     => count($songs),
            'updatedAt' => date('c'),
        ]);
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(['error' => 'Sync failed: ' . $e->getMessage()], 500);
    }
}
