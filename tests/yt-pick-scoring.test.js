/**
 * Tests for YouTube candidate selection in src/js/api.js.
 *
 * Context: the app shows Deezer's track list, then asks YouTube which upload of
 * that track to play. That second step used to pick the EDM remix over the
 * original for "BTS - Dynamite" because both scored ~150 and nothing pushed
 * alternative versions down.
 *
 * These tests load the REAL api.js in a vm sandbox (not a copy, so they cannot
 * drift) and stub pipedFetch with controlled YouTube results.
 *
 * Run: node tests/yt-pick-scoring.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'js', 'api.js');
const code = fs.readFileSync(SRC, 'utf8');

// api.js is a browser script: give it the few globals it touches at load time.
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: async () => { throw new Error('network disabled in tests'); },
  AbortController,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  encodeURIComponent,
  Promise,
  Math,
  Date,
  JSON,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

// `const MusicAPI` does not attach to the sandbox object, so read it back out of
// the script's scope by evaluating an expression after the file.
const { versionPenalty, isOfficialChannel, MusicAPI } = vm.runInContext(
  `${code}\n;({ versionPenalty, isOfficialChannel, MusicAPI })`,
  sandbox,
  { filename: SRC }
);

/** Stub piped search, then run the real findVideoId. */
function pick(items, query, duration, filter = 'music_songs') {
  MusicAPI.piped.pipedFetch = async () => ({ items });
  return MusicAPI.piped.findVideoId(query, duration, filter);
}

const vid = n => `https://www.youtube.com/watch?v=vid${String(n).padStart(8, '0')}`;
const stream = (title, uploaderName, duration, n) =>
  ({ type: 'stream', title, uploaderName, duration, url: vid(n) });

let pass = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // async check: queue it, await at the end
      pending.push(r.then(() => {
        console.log(`  ok   ${name}`); pass++;
      }, e => {
        console.log(`  FAIL ${name}\n       ${e.message}`);
        process.exitCode = 1;
      }));
      return;
    }
    console.log(`  ok   ${name}`); pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1;
  }
};
const pending = [];

console.log('helpers');

t('versionPenalty: penalises unrequested "remix"', () => {
  assert.ok(versionPenalty('dynamite edm remix', 'bts dynamite') >= 40);
});

t('versionPenalty: no penalty when the user asked for a remix', () => {
  assert.strictEqual(versionPenalty('dynamite edm remix', 'bts dynamite remix'), 0);
});

t('versionPenalty: stacks for multiple version words', () => {
  assert.strictEqual(versionPenalty('song live acoustic cover', 'artist song'), 120);
});

t('versionPenalty: clean title scores zero', () => {
  assert.strictEqual(versionPenalty('blinding lights', 'the weeknd blinding lights'), 0);
});

t('isOfficialChannel: "- Topic" counts as official', () => {
  assert.strictEqual(isOfficialChannel('the weeknd - topic', 'the weeknd blinding lights'), true);
});

t('isOfficialChannel: VEVO counts as official', () => {
  assert.strictEqual(isOfficialChannel('bts vevo', 'bts dynamite'), true);
});

t('isOfficialChannel: uploader matching the artist prefix counts', () => {
  assert.strictEqual(isOfficialChannel('halsey', 'halsey without me'), true);
});

t('isOfficialChannel: unrelated reupload does not', () => {
  assert.strictEqual(isOfficialChannel('pop hits compilation', 'the weeknd blinding lights'), false);
});

console.log('\nfindVideoId selection');

t('REGRESSION: original beats the EDM remix for "BTS Dynamite"', async () => {
  // Real measured case: both 199s and matching keywords; the remix used to win.
  const items = [
    stream('Dynamite (EDM Remix)', 'BTS', 199, 1),
    stream('Dynamite', 'BTS', 199, 2),
  ];
  assert.strictEqual(await pick(items, 'BTS Dynamite', 199), 'vid00000002',
    'picked the remix, not the original');
});

t('remix still wins when the query asks for a remix', async () => {
  const items = [
    stream('Dynamite', 'BTS', 199, 1),
    stream('Dynamite (EDM Remix)', 'BTS', 199, 2),
  ];
  assert.strictEqual(await pick(items, 'BTS Dynamite Remix', 199), 'vid00000002',
    'explicit remix query must still resolve to the remix');
});

t('cover loses to the original artist recording', async () => {
  const items = [
    stream('Creep (Cover of Radiohead)', 'Glee Cast', 239, 1),
    stream('Creep', 'Radiohead', 239, 2),
  ];
  assert.strictEqual(await pick(items, 'Radiohead Creep', 238), 'vid00000002');
});

t('live version loses to the studio version', async () => {
  const items = [
    stream('Monokrom (Live)', 'Tulus', 215, 1),
    stream('Monokrom', 'Tulus', 215, 2),
  ];
  assert.strictEqual(await pick(items, 'Tulus Monokrom', 214), 'vid00000002');
});

t('an in-query version word is honoured (live)', async () => {
  const items = [
    stream('Monokrom', 'Tulus', 215, 1),
    stream('Monokrom Live', 'Tulus', 215, 2),
  ];
  assert.strictEqual(await pick(items, 'Tulus Monokrom live', 214), 'vid00000002');
});

t('tie on relevance goes to the official channel regardless of input order', async () => {
  const a = stream('Blinding Lights', 'SomeReupload Channel', 201, 1);
  const b = stream('Blinding Lights', 'The Weeknd - Topic', 201, 2);
  assert.strictEqual(await pick([a, b], 'The Weeknd Blinding Lights', 200), 'vid00000002');
  assert.strictEqual(await pick([b, a], 'The Weeknd Blinding Lights', 200), 'vid00000002',
    'input order decided the winner again');
});

t('non-official uploads remain playable when nothing better exists', async () => {
  // Key requirement: non-official tracks must never become unplayable.
  const items = [
    stream('Rare B-Side (Fan Upload)', 'Some Fan Channel', 180, 1),
    stream('Totally Different Song', 'Nobody', 180, 2),
  ];
  const got = await pick(items, 'Artist Rare B-Side', 180);
  assert.strictEqual(got, 'vid00000001',
    'a fan upload should still be picked when it is the only real match');
});

t('NaN guard: an all-short query still ranks by duration', async () => {
  // "iu bb": every query word is <= 2 chars, so queryWords is empty and the
  // old code produced 0/0 = NaN, making the whole sort a no-op.
  const items = [
    stream('BB', 'IU', 200, 1),
    stream('Wrong Song', 'Nobody', 400, 2),
  ];
  assert.strictEqual(await pick(items, 'iu bb', 200), 'vid00000001');
});

t('scores are finite numbers (no NaN leaking into the sort)', async () => {
  MusicAPI.piped.pipedFetch = async () => ({ items: [stream('BB', 'IU', 200, 1)] });
  const v = await MusicAPI.piped.findVideoId('iu bb', 200);
  assert.strictEqual(v, 'vid00000001');
});

t('duration filters still apply: no candidate in 30-600s returns null', async () => {
  const items = [
    stream('Long Symphony', 'Orchestra', 900, 1),
    stream('Short Clip', 'Someone', 12, 2),
  ];
  assert.strictEqual(await pick(items, 'Artist Long Symphony', 900), null);
});

t('empty result set returns null instead of throwing', async () => {
  assert.strictEqual(await pick([], 'anything here', 200), null);
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} checks passed`);
});
