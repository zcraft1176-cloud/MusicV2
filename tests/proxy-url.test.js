/**
 * Tests for the proxy-URL switch and whitelist consistency.
 *
 * Why this matters: XAMPP runs proxy.php, but Vercel runs NO PHP — it serves
 * proxy.php as source text. If getProxyUrl() returns proxy.php on a deployed
 * host, every search silently dies. Conversely the serverless /api/proxy has a
 * domain whitelist that must match api.js's instance lists, or requests 403.
 *
 * Run: node tests/proxy-url.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_SRC = path.join(ROOT, 'src', 'js', 'api.js');
const code = fs.readFileSync(API_SRC, 'utf8');

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** Load api.js with a chosen hostname and return getProxyUrl's output. */
function proxyBaseFor(hostname) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => { throw new Error('no network in tests'); },
    AbortController, setTimeout, clearTimeout, URLSearchParams,
    encodeURIComponent, Promise, Math, Date, JSON,
    window: { location: { hostname } },
  };
  vm.createContext(sandbox);
  const { MusicAPI } = vm.runInContext(`${code}\n;({ MusicAPI })`, sandbox, { filename: API_SRC });
  return MusicAPI.getProxyUrl('https://api.deezer.com/search?q=x');
}

console.log('proxy base by host');

t('localhost uses the PHP proxy', () => {
  assert.ok(proxyBaseFor('localhost').startsWith('proxy.php?url='),
    'localhost must use proxy.php (XAMPP serves PHP)');
});

t('127.0.0.1 uses the PHP proxy', () => {
  assert.ok(proxyBaseFor('127.0.0.1').startsWith('proxy.php?url='));
});

t('a deployed host uses the serverless /api/proxy', () => {
  const got = proxyBaseFor('msicfree.vercel.app');
  assert.ok(got.startsWith('/api/proxy?url='),
    `deployed host must not use proxy.php (Vercel cannot run PHP), got: ${got}`);
});

t('the url parameter is encoded', () => {
  const got = proxyBaseFor('localhost');
  assert.ok(!got.includes('api.deezer.com/'), 'upstream URL must be encoded');
  assert.ok(got.includes(encodeURIComponent('https://api.deezer.com')));
});

console.log('\nwhitelist consistency (3 files must agree)');

const domainsIn = (text) => new Set([...text.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/g)].map(m => m[1]));

const proxyPhp = fs.readFileSync(path.join(ROOT, 'proxy.php'), 'utf8');
const proxyJs = fs.readFileSync(path.join(ROOT, 'api', 'proxy.js'), 'utf8');

// api.js instances: pull hostnames out of the piped/invidious instance arrays
const apiHosts = domainsIn(code);
const phpHosts = domainsIn(proxyPhp);
const jsHosts = domainsIn(proxyJs);

t('api/proxy.js and proxy.php whitelist the same domains', () => {
  const a = [...phpHosts].sort(), b = [...jsHosts].sort();
  assert.deepStrictEqual(b, a,
    `proxy.php has ${a.join(', ')}\n       api/proxy.js has ${b.join(', ')}`);
});

t('every Piped/Invidious instance in api.js is whitelisted', () => {
  const instances = [...code.matchAll(/'https:\/\/([a-z0-9.-]+)'/g)].map(m => m[1]);
  assert.ok(instances.length >= 8, `expected >=8 instances, found ${instances.length}`);
  for (const host of instances) {
    assert.ok(phpHosts.has(host), `instance "${host}" is missing from the proxy whitelist`);
  }
});

console.log(`\n${pass} checks passed`);
