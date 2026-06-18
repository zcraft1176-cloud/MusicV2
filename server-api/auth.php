<?php
/**
 * Auth API Endpoint
 * Verifies Firebase ID token and creates/updates user in MySQL
 * Returns a JWT session token for subsequent API calls
 * 
 * POST /server-api/auth.php
 *   Body: { "idToken": "firebase-id-token" }
 *   Returns: { "token": "jwt-token", "user": { uid, email, displayName, photoURL } }
 */

require_once __DIR__ . '/db.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}

// Parse request body
$input = json_decode(file_get_contents('php://input'), true);
$idToken = $input['idToken'] ?? '';

if (empty($idToken)) {
    jsonResponse(['error' => 'Missing idToken'], 400);
}

// Verify Firebase ID token using Google's public keys
$userData = verifyFirebaseToken($idToken);
if (!$userData) {
    jsonResponse(['error' => 'Invalid or expired token'], 401);
}

// Upsert user in MySQL
$pdo = Database::get();
$stmt = $pdo->prepare("
    INSERT INTO users (uid, email, display_name, photo_url)
    VALUES (:uid, :email, :display_name, :photo_url)
    ON DUPLICATE KEY UPDATE
        email = VALUES(email),
        display_name = VALUES(display_name),
        photo_url = VALUES(photo_url),
        last_login = CURRENT_TIMESTAMP
");
$stmt->execute([
    'uid'          => $userData['uid'],
    'email'        => $userData['email'],
    'display_name' => $userData['name'] ?? '',
    'photo_url'    => $userData['picture'] ?? '',
]);

// Generate JWT session token (valid for 30 days)
$token = generateJWT($userData['uid']);

jsonResponse([
    'token' => $token,
    'user'  => [
        'uid'         => $userData['uid'],
        'email'       => $userData['email'],
        'displayName' => $userData['name'] ?? '',
        'photoURL'    => $userData['picture'] ?? '',
    ]
]);

// =============================================
// Helper Functions
// =============================================

/**
 * Verify Firebase ID token via Google's public certs
 * Returns decoded user data or null
 */
function verifyFirebaseToken(string $idToken): ?array {
    // Decode token without verification first to get header info
    $parts = explode('.', $idToken);
    if (count($parts) !== 3) return null;

    $header = json_decode(base64_decode(strtr($parts[0], '-_', '+/')), true);
    $payload = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);

    if (!$header || !$payload) return null;

    // Basic validation
    $now = time();
    if (($payload['exp'] ?? 0) < $now) return null;         // Expired
    if (($payload['iat'] ?? PHP_INT_MAX) > $now + 300) return null; // Issued in future (allow 5min clock skew)

    // Verify with Google's public keys
    $kid = $header['kid'] ?? '';
    $publicKeys = getGooglePublicKeys();

    if (!isset($publicKeys[$kid])) return null;

    $certificate = $publicKeys[$kid];
    $pubKey = openssl_pkey_get_public($certificate);
    if (!$pubKey) return null;

    // Verify signature
    $dataToVerify = $parts[0] . '.' . $parts[1];
    $signature = base64_decode(strtr($parts[2], '-_', '+/'));

    $alg = $header['alg'] ?? 'RS256';
    $opensslAlg = $alg === 'RS256' ? OPENSSL_ALGO_SHA256 : OPENSSL_ALGO_SHA256;

    $verified = openssl_verify($dataToVerify, $signature, $pubKey, $opensslAlg);

    if ($verified !== 1) return null;

    return [
        'uid'     => $payload['sub'] ?? $payload['user_id'] ?? '',
        'email'   => $payload['email'] ?? '',
        'name'    => $payload['name'] ?? '',
        'picture' => $payload['picture'] ?? '',
    ];
}

/**
 * Fetch Google's public keys for Firebase token verification
 * Cached in /tmp for 1 hour
 */
function getGooglePublicKeys(): array {
    $cacheFile = sys_get_temp_dir() . '/firebase_public_keys.json';
    $cacheMaxAge = 3600; // 1 hour

    // Use cached keys if fresh
    if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheMaxAge) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if ($cached) return $cached;
    }

    // Fetch from Google
    $url = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200 || !$response) {
        // Fallback: return cached even if stale
        if (file_exists($cacheFile)) {
            return json_decode(file_get_contents($cacheFile), true) ?: [];
        }
        return [];
    }

    $keys = json_decode($response, true) ?: [];

    // Cache keys
    file_put_contents($cacheFile, json_encode($keys));

    return $keys;
}

/**
 * Generate a simple JWT token
 */
function generateJWT(string $uid): string {
    $header = rtrim(strtr(base64_encode(json_encode([
        'alg' => 'HS256',
        'typ' => 'JWT'
    ])), '+/', '-_'), '=');

    $payload = rtrim(strtr(base64_encode(json_encode([
        'uid' => $uid,
        'iat' => time(),
        'exp' => time() + (30 * 24 * 60 * 60), // 30 days
    ])), '+/', '-_'), '=');

    $signature = hash_hmac('sha256', "$header.$payload", JWT_SECRET, true);
    $signatureB64 = rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');

    return "$header.$payload.$signatureB64";
}
