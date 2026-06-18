<?php
/**
 * Playlists API Endpoint
 * GET/POST/DELETE /server-api/playlists.php
 * Headers: Authorization: Bearer <jwt-token>
 */
require_once __DIR__ . '/db.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$user = requireAuth();
$pdo = Database::get();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':    handleGet($pdo, $user); break;
    case 'POST':   handlePost($pdo, $user); break;
    case 'DELETE': handleDelete($pdo, $user); break;
    default:       jsonResponse(['error' => 'Method not allowed'], 405);
}

function handleGet(PDO $pdo, array $user): void {
    $stmt = $pdo->prepare("SELECT id, playlist_id, name, created_at AS createdAt, updated_at AS updatedAt FROM playlists WHERE user_id = ? ORDER BY created_at ASC");
    $stmt->execute([$user['id']]);
    $playlists = $stmt->fetchAll();

    $trackStmt = $pdo->prepare("SELECT track_id AS id, title, artist, cover, duration, bitrate, source FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC");

    $result = [];
    foreach ($playlists as $pl) {
        $trackStmt->execute([$pl['id']]);
        $tracks = $trackStmt->fetchAll();
        foreach ($tracks as &$t) { $t['duration'] = (int)$t['duration']; $t['bitrate'] = (int)$t['bitrate']; }
        $result[] = ['id' => $pl['playlist_id'], 'name' => $pl['name'], 'tracks' => $tracks, 'createdAt' => $pl['createdAt'], 'updatedAt' => $pl['updatedAt']];
    }
    jsonResponse(['playlists' => $result]);
}

function handlePost(PDO $pdo, array $user): void {
    $input = json_decode(file_get_contents('php://input'), true);
    $playlistId = $input['id'] ?? '';
    $name = $input['name'] ?? '';
    $tracks = $input['tracks'] ?? [];

    if (empty($playlistId) || empty($name)) { jsonResponse(['error' => 'Missing id or name'], 400); }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("INSERT INTO playlists (user_id, playlist_id, name, created_at, updated_at) VALUES (:uid, :pid, :name, :cat, :uat) ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)");
        $stmt->execute(['uid' => $user['id'], 'pid' => $playlistId, 'name' => $name, 'cat' => $input['createdAt'] ?? date('c'), 'uat' => $input['updatedAt'] ?? date('c')]);

        $stmt = $pdo->prepare("SELECT id FROM playlists WHERE user_id = ? AND playlist_id = ?");
        $stmt->execute([$user['id'], $playlistId]);
        $dbId = $stmt->fetchColumn();

        $pdo->prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?")->execute([$dbId]);

        if (!empty($tracks)) {
            $ins = $pdo->prepare("INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, cover, duration, bitrate, source, position) VALUES (?,?,?,?,?,?,?,?,?)");
            foreach ($tracks as $i => $t) {
                $ins->execute([$dbId, $t['id']??'', $t['title']??'', $t['artist']??'', $t['cover']??'', (int)($t['duration']??0), (int)($t['bitrate']??0), $t['source']??'', $i]);
            }
        }
        $pdo->commit();
        jsonResponse(['success' => true, 'id' => $playlistId, 'tracks' => count($tracks)]);
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(['error' => 'Save failed: ' . $e->getMessage()], 500);
    }
}

function handleDelete(PDO $pdo, array $user): void {
    $playlistId = $_GET['id'] ?? '';
    if (empty($playlistId)) { jsonResponse(['error' => 'Missing id'], 400); }
    $pdo->prepare("DELETE FROM playlists WHERE user_id = ? AND playlist_id = ?")->execute([$user['id'], $playlistId]);
    jsonResponse(['success' => true, 'deleted' => $playlistId]);
}
