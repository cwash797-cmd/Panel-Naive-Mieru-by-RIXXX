/**
 * Panel Naive + Mieru by RIXXX — Express backend  v1.2.6
 * Node.js 20 LTS + Express + better-sqlite3 + WebSocket + node-cron
 *
 * v1.2.3: Migrated from standalone naive binary to caddy-forwardproxy-naive.
 *   buildCaddyfile(cfg, users) — rebuilds /etc/caddy-naive/Caddyfile atomically
 *   reloadCaddy()              — systemctl reload caddy-naive (graceful, zero downtime)
 *   applyAllConfigs()          — rebuilds Caddyfile + applies Mita config in one call
 *   /api/services/rebuild-all  — endpoint used by update.sh --repair
 *
 * v1.2.5 hotfixes:
 *   Bug 44: buildCaddyfile() skips users without plaintext password (logs warning)
 *   Bug 50: reloadCaddy() uses only systemctl reload — pgrep fallback removed
 *   Bug 51: buildMitaStateFile() uses safe defaults for mieruPortStart/End
 *   Bug 52: /api/settings/naive-port verifies caddy-naive is active after restart
 *   Bug 53: saveConfig() performs atomic write via .new tmp file then rename
 *
 * Bug 5:  Sing-Box outbound uses `transport` field (not `protocol`)
 * Bug 7:  UFW single-port vs range helper (ufwMieruRule)
 * Bug 12: server_ports array in Mieru Sing-Box config
 * Bug 13: version synced via scripts/sync-version.sh
 */
'use strict';

const express        = require('express');
const session        = require('express-session');
const helmet         = require('helmet');
const morgan         = require('morgan');
const rateLimit      = require('express-rate-limit');
const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cron           = require('node-cron');
const http           = require('http');
const { WebSocketServer } = require('ws');
const fs             = require('fs');
const path           = require('path');
const { execSync, execFileSync } = require('child_process');
const si             = require('systeminformation');
const crypto         = require('crypto');   // Bug 100: module-level require so generateSafePassword() has a real Node crypto (not Web-Crypto globalThis.crypto, which lacks randomInt)

// ── Paths ─────────────────────────────────────────────────────────────────────
const PANEL_CONFIG    = '/etc/rixxx-panel/config.json';
const DB_PATH         = '/var/lib/rixxx-panel/db.sqlite';
const MITA_STATE_FILE = '/var/lib/rixxx-panel/mita-state.json';
// Bug 143: canonical version source written by install.sh / update.sh from the
// repo's VERSION file. Read LIVE on each /api/status so the panel UI reflects
// the installed version immediately after `update.sh` — no manual edits, no
// process restart needed. Format: `panel_version=X.Y.Z`.
const VERSION_FILE    = '/etc/rixxx-panel/version';

// v1.2.3: Caddy-forwardproxy-naive paths (replaces standalone naive binary)
const CADDY_BIN         = '/usr/local/bin/caddy-naive';
const CADDY_CONFIG_DIR  = '/etc/caddy-naive';
const CADDY_FILE        = '/etc/caddy-naive/Caddyfile';
const FAKE_SITE_DIR     = '/var/www/fake-site';
const LOG_CADDY         = '/var/log/caddy-naive/access.log';
const LOG_PANEL         = '/var/log/panel-naive-mieru.log';

// Legacy path kept for migration detection only
const LEGACY_NAIVE_BIN = '/usr/local/bin/naive';

// ── Load system config ────────────────────────────────────────────────────────
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(PANEL_CONFIG, 'utf8'));
} catch {
  cfg = {
    domain: 'localhost', serverIp: '127.0.0.1',
    adminUser: 'admin',
    adminPassHash: bcrypt.hashSync('admin', 12),
    naivePort: 443, mieruPortStart: 2012, mieruPortEnd: 2022,
    // Hy2 (Hysteria2) — QUIC/UDP proxy. Default UDP/443 coexists with Naive on
    // TCP/443 (our Caddy runs `protocols h1 h2` → HTTP/3 off → UDP/443 free).
    // `stack.hy2` marks whether the operator has installed the Hy2 server.
    hy2Port: 443,
    stack: { naive: true, mieru: true, hy2: false },
    dbPath:        DB_PATH,
    caddyBin:      CADDY_BIN,
    caddyFile:     CADDY_FILE,
    caddyConfigDir: CADDY_CONFIG_DIR,
    fakeSiteDir:   FAKE_SITE_DIR,
    fakeSiteUrl:   'https://www.example.com',
    probeSecret:   '',
    probeMode:     'bare',   // Bug 81: 'off' | 'bare' | 'secret' (matches known-good ref)
    mitaStateFile: MITA_STATE_FILE,
    trafficPattern: 'NOOP', mtu: 1400, udpEnabled: false,
    // v1.8.7: optional dedicated subscription domain (e.g.
    // https://sub.example.com). Empty ⇒ subscription links use the panel domain.
    subBaseUrl: '',
    // Cascade (relay): Naive uses Caddyfile upstream; Mieru uses Variant B
    // (redsocks+iptables+mieru-client) orchestrated by scripts/cascade_mieru.sh.
    cascadeEnabled: false, cascadeNaiveUpstream: '',
    cascadeMieru: { host: '', portStart: 2012, portEnd: 2022, user: '', pass: '', mtu: 1400 },
    cascadeMieruEgress: {},   // legacy (Variant A native egress) — kept for back-compat
    // FEATURE (egress): Cloudflare WARP as a server-wide egress mode. Exactly one
    // of three egress modes is active at any time: native IP / Mieru cascade /
    // WARP. WARP and cascade are MUTUALLY EXCLUSIVE (enabling one disables the
    // other). Orchestrated by scripts/warp_egress.sh (wgcf + wg-quick).
    warpEnabled: false,
    // BUG-162: boot-persistence is OFF by default. Only set true when the
    //   operator explicitly confirms autostart (protects against reboot lock-out).
    warpPersist: false,
    language: 'ru', version: '1.6.0'
  };
}

// ── Hy2 config normalization ──────────────────────────────────────────────────
// Existing installs (config.json written before Hy2 support) will NOT have
// `hy2Port` or `stack`. Backfill safe defaults at load time so the rest of the
// code can assume they exist. We DO NOT flip stack.hy2 to true here — that only
// happens after the operator installs Hy2 (POST /api/settings/hy2/install).
if (cfg.hy2Port === undefined || cfg.hy2Port === null) cfg.hy2Port = 443;
if (!cfg.stack || typeof cfg.stack !== 'object') {
  // Legacy config: naive+mieru were always installed together by install.sh.
  cfg.stack = { naive: true, mieru: true, hy2: false };
}
if (cfg.stack.naive === undefined) cfg.stack.naive = true;
if (cfg.stack.mieru === undefined) cfg.stack.mieru = true;
if (cfg.stack.hy2   === undefined) cfg.stack.hy2   = false;

// Bug 143 (recurring): single source of truth for the displayed version.
// Precedence, read LIVE so the UI updates the moment update.sh runs:
//   1. /etc/rixxx-panel/version   (written by install.sh/update.sh from VERSION)
//   2. the VERSION file bundled next to the panel code (repo source of truth)
//   3. config.json's `version` field (synced by update.sh as a belt-and-braces)
//   4. hard fallback constant
// Returns a clean semver-ish string. Cheap (tiny file reads); fine per-request.
const VERSION_FALLBACK = '1.6.0';
function readPanelVersion() {
  // 1) /etc/rixxx-panel/version  → "panel_version=1.4.4"
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8');
    const m = raw.match(/panel_version\s*=\s*([^\s#]+)/);
    const v = (m ? m[1] : raw.split('\n')[0]).trim();
    if (v) return v;
  } catch {}
  // 2) bundled VERSION file (../../VERSION relative to server/index.js)
  for (const p of [path.join(__dirname, '..', '..', 'VERSION'),
                   path.join(__dirname, '..', 'VERSION')]) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {}
  }
  // 3) config.json
  if (cfg && cfg.version) return String(cfg.version).trim();
  // 4) fallback
  return VERSION_FALLBACK;
}

// Resolved paths (prefer config values, fall back to constants)
const resolvedDb        = cfg.dbPath        || DB_PATH;
const resolvedMitaFile  = cfg.mitaStateFile || MITA_STATE_FILE;
const resolvedCaddyFile = cfg.caddyFile     || CADDY_FILE;
const resolvedCaddyBin  = cfg.caddyBin      || CADDY_BIN;
const resolvedCaddyCfgDir = cfg.caddyConfigDir || CADDY_CONFIG_DIR;
const resolvedFakeSiteDir = cfg.fakeSiteDir  || FAKE_SITE_DIR;

// ── SQLite (better-sqlite3) ───────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(resolvedDb), { recursive: true });
  db = new Database(resolvedDb);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT UNIQUE,
      username  TEXT NOT NULL UNIQUE,
      passHash  TEXT NOT NULL,
      password  TEXT NOT NULL DEFAULT '',
      expiry    TEXT,
      protocols TEXT DEFAULT '["naive","mieru"]',
      quotaMB   INTEGER DEFAULT 0,
      usedMB    REAL    DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeen  TEXT
    );
    CREATE TABLE IF NOT EXISTS traffic_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL,
      uploadMB   REAL DEFAULT 0,
      downloadMB REAL DEFAULT 0,
      ts         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS panel_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Migrate: add password column if missing (upgrade from v1.0.x)
  try { db.exec(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''`); } catch {}

  // v1.8.7: add sub_token column for the per-user subscription link (/sub/:token).
  // The token is a random, unguessable 128-bit hex string minted at user
  // creation. It is deliberately SEPARATE from the sequential-ish `id` so the
  // PUBLIC /sub/:token route can never be enumerated from a leaked id. Existing
  // users get a token back-filled below (idempotent).
  try { db.exec(`ALTER TABLE users ADD COLUMN sub_token TEXT`); } catch {}
  try {
    const missing = db.prepare(`SELECT id FROM users WHERE sub_token IS NULL OR sub_token = ''`).all();
    if (missing.length) {
      const upd = db.prepare(`UPDATE users SET sub_token = ? WHERE id = ?`);
      const tx  = db.transaction(rows => {
        for (const r of rows) upd.run(require('crypto').randomBytes(16).toString('hex'), r.id);
      });
      tx(missing);
      console.log(`[DB] back-filled sub_token for ${missing.length} existing user(s)`);
    }
  } catch (e) { console.warn('[DB] sub_token back-fill skipped:', e && e.message); }

  // v1.9.0: personal "bonus links" per user (BONUS-LINKS feature).
  // A nullable JSON-TEXT column holding an array of {url, enabled} objects that
  // the admin manually attaches to THIS user's subscription (e.g. a vless://
  // link exported from 3x-ui). Empty/NULL == no bonuses == byte-identical
  // subscription output as before (see parseUserRow + /sub/:token). The ALTER is
  // idempotent: a second run throws "duplicate column" which we swallow, so
  // update.sh never fails on an already-migrated live install. We deliberately
  // do NOT touch the DB file perms/owner here (stays 600 root:root).
  try { db.exec(`ALTER TABLE users ADD COLUMN bonus_links TEXT`); } catch {}

  // Migrate: make `email` nullable so it can be optional (TLS cert is set at
  // install time via Caddy ACME, not per-user). Old schema had `email TEXT
  // NOT NULL UNIQUE`, which rejects empty/absent emails and collides on ''.
  // Rebuild the table only if the column is still NOT NULL.
  try {
    const cols = db.prepare(`PRAGMA table_info(users)`).all();
    const emailCol = cols.find(c => c.name === 'email');
    if (emailCol && emailCol.notnull === 1) {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE users RENAME TO users_legacy;
        CREATE TABLE users (
          id        TEXT PRIMARY KEY,
          email     TEXT UNIQUE,
          username  TEXT NOT NULL UNIQUE,
          passHash  TEXT NOT NULL,
          password  TEXT NOT NULL DEFAULT '',
          expiry    TEXT,
          protocols TEXT DEFAULT '["naive","mieru"]',
          quotaMB   INTEGER DEFAULT 0,
          usedMB    REAL    DEFAULT 0,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          lastSeen  TEXT
        );
        INSERT INTO users
          (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen)
        SELECT
          id,
          CASE WHEN email='' THEN NULL ELSE email END,
          username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen
        FROM users_legacy;
        DROP TABLE users_legacy;
        COMMIT;
      `);
      console.log('[DB] migrated users.email -> nullable (email is now optional)');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[DB] email-nullable migration skipped:', e.message);
  }

  // Bug 149 (CRITICAL): servers upgraded from v1.2 have `email TEXT UNIQUE`
  // (already nullable, so the rebuild above is skipped) but v1.2 *stored* an
  // empty string '' for users without an email. SQLite treats '' as a real,
  // distinct value for UNIQUE — so the SECOND empty-email row already collides,
  // and creating ANY new user fails with "UNIQUE constraint failed: users.email".
  // Normalise every legacy '' email to NULL unconditionally (NULLs are exempt
  // from UNIQUE in SQLite, so an unlimited number of users may have no email).
  try {
    const fixed = db.prepare(`UPDATE users SET email = NULL WHERE email = ''`).run();
    if (fixed.changes > 0)
      console.log(`[DB] Bug 149 fix: normalised ${fixed.changes} legacy empty-string email(s) -> NULL`);
  } catch (e) {
    console.error('[DB] empty-email normalisation failed:', e.message);
  }
} catch (err) {
  console.error('[DB] SQLite unavailable:', err.message, '— using in-memory store');
}

// In-memory fallback
const memUsers = new Map();

// ── User DB helpers ───────────────────────────────────────────────────────────
function getAllUsers() {
  if (db) return db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all();
  return [...memUsers.values()];
}
function getUserByUsername(username) {
  if (db) return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return [...memUsers.values()].find(u => u.username === username);
}
function getUserById(id) {
  if (db) return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return memUsers.get(id);
}
// v1.8.7: resolve the base URL for subscription links. Uses the optional
// `subBaseUrl` setting when the admin has configured a dedicated sub domain
// (e.g. https://sub.example.com); otherwise falls back to https://<panel domain>.
// Always returns a value WITHOUT a trailing slash.
function subBaseUrl() {
  let base = String(cfg.subBaseUrl || '').trim();
  if (!base) base = `https://${cfg.domain || 'localhost'}`;
  // Normalize: ensure a scheme, strip trailing slashes.
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

// Extract the bare host[:port] from subBaseUrl for the Caddy sub-domain block.
function subDomainHost() {
  const raw = String(cfg.subBaseUrl || '').trim();
  if (!raw) return '';
  const m = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  return m;
}

// v1.8.7: look up a user by their subscription token (public /sub/:token route).
function getUserBySubToken(token) {
  if (!token) return undefined;
  if (db) return db.prepare('SELECT * FROM users WHERE sub_token = ?').get(token);
  return [...memUsers.values()].find(u => u.sub_token === token);
}
// Bug 149: map a raw better-sqlite3 error to a safe, user-facing message +
// HTTP status. UNIQUE-constraint violations become friendly 409s; everything
// else stays a generic 500 with NO internal path/stacktrace leaked to the UI.
function describeDbError(e) {
  const msg = String(e && e.message || '');
  if (/UNIQUE constraint failed:\s*users\.email/i.test(msg))
    return { status: 409, error: 'Email already in use' };
  if (/UNIQUE constraint failed:\s*users\.username/i.test(msg))
    return { status: 409, error: 'Username already exists' };
  if (/UNIQUE constraint failed/i.test(msg))
    return { status: 409, error: 'A user with these details already exists' };
  return { status: 500, error: 'Could not save user (database error)' };
}

function upsertUser(u) {
  if (db) {
    // Bug 149: never persist an empty-string email — UNIQUE treats '' as a real
    // value and collides across email-less users. Always store NULL instead.
    const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
    db.prepare(`
      INSERT INTO users
        (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen,sub_token)
      VALUES
        (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen,@sub_token)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, username=excluded.username,
        passHash=excluded.passHash, password=excluded.password,
        expiry=excluded.expiry, protocols=excluded.protocols,
        quotaMB=excluded.quotaMB, usedMB=excluded.usedMB,
        updatedAt=excluded.updatedAt, lastSeen=excluded.lastSeen,
        sub_token=COALESCE(excluded.sub_token, users.sub_token)
    `).run({ ...u, email, password: u.password || '',
             sub_token: u.sub_token || crypto.randomBytes(16).toString('hex') });
  } else {
    memUsers.set(u.id, u);
  }
}

// Bug 149 (race): create a user atomically. The old flow did
// `getUserByUsername()` then a separate INSERT, each request minting a fresh
// UUID. On a double-submit the first request created the user (201) while the
// second slipped past the pre-check, hit the UNIQUE(username) constraint, and
// returned a false "Username already exists" — even though the user already
// existed and the key worked (visible only after F5).
//
// Strategy: a single `INSERT ... ON CONFLICT(username) DO NOTHING`.
//   - changes===1 → we inserted the row  → { created:true }.
//   - changes===0 → the username already exists. The CALLER guarantees (via a
//     synchronous "did it exist before this request?" check + the in-flight
//     coalescing map) that this can only be a concurrent twin of THIS create,
//     so it's an idempotent success → { created:false, idempotent:true } with
//     the existing row. (We don't compare passHash because bcrypt salts differ
//     per call; a genuine pre-existing clash is rejected by the route before we
//     ever get here.)
function createUserAtomic(u) {
  const email = (u.email && String(u.email).trim()) ? String(u.email).trim() : null;
  if (db) {
    const info = db.prepare(`
      INSERT INTO users
        (id,email,username,passHash,password,expiry,protocols,quotaMB,usedMB,createdAt,updatedAt,lastSeen,sub_token)
      VALUES
        (@id,@email,@username,@passHash,@password,@expiry,@protocols,@quotaMB,@usedMB,@createdAt,@updatedAt,@lastSeen,@sub_token)
      ON CONFLICT(username) DO NOTHING
    `).run({ ...u, email, password: u.password || '',
             sub_token: u.sub_token || crypto.randomBytes(16).toString('hex') });

    if (info.changes === 1)
      return { created: true, user: getUserByUsername(u.username) };
    // No insert → a concurrent twin already created it → idempotent success.
    return { created: false, idempotent: true, user: getUserByUsername(u.username) };
  }
  // in-memory fallback
  const existing = [...memUsers.values()].find(x => x.username === u.username);
  if (existing) return { created: false, idempotent: true, user: existing };
  memUsers.set(u.id, { ...u, email });
  return { created: true, user: memUsers.get(u.id) };
}

// Bug 149 (race): coalesce concurrent create requests for the same username so a
// rapid double-submit can't even start two INSERTs. Maps username -> Promise of
// the in-flight create result.
const inflightCreates = new Map();

// Bug 149: cheap duplicate-email pre-check so we can return a clean 409 BEFORE
// hitting the UNIQUE constraint (and as a guard for email-less users → no row).
function getUserByEmail(email) {
  const e = (email && String(email).trim()) ? String(email).trim() : null;
  if (!e) return undefined;
  if (db) return db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  return [...memUsers.values()].find(u => u.email === e);
}
function deleteUser(id) {
  if (db) db.prepare('DELETE FROM users WHERE id = ?').run(id);
  else memUsers.delete(id);
}

// ── Persist config ────────────────────────────────────────────────────────────
// Bug 53: atomic write via .new temp file then rename — prevents partial reads
//         if the process is interrupted during the write.
function saveConfig() {
  try {
    const dir = path.dirname(PANEL_CONFIG);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = PANEL_CONFIG + '.new';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PANEL_CONFIG);   // atomic replace
  } catch (e) { console.error('[CFG]', e.message); }
}

// ── buildCaddyfile() ─────────────────────────────────────────────────────────
// Rebuilds the Caddyfile from current cfg and user list.
//
// Bug 23 (P0): the old code emitted a bare "basic_auth" keyword with no
//   arguments (invalid in caddy-forwardproxy-naive → parse error) and used
//   the wrong spelling "basicauth" for per-user lines.  Both are now fixed
//   by delegating to caddyTemplate.js which is the single source of truth.
//
// Bug 26 (P1): delegate to caddyTemplate.js so install.sh, update.sh, and
//   this file all produce byte-for-byte identical Caddyfiles.
//
// Bug 28 (P1): removed redundant "tls <email>" inside the site block —
//   Caddy's automatic HTTPS handles TLS; the global email directive is enough.
//
// Bug 29 (P1): directive order inside forward_proxy is now enforced by the
//   template: basic_auth lines → hide_ip → hide_via → probe_resistance.
//
// Bug 30 (P1): "order forward_proxy first" now appears in the
//   global block via the template.
//
// Bug 34: placeholder emitted when naiveUsers is empty so the forward_proxy
//   block always has at least one credential (prevents unauthenticated access
//   and Caddy validation failure).
//
// Bug 38 (P2): log rotation uses roll_keep_for 720h (30 days) not roll_keep 5.
//
// Bug 21: no site-level log block — global block covers all traffic.
// ── normalizeUpstream() — Bug 92 ─────────────────────────────────────────────
// Caddy's forward_proxy `upstream` directive only accepts a clean https:// URL.
// Users paste the subscription-format key as-is (e.g. "naive+https://u:p@h:443"),
// which makes caddy validate fail with:
//   "forward_proxy: insecure schemes are only allowed to localhost upstreams".
// Strip a leading "naive+" (and any other "<scheme>+" wrapper) so we end up with
// a bare https:// URL. If the input has no scheme at all, assume https://.
function normalizeUpstream(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Drop a leading "xxx+" wrapper such as "naive+https://..." → "https://..."
  s = s.replace(/^[a-z][a-z0-9.+-]*\+(?=https?:\/\/)/i, '');
  // If a non-https scheme slipped through (e.g. "http://"), upgrade to https.
  s = s.replace(/^http:\/\//i, 'https://');
  // No scheme at all → assume https.
  if (!/^https:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function buildCaddyfile(config, users) {
  // Filter to naive-protocol users only
  // Bug 44: skip users without a plaintext password — caddy-forwardproxy-naive
  //         hashes the password internally; we cannot feed it a bcrypt hash.
  //         Log a warning so operators know which users are missing.
  const naiveUsers = users.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('naive'); }
    catch { return true; }
  }).map(u => {
    const pass = (u.password || '').trim();
    if (!pass) {
      console.warn(`[CADDY] Bug 44: user '${u.username}' has no plaintext password — skipped from Caddyfile`);
      return null;
    }
    return { username: u.username, password: pass };
  }).filter(Boolean);

  // Read probe secret from config or from the file written by install.sh
  const probeSecret = (config.probeSecret || '').trim() ||
    (fs.existsSync(path.join(resolvedCaddyCfgDir, 'probe_secret'))
      ? fs.readFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), 'utf8').trim()
      : '');

  // Bug 81: probe_resistance mode ('off' | 'bare' | 'secret').
  // Back-compat: derive from probeSecret when unset.
  let probeMode = (config.probeMode || '').trim().toLowerCase();
  if (!probeMode) probeMode = probeSecret ? 'secret' : 'bare';

  // Bug 26: delegate to the shared template module (single source of truth).
  // Falls back to an inline render if the template file is not yet deployed.
  const tplPath = path.join(__dirname, 'caddyTemplate.js');
  if (fs.existsSync(tplPath)) {
    const tpl = require(tplPath);
    return tpl.render({
      adminEmail:  config.adminEmail  || '',
      domain:      config.domain      || 'localhost',
      naivePort:   config.naivePort   || 443,
      fakeSiteDir: resolvedFakeSiteDir,
      // Bug 98: pass fakeSiteUrl so the template can reverse_proxy a real site.
      fakeSiteUrl: config.fakeSiteUrl || '',
      probeSecret,
      probeMode,
      logFile:     LOG_CADDY,
      // Bug 92: normalize (strip "naive+" etc.) before it reaches the template.
      upstream:    (config.cascadeEnabled && config.cascadeNaiveUpstream) ? normalizeUpstream(config.cascadeNaiveUpstream) : '',
      // v1.4.0: panel external-access subdomain block (TLS + basic_auth + webBasePath).
      exposePanel:        !!config.exposePanel,
      panelDomain:        config.panelDomain        || '',
      panelBasicAuthUser: config.panelBasicAuthUser || '',
      panelBasicAuthHash: config.panelBasicAuthHash || '',
      webBasePath:        config.webBasePath        || '',
      panelStubPage:      config.panelStubPage      || '/var/www/panel-stub/index.html',
      panelPort:          config.panelPort          || 3000,
      // v1.8.7: subscription sub-domain (public /sub/* → panel; TLS auto).
      subBaseUrl:         config.subBaseUrl          || '',
    }, naiveUsers);
  }

  // ── Inline fallback (identical rules to caddyTemplate.js) ─────────────────
  // Used only when caddyTemplate.js is not yet on disk (e.g. very first boot
  // before install_panel() has run).  Kept in sync with the template manually.
  // (crypto is required at module level — Bug 100)
  let authLines;
  if (naiveUsers.length > 0) {
    // Bug 23: each credential line is "basic_auth <user> <pass>" — no bare keyword
    authLines = naiveUsers
      .map(u => `    basic_auth ${u.username} ${u.password}`)
      .join('\n');
  } else {
    // Bug 34: unreachable placeholder keeps the block non-empty
    const rnd = crypto.randomBytes(20).toString('hex');
    authLines = `    basic_auth _placeholder_${rnd.slice(0, 16)} _disabled_${rnd.slice(16)}`;
  }

  // Bug 29 + Bug 81: probe_resistance comes after hide_ip + hide_via.
  // 'off' → none; 'secret' → with token; 'bare' → keyword only.
  let probeLine;
  if (probeMode === 'off') {
    probeLine = '';
  } else if (probeMode === 'secret' && probeSecret) {
    probeLine = `\n    probe_resistance ${probeSecret}`;
  } else {
    probeLine = `\n    probe_resistance`;
  }

  // v1.2.6: cascade — upstream proxy support (inline fallback)
  // Bug 92: normalize the upstream so forward_proxy gets a clean https:// URL.
  const upstreamUrl = (config.cascadeEnabled && config.cascadeNaiveUpstream) ? normalizeUpstream(config.cascadeNaiveUpstream) : '';
  const upstreamLine = upstreamUrl ? `\n    upstream ${upstreamUrl}` : '';

  // Bug 98: masquerade — file_server (default) or reverse_proxy (real site).
  let masqueradeBlock;
  {
    const fu = String(config.fakeSiteUrl || '').trim();
    const isPlaceholder = /^https?:\/\/(www\.)?example\.com\/?$/i.test(fu);
    const m = (!isPlaceholder && fu) ? fu.match(/^(https?):\/\/([^\/\s]+)/i) : null;
    if (m) {
      const scheme = m[1].toLowerCase(), host = m[2];
      masqueradeBlock = scheme === 'https'
        ? `  reverse_proxy https://${host} {\n    header_up Host ${host}\n    transport http {\n      tls\n      tls_server_name ${host}\n    }\n  }`
        : `  reverse_proxy http://${host} {\n    header_up Host ${host}\n  }`;
    } else {
      masqueradeBlock = `  file_server {\n    root ${resolvedFakeSiteDir}\n  }`;
    }
  }

  // v1.4.0: panel external-access subdomain block (inline fallback — mirrors
  // caddyTemplate.renderPanelBlock). Emitted only when external access is on.
  let panelBlock = '';
  {
    const expose      = !!config.exposePanel;
    const panelDomain = String(config.panelDomain || '').trim();
    const baUser      = String(config.panelBasicAuthUser || '').trim();
    // BUG-155: NEVER emit a polluted/multi-line hash. Sieve config.panelBasicAuthHash
    // down to a single valid bcrypt token; if it isn't one, drop it (no basic_auth
    // line) rather than write a broken Caddyfile that fails-loops caddy-naive.
    const rawHash     = String(config.panelBasicAuthHash || '');
    const baHash      = BCRYPT_RE.test(rawHash) ? extractBcrypt(rawHash) : '';
    const stubFile    = String(config.panelStubPage || '/var/www/panel-stub/index.html').trim();
    let   webBasePath = String(config.webBasePath || '').trim().replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._~-]/g, '');
    const panelPort   = parseInt(config.panelPort, 10) || 3000;
    if (expose && panelDomain && webBasePath) {
      const stubDir = stubFile.replace(/\/[^/]*$/, '') || '/var/www/panel-stub';
      let ba = '';
      if (baUser && baHash) ba = `    basic_auth {\n      ${baUser} ${baHash}\n    }\n`;
      panelBlock =
`\n\n# ── v1.4.0: panel external access (TLS + basic_auth + webBasePath) ────────────\n${panelDomain} {\n  tls ${config.adminEmail || ''}\n\n  # BUG-140: normalize bare base path to trailing slash (relative-asset resolve)\n  redir /${webBasePath} /${webBasePath}/ 301\n\n  handle_path /${webBasePath}/* {\n${ba}    reverse_proxy 127.0.0.1:${panelPort}\n  }\n\n  # Root and any path outside the secret base path → static stub (not a redirect)\n  handle {\n    root * ${stubDir}\n    file_server\n  }\n}\n`;
    }
  }

  // v1.8.7: subscription sub-domain block (inline fallback — mirrors
  // caddyTemplate.renderSubBlock). Emitted only when subBaseUrl is configured.
  let subBlock = '';
  {
    const subRaw  = String(config.subBaseUrl || '').trim();
    const subHost = subRaw ? subRaw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim() : '';
    if (subHost) {
      const panelPort = parseInt(config.panelPort, 10) || 3000;
      subBlock =
`\n\n# ── v1.8.7: subscription domain (public /sub/* → panel; TLS auto) ─────────────\n${subHost} {\n  tls ${config.adminEmail || ''}\n  handle /sub/* {\n    reverse_proxy 127.0.0.1:${panelPort}\n  }\n  handle {\n    respond "Not found" 404\n  }\n}\n`;
    }
  }

  // Bug 28: no "tls <email>" inside site block
  // Bug 30: order directive in global block
  // Bug 38: roll_keep_for 720h
  return `{
  # Bug 30 / Bug 102 (CRITICAL): forward_proxy before ANY handler (file_server
  # OR reverse_proxy). "before file_server" let mirror-mode reverse_proxy hijack
  # authenticated CONNECT → all naive keys broke. "first" fixes both modes.
  order forward_proxy first
  # Bug 80: HTTP/1.1 + HTTP/2 only (disable HTTP/3 / QUIC)
  servers {
    protocols h1 h2
  }
  email ${config.adminEmail || ''}
  admin off
  log {
    # Bug 38: 30-day retention by age
    output file ${LOG_CADDY} {
      roll_size     50mb
      roll_keep_for 720h
    }
    format json
  }
}

# HTTP → HTTPS redirect (also needed for ACME HTTP-01 fallback)
:80 {
  redir https://{host}{uri} permanent
}

:${config.naivePort || 443}, ${config.domain || 'localhost'} {
  # Bug 83: match the known-good reference server exactly (":<port>, <domain>"
  # listener + explicit tls + no route{} wrapper).
  tls ${config.adminEmail || ''}

  forward_proxy {
    # Bug 23: no bare "basic_auth" token; each line IS the credential directive
    # Bug 29: order — credentials → hide_ip → hide_via → probe_resistance
${authLines}
    hide_ip
    hide_via${probeLine}${upstreamLine}
  }

${masqueradeBlock}
}
${panelBlock}${subBlock}`;
}

// ── writeCaddyfileAtomic() ────────────────────────────────────────────────────
// Bug 90: caddy-naive.service runs as User=caddy/Group=caddy. If the Caddyfile
// (and its parent dir) are root:root 640, the caddy user cannot read it and the
// service crash-loops with "permission denied" → "Start request repeated too
// quickly". Every write MUST leave the file as root:caddy 640 and the config dir
// as root:caddy 750 (the group needs the dir's execute/traverse bit to open the
// file inside it). chown is best-effort: it only works when the panel runs as
// root, which it does in production.
function fixCaddyPerms() {
  try {
    // Dir: root:caddy 750 so the caddy group can traverse + list.
    execSync(`chown root:caddy '${resolvedCaddyCfgDir}' 2>/dev/null || true`, { timeout: 5000 });
    execSync(`chmod 750 '${resolvedCaddyCfgDir}' 2>/dev/null || true`, { timeout: 5000 });
    // Caddyfile: root:caddy 640 so the caddy group can read it.
    if (fs.existsSync(resolvedCaddyFile)) {
      execSync(`chown root:caddy '${resolvedCaddyFile}' 2>/dev/null || true`, { timeout: 5000 });
      execSync(`chmod 640 '${resolvedCaddyFile}' 2>/dev/null || true`, { timeout: 5000 });
    }
    // probe_secret: root:caddy 640 so caddy can read it for probe_resistance.
    const probeFile = path.join(resolvedCaddyCfgDir, 'probe_secret');
    if (fs.existsSync(probeFile)) {
      execSync(`chown root:caddy '${probeFile}' 2>/dev/null || true`, { timeout: 5000 });
      execSync(`chmod 640 '${probeFile}' 2>/dev/null || true`, { timeout: 5000 });
    }
  } catch (e) {
    console.warn('[CADDY] fixCaddyPerms (non-fatal):', e.message);
  }
}

function writeCaddyfileAtomic(content) {
  fs.mkdirSync(resolvedCaddyCfgDir, { recursive: true });
  const tmp = resolvedCaddyFile + '.new';
  fs.writeFileSync(tmp, content, { mode: 0o640 });
  fs.renameSync(tmp, resolvedCaddyFile);   // atomic replace
  // Bug 90: hand ownership to root:caddy so the service can read it.
  fixCaddyPerms();
}

// Bug 91: last caddy apply error, surfaced to the UI when an apply fails.
let lastCaddyError = '';
function getLastCaddyError() { return lastCaddyError; }

// BUG-156: last mita apply/validate error, surfaced to the UI so a rejected
// config (e.g. a bad trafficPattern) is visible instead of a silent IDLE mita.
let lastMitaError = '';
function getLastMitaError() { return lastMitaError; }

// ── applyCaddyConfig() — Bug 91 ──────────────────────────────────────────────
// Previously the panel applied config via `systemctl reload` (kill -USR1). A
// graceful reload SILENTLY KEEPS the old in-memory config when the new config
// cannot be read (e.g. Bug 90 permission error): `validate` says Valid, status
// is active, logs say "Reloaded", a direct curl works — yet the running process
// never loaded the new upstream, so the client exits from the Entry node and the
// cascade is effectively NOT applied. The failure only surfaced on a full
// restart. Therefore we now ALWAYS do a full `systemctl restart` and then verify
// `systemctl is-active`; on failure we capture the real journal error so the UI
// can show it instead of a misleading "success".
// BUG-155: validate the Caddyfile on disk BEFORE we ever (re)start caddy-naive.
// A previous build could restart with a broken config (e.g. a polluted
// panelBasicAuthHash) and drop caddy-naive into a "repeated too quickly" loop.
// Validation up-front means a bad config is rejected without a restart, so the
// caller can roll back while the running service stays up.
function validateCaddyfile() {
  try {
    execSync(`${resolvedCaddyBin} validate --config '${resolvedCaddyFile}' --adapter caddyfile 2>&1`,
      { timeout: 15000 });
    return { ok: true, error: '' };
  } catch (e) {
    const out = ((e.stdout && e.stdout.toString()) || (e.stderr && e.stderr.toString()) || e.message || '').trim();
    return { ok: false, error: out.split('\n').slice(-4).join('\n').trim() };
  }
}

function applyCaddyConfig() {
  lastCaddyError = '';
  // BUG-155: never restart on an invalid config — validate first.
  const v = validateCaddyfile();
  if (!v.ok) {
    lastCaddyError = 'Caddyfile validation failed (not restarting): ' + v.error;
    return { ok: false, error: lastCaddyError };
  }
  try {
    // Clear any prior failure storm so the restart isn't blocked by
    // "Start request repeated too quickly".
    try { execSync('systemctl reset-failed caddy-naive 2>/dev/null || true', { timeout: 5000 }); } catch {}
    execSync('systemctl restart caddy-naive', { timeout: 20000 });
  } catch (e) {
    lastCaddyError = collectCaddyError(e);
    return { ok: false, error: lastCaddyError };
  }
  // Verify the service actually came up and stayed up.
  let active = '';
  try { active = execSync('systemctl is-active caddy-naive 2>/dev/null', { timeout: 5000 }).toString().trim(); }
  catch (e) { active = (e.stdout ? e.stdout.toString().trim() : '') || 'inactive'; }
  if (active !== 'active') {
    lastCaddyError = collectCaddyError(null) || `caddy-naive is ${active || 'inactive'}`;
    return { ok: false, error: lastCaddyError };
  }
  return { ok: true, error: '' };
}

// Pull the real reason a (re)start failed: prefer the most recent journal lines,
// fall back to the exception's stderr/stdout.
function collectCaddyError(err) {
  let msg = '';
  try {
    const j = execSync('journalctl -u caddy-naive -n 20 --no-pager 2>/dev/null', { timeout: 5000 }).toString();
    // Surface the lines that actually explain the failure.
    const hot = j.split('\n').filter(l =>
      /permission denied|error|insecure schemes|repeated too quickly|invalid|adapt|loading/i.test(l));
    msg = (hot.length ? hot.slice(-6) : j.trim().split('\n').slice(-6)).join('\n').trim();
  } catch {}
  if (!msg && err) {
    msg = ((err.stderr && err.stderr.toString()) || (err.stdout && err.stdout.toString()) || err.message || '').trim();
  }
  return msg;
}

// ── reloadCaddy() — Bug 91: now a FULL restart + verify (no more silent reload).
// Kept as a thin boolean wrapper so existing callers don't change behaviour.
function reloadCaddy() {
  const r = applyCaddyConfig();
  return r.ok;
}

// ── restartCaddy() — full restart (needed for port/domain changes) ───────────
function restartCaddy() {
  return applyCaddyConfig().ok;
}

// ── Bug 7: UFW single-port helper ────────────────────────────────────────────
function ufwMieruRule(action, start, end, proto, comment) {
  const commentPart = comment ? ` comment "${comment}"` : '';
  const cmd = (start === end)
    ? `ufw ${action} allow ${start}/${proto}${commentPart} 2>/dev/null || true`
    : `ufw ${action} allow ${start}:${end}/${proto}${commentPart} 2>/dev/null || true`;
  try { execSync(cmd, { timeout: 5000 }); } catch {}
}

// ── Mieru state JSON builder ──────────────────────────────────────────────────
// Bug 51: use safe defaults for mieruPortStart/End in case config values absent
// Bug 151 / Доработка 2: count the mieru-protocol users in the DB. mita FATALs
// with "no user found" and enters a restart loop if it is started while this is
// 0, so callers use it to keep mita idle on an empty base instead of crashing.
function countMieruUsers() {
  return getAllUsers().filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('mieru'); }
    catch { return true; }
  }).length;
}

// BUG-156: build a proto-correct mita `trafficPattern` object for a UI preset.
// `seed` MUST be an int32 (not a boolean). We keep a STABLE per-install seed in
// cfg.trafficPatternSeed so regenerating the config (key add/delete, toggling
// obfuscation off and on) does not churn the implicit pattern. Returns null for
// NOOP / unknown presets (caller then omits trafficPattern entirely).
function getStableTrafficSeed() {
  let s = parseInt(cfg.trafficPatternSeed, 10);
  if (!Number.isInteger(s) || s <= 0 || s > 0x7fffffff) {
    // 31-bit positive int → always a valid proto int32.
    s = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff) || 1;
    cfg.trafficPatternSeed = s;
    try { saveConfig(); } catch {}
  }
  return s;
}

function buildTrafficPattern(pat, _cfg) {
  const seed = getStableTrafficSeed();
  switch (pat) {
    case 'RANDOM_PADDING':
      // Conservative: stable seed + limited implicit options, no TCP fragmenting.
      return {
        seed,
        unlockAll: false,
        tcpFragment: { enable: false, maxSleepMs: 0 },
        nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: false, minLen: 4, maxLen: 8 }
      };
    case 'RANDOM_PADDING_AGGRESSIVE':
      // Aggressive: unlock all implicit options + TCP fragmentation + nonce on all UDP.
      return {
        seed,
        unlockAll: true,
        tcpFragment: { enable: true, maxSleepMs: 10 },
        nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: true, minLen: 6, maxLen: 12 }
      };
    case 'CUSTOM':
      // Honour an operator-supplied object verbatim, but coerce seed to int32.
      if (_cfg && _cfg.trafficPatternCustom && typeof _cfg.trafficPatternCustom === 'object') {
        const c = { ..._cfg.trafficPatternCustom };
        c.seed = Number.isInteger(parseInt(c.seed, 10)) ? parseInt(c.seed, 10) : seed;
        return c;
      }
      return { seed, unlockAll: true };
    default:
      return null;
  }
}

function buildMitaStateFile() {
  const allUsers = getAllUsers();
  const mieruUsers = allUsers.filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('mieru'); }
    catch { return true; }
  });

  // Bug 51: parseInt guards against undefined/NaN causing infinite loops
  const portStart = parseInt(cfg.mieruPortStart, 10) || 2000;
  const portEnd   = parseInt(cfg.mieruPortEnd,   10) || 2010;

  // TCP-only by default; UDP is opt-in via cfg.udpEnabled
  const portBindings = [];
  for (let p = portStart; p <= portEnd; p++) {
    portBindings.push({ port: p, protocol: 'TCP' });
    if (cfg.udpEnabled) portBindings.push({ port: p, protocol: 'UDP' });
  }

  const mieruCfg = {
    portBindings,
    users: mieruUsers.map(u => ({
      name:     u.username,
      password: u.password || ''   // plain string — mita hashes on apply
    })),
    loggingLevel: 'INFO',
    mtu: cfg.mtu || 1400
  };

  // BUG-156 (HIGH): the previous patMap wrote `seed: true` (a boolean) into the
  // mita trafficPattern. In the mita proto `seed` is an INT32 (it seeds stable
  // implicit pattern generation), and `tcpFragment` / `nonce` are OBJECTS, not
  // booleans. `mita apply config` rejected the boolean with
  //   proto: invalid value for int32 type: true  → server config empty → IDLE,
  // so the Mieru port never opened. We now emit the proto-correct schema
  // (see https://github.com/enfein/mieru/blob/main/docs/traffic-pattern.md):
  //   • seed        → int32  (the on/off toggle is `unlockAll`, a bool)
  //   • unlockAll   → bool   (false = conservative, true = aggressive)
  //   • tcpFragment → { enable: bool, maxSleepMs: int }
  //   • nonce       → { type: enum-string, applyToAllUDPPacket: bool, minLen, maxLen }
  const pat = cfg.trafficPattern || 'NOOP';
  if (pat !== 'NOOP') {
    const tp = buildTrafficPattern(pat, cfg);
    if (tp) mieruCfg.trafficPattern = tp;
  }

  // v1.2.6 cascade (Mieru): Variant B is used instead of mita native egress.
  // The entry mita stays a plain server; the RU->EU relay is handled externally
  // by scripts/cascade_mieru.sh (mieru-client + redsocks + iptables). We
  // therefore intentionally do NOT inject `mieruCfg.egress` here.
  // Legacy Variant A native egress is only applied if an operator explicitly
  // sets cascadeMieruEgress.proxies AND no Variant B host is configured.
  if (cfg.cascadeEnabled
      && (!cfg.cascadeMieru || !cfg.cascadeMieru.host)
      && cfg.cascadeMieruEgress && Array.isArray(cfg.cascadeMieruEgress.proxies)
      && cfg.cascadeMieruEgress.proxies.length > 0) {
    mieruCfg.egress = {
      proxies: cfg.cascadeMieruEgress.proxies,
      rules: cfg.cascadeMieruEgress.rules || [{ ipRanges: ['*'], domainNames: ['*'], action: 'DIRECT' }]
    };
  }

  fs.mkdirSync(path.dirname(resolvedMitaFile), { recursive: true });
  const tmp = resolvedMitaFile + '.new';
  fs.writeFileSync(tmp, JSON.stringify(mieruCfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, resolvedMitaFile);

  shredFile(resolvedMitaFile + '.last');
  try { fs.copyFileSync(resolvedMitaFile, resolvedMitaFile + '.last'); } catch {}

  return resolvedMitaFile;
}

// Bug 96: clear systemd "failed" state for mita before any (re)start.
//   After the FIRST user is added, or after a manual `systemctl restart mita`
//   that hit Restart=on-failure exhaustion, the unit can be stuck in
//   `failed` / `auto-restart`. In that state `systemctl start/restart` is a
//   no-op or refuses to act, leaving the proxy down with "no user found" /
//   mita=failed. `reset-failed` clears the failure counter so the next
//   start actually takes effect.
function resetMitaFailed() {
  try { execSync('systemctl reset-failed mita 2>/dev/null || true', { timeout: 5000 }); } catch {}
}

// BUG-156: validate mita-state.json BEFORE we apply it, so a malformed config
// (e.g. the old `seed: true` int32 violation) never reaches mita and drops it
// into IDLE with an empty server config. Two layers:
//   1) structural JSON-vs-proto-type check (fast, no mita needed);
//   2) `mita apply config` is the real validator at apply time — but we capture
//      its stderr so the caller can surface "invalid value for int32" etc.
// Returns { ok, error }.
function validateMitaState(file) {
  // Layer 1: structural type check of the fields mita is strict about.
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tp = obj.trafficPattern;
    if (tp && typeof tp === 'object') {
      if ('seed' in tp && !Number.isInteger(tp.seed))
        return { ok: false, error: `trafficPattern.seed must be an int32, got ${JSON.stringify(tp.seed)}` };
      if ('unlockAll' in tp && typeof tp.unlockAll !== 'boolean')
        return { ok: false, error: 'trafficPattern.unlockAll must be a boolean' };
      if ('tcpFragment' in tp) {
        const f = tp.tcpFragment;
        if (typeof f !== 'object' || f === null)
          return { ok: false, error: 'trafficPattern.tcpFragment must be an object { enable, maxSleepMs }' };
        if ('enable' in f && typeof f.enable !== 'boolean')
          return { ok: false, error: 'trafficPattern.tcpFragment.enable must be a boolean' };
        if ('maxSleepMs' in f && !Number.isInteger(f.maxSleepMs))
          return { ok: false, error: 'trafficPattern.tcpFragment.maxSleepMs must be an int' };
      }
      if ('nonce' in tp && (typeof tp.nonce !== 'object' || tp.nonce === null))
        return { ok: false, error: 'trafficPattern.nonce must be an object' };
    }
    if (Array.isArray(obj.portBindings) && obj.portBindings.some(b => !Number.isInteger(b.port) && !b.portRange))
      return { ok: false, error: 'portBindings entries need an int `port` or a `portRange` string' };
  } catch (e) {
    return { ok: false, error: 'mita-state.json is not valid JSON: ' + e.message };
  }
  return { ok: true, error: '' };
}

// Bug 96: the mieru server persists its applied state to
//   ~/.config/mita/server.conf.pb (root's HOME, since mita.service runs as
//   root). A stale/corrupt server.conf.pb can make a freshly-(re)started mita
//   come up in a broken "no user found" state even though mita-state.json is
//   correct. `mita apply config` rebuilds it, so removing the stale copy
//   before a cold start forces a clean rebuild. We only do this on a COLD
//   start path (not on a live reload) to avoid disturbing a healthy server.
function clearMitaPersistedState() {
  for (const p of ['/root/.config/mita/server.conf.pb',
                   process.env.HOME ? path.join(process.env.HOME, '.config/mita/server.conf.pb') : null]) {
    if (!p) continue;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

function applyMitaConfig() {
  lastMitaError = '';
  const file = buildMitaStateFile();
  // BUG-156: structurally validate the config before doing anything with mita.
  // A bad trafficPattern (e.g. seed as a boolean) used to be applied blindly,
  // mita rejected it, the server config went empty and mita stayed IDLE with
  // the Mieru port closed. We now refuse early and record the reason.
  const v = validateMitaState(file);
  if (!v.ok) {
    lastMitaError = 'mita-state.json invalid (not applying): ' + v.error;
    return false;
  }
  try {
    // Bug 96: always clear a lingering failed state first so subsequent
    //   start/restart commands are honoured by systemd.
    resetMitaFailed();

    // Bug 151 / Доработка 2 (foolproofing): if there are NO mieru users yet,
    // do NOT start mita. Starting it with an empty users[] makes it FATAL with
    // "no user found" and spin in a restart loop. Apply the (userless) config so
    // the file is in sync, then keep the service stopped+reset until the first
    // key is created (creating a user calls applyAllConfigs() → here again).
    if (countMieruUsers() === 0) {
      try { execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 15000 }); } catch {}
      try { execSync('mita stop 2>/dev/null || true', { timeout: 10000 }); } catch {}
      try { execSync('systemctl stop mita 2>/dev/null || true', { timeout: 10000 }); } catch {}
      resetMitaFailed();
      shredFile(file + '.last');
      return true;   // idle is the correct, healthy state on an empty base
    }

    // BUG-156: capture apply stderr so a proto rejection surfaces instead of
    // being silently swallowed by `2>/dev/null`.
    try {
      execSync(`mita apply config ${file}`, { timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      lastMitaError = 'mita apply config failed: ' +
        (((e.stderr && e.stderr.toString()) || e.message || '').trim().split('\n').slice(-3).join(' '));
      return false;
    }

    // Bug 75: a fresh mita install sits in state IDLE (the installer does NOT
    // start it while users[] is empty — Bug 4). `mita reload` only re-reads the
    // config of an already-RUNNING server; it will NOT lift IDLE -> RUNNING, so
    // the proxy never starts listening and mieru clients can't connect.
    // Therefore: detect status and `mita start` when IDLE, otherwise `reload`.
    let status = '';
    try { status = execSync('mita status 2>/dev/null', { timeout: 10000 }).toString(); }
    catch { status = ''; }

    if (/RUNNING/i.test(status)) {
      execSync('mita reload 2>/dev/null', { timeout: 15000 });
    } else {
      // IDLE / FAILED / unknown: start the service so it binds the configured
      // ports. Bug 96: clear stale persisted state then re-apply so the cold
      // start rebuilds server.conf.pb cleanly; reset-failed again right before
      // the systemctl fallback so it is not blocked by an exhausted restart
      // counter, and verify is-active afterwards.
      clearMitaPersistedState();
      try { execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 15000 }); } catch {}
      let started = false;
      try { execSync('mita start 2>/dev/null', { timeout: 15000 }); started = true; }
      catch { started = false; }
      if (!started) {
        resetMitaFailed();
        try { execSync('systemctl restart mita 2>/dev/null || true', { timeout: 15000 }); } catch {}
      }
      // Verify; if still not active, force one clean restart via systemd.
      let active = '';
      try { active = execSync('systemctl is-active mita 2>/dev/null', { timeout: 5000 }).toString().trim(); }
      catch { active = ''; }
      if (active !== 'active') {
        resetMitaFailed();
        try { execSync('systemctl restart mita 2>/dev/null || true', { timeout: 15000 }); } catch {}
      }
    }

    shredFile(file + '.last');

    // BUG-156: with mieru users present, mita must end up RUNNING (not IDLE) —
    // an IDLE here means the config was rejected and the Mieru port stays shut.
    // Give it a moment, then verify; record the reason if it didn't come up.
    let finalStatus = '';
    try { finalStatus = execSync('mita status 2>/dev/null', { timeout: 10000 }).toString(); }
    catch { finalStatus = ''; }
    if (/RUNNING/i.test(finalStatus)) {
      lastMitaError = '';
      return true;
    }
    // Not RUNNING despite users — surface a diagnostic but don't hard-fail the
    // whole apply (the caller may still have applied Caddy etc.).
    lastMitaError = 'mita is not RUNNING after apply (status: ' +
      (finalStatus.trim().split('\n')[0] || 'unknown') + '). Check: journalctl -u mita -n 50';
    return true;
  } catch (e) {
    lastMitaError = 'applyMitaConfig error: ' + (e.message || String(e));
    return false;
  }
}

function restartMieru() {
  try {
    execSync('mita stop 2>/dev/null || true', { timeout: 10000 });
    // Bug 96: clear failed state + stale persisted config so the cold restart
    //   below comes up clean instead of getting stuck in "no user found".
    resetMitaFailed();
    clearMitaPersistedState();
    const file = buildMitaStateFile();
    execSync(`mita apply config ${file} 2>/dev/null`, { timeout: 10000 });
    try { execSync('mita start 2>/dev/null', { timeout: 15000 }); }
    catch {
      resetMitaFailed();
      execSync('systemctl restart mita 2>/dev/null || systemctl start mita 2>/dev/null || true', { timeout: 15000 });
    }
    shredFile(file + '.last');
    return true;
  } catch { return false; }
}

// ── Mieru cascade (Variant B) — scripts/cascade_mieru.sh orchestrator ─────────
const CASCADE_SCRIPT = path.join(__dirname, '../scripts/cascade_mieru.sh');

// Run cascade_mieru.sh {setup|teardown|status}. Returns { ok, output }.
// Uses execFileSync (no shell) so the exit credentials are passed as argv and
// never interpolated into a shell string.
function runCascadeMieru(action, opts = {}) {
  try {
    const args = [CASCADE_SCRIPT, action];
    if (action === 'setup') {
      args.push(
        '--exit-host',       String(opts.host || ''),
        '--exit-port-start', String(opts.portStart || ''),
        '--exit-port-end',   String(opts.portEnd || ''),
        '--exit-user',       String(opts.user || ''),
        '--exit-pass',       String(opts.pass || ''),
        // Bug 95: mtu MUST match the exit (mita) mtu. Operators normally keep the
        // panel default (1400) on both nodes; allow an override via cascadeMieru.mtu.
        '--exit-mtu',        String(opts.mtu || cfg.mtu || 1400),
        '--exit-mux',        String(opts.mux || 'MULTIPLEXING_LOW')
      );
    }
    const out = execFileSync('bash', args, { timeout: 120000 }).toString();
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : e.message) };
  }
}

// ── Cloudflare WARP egress — scripts/warp_egress.sh orchestrator ─────────────
// WARP routes ALL of the server's OUTBOUND traffic through Cloudflare so the
// real server IP is hidden. It is a server-wide mode and MUTUALLY EXCLUSIVE with
// the Mieru cascade (the API guarantees only one egress mode is ever active).
const WARP_SCRIPT = path.join(__dirname, '../scripts/warp_egress.sh');

// Detect the active SSH port (sshd_config Port, then listening sockets, then 22).
// BUG-162: passed to warp_egress.sh so the SSH control channel is NEVER tunnelled.
function detectSshPort() {
  try {
    const cfgTxt = fs.readFileSync('/etc/ssh/sshd_config', 'utf8');
    const m = cfgTxt.match(/^\s*Port\s+(\d+)/m);
    if (m) return m[1];
  } catch {}
  try {
    const ss = execSync("ss -tlnp 2>/dev/null | awk '/sshd/{n=split($4,a,\":\"); print a[n]}' | head -1", { timeout: 4000 })
      .toString().trim();
    if (ss) return ss;
  } catch {}
  return '22';
}

// Run warp_egress.sh {setup|teardown|status|egress-ip}. Returns { ok, output }.
// BUG-162: inject management-plane env so the script can keep SSH + panel on the
//   native route, and only enable boot-persistence when explicitly confirmed.
function runWarpEgress(action, opts = {}) {
  try {
    const env = Object.assign({}, process.env, {
      WARP_SSH_PORT:   String(opts.sshPort   || detectSshPort()),
      WARP_PANEL_PORT: String(opts.panelPort || cfg.panelPort || 3000),
      // BUG-173: the Hysteria2 (QUIC/UDP) service port. The WARP return-path UDP
      //   rules are scoped to THIS port so they never collide with WireGuard's
      //   own UDP envelope. Falls back to the Hy2 default (443) when Hy2 is off.
      WARP_HY2_PORT:   String(opts.hy2Port   || cfg.hy2Port || 443),
      WARP_PERSIST:    opts.persist ? '1' : '0',
    });
    const out = execFileSync('bash', [WARP_SCRIPT, action], { timeout: 180000, env }).toString();
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : e.message) };
  }
}

// BUG-168: classify the WARP setup outcome from the script's structured
//   `WARP_RESULT=…` line, so the panel can show a FRIENDLY explanation instead
//   of a raw technical error. The auto-rollback already kept the server safe;
//   the operator just needs to know WHY and what to do.
//   Codes:
//     ok             → tunnel verified, egress is the Cloudflare IP (green)
//     blocked_return → handshake OK but no return data on any port → the HOSTING
//                      PROVIDER blocks Cloudflare WARP return traffic (yellow,
//                      NOT a panel error). Suggest: change host or use cascade.
//     no_handshake   → no handshake on any port → provider likely blocks UDP.
//     unknown        → couldn't classify (fall back to the raw output).
function parseWarpResult(output) {
  const text = String(output || '');
  const line = (text.split('\n').reverse().find(l => /^WARP_RESULT=/.test(l.trim())) || '').trim();
  const out = { code: 'unknown', egressIP: null, rx: null, tx: null, raw: text };
  if (!line) return out;
  const get = (k) => { const m = line.match(new RegExp(k + '=([^\\s]+)')); return m ? m[1] : null; };
  out.code = get('WARP_RESULT') || 'unknown';
  out.egressIP = get('egressIP');
  const rx = get('rx'), tx = get('tx');
  if (rx != null) out.rx = parseInt(rx, 10);
  if (tx != null) out.tx = parseInt(tx, 10);
  return out;
}

// Total RAM in MiB (for the low-RAM warning around the extra WARP network layer).
// Read /proc/meminfo to avoid pulling in the `os` module.
function totalRamMB() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s*(\d+)\s*kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : 0;
  } catch { return 0; }
}

function shredFile(fp) {
  if (!fp || !fs.existsSync(fp)) return;
  try { execSync(`shred -u "${fp}" 2>/dev/null`, { timeout: 5000 }); }
  catch { try { fs.unlinkSync(fp); } catch {} }
}

// ── Hysteria2 (Hy2) config management ─────────────────────────────────────────
// Hy2 users live in the SHARED SQLite `users` pool: a user has Hy2 access iff
// its `protocols` array contains "hy2". The Hy2 server auths against an
// `auth.userpass` map in /etc/hysteria/config.yaml. This module is the single
// owner of that map — it rewrites ONLY the `auth:` block from the DB, preserving
// every other section (listen / tls / masquerade / quic) byte-for-byte.
//
// We deliberately do NOT pull in a YAML library: our usernames match
// /^[a-zA-Z0-9_.-]{1,64}$/ and passwords are the safe alphabet [a-zA-Z0-9]
// (generateSafePassword) or admin-supplied (min 8 chars). We still quote every
// value so an admin-supplied password with YAML-special chars can't break the
// document. Rewriting is a targeted string splice, not a full parse/serialize,
// so unrelated formatting/comments are untouched.
const HY2_CONFIG = '/etc/hysteria/config.yaml';

// The panel runs as root; hysteria-server runs as the dedicated `hysteria`
// system user (cascade owner-match, since v1.8.4). fs.writeFileSync therefore
// creates config files owned root:root, which the service user then cannot
// read → "open /etc/hysteria/config.yaml: permission denied" FATAL. After ANY
// write to a Hy2 config file we MUST hand ownership back to the service user
// (and its dir) so hysteria can read it. Best-effort + idempotent: on a legacy
// box still running Hy2 as root, `hysteria` simply doesn't exist and we no-op,
// so nothing breaks for old installs.
function hy2ChownConfig(file) {
  try {
    // Resolve the uid/gid the unit actually runs as. Prefer the `hysteria`
    // user; fall back to whatever owns the existing config (covers custom
    // setups) so we never *lower* access.
    let uid = null, gid = null;
    try {
      const pw = execSync('id -u hysteria 2>/dev/null', { timeout: 4000 }).toString().trim();
      const gr = execSync('id -g hysteria 2>/dev/null', { timeout: 4000 }).toString().trim();
      if (pw !== '') uid = parseInt(pw, 10);
      if (gr !== '') gid = parseInt(gr, 10);
    } catch {}
    // No dedicated user (legacy root install) → leave as-is, don't break it.
    if (uid === null || Number.isNaN(uid)) return;
    const targets = [];
    if (file) targets.push(file);
    // Also fix the dir + the .last backup so a later rollback stays readable.
    try {
      const dir = path.dirname(file || HY2_CONFIG);
      targets.push(dir);
      if (file) targets.push(file + '.last');
    } catch {}
    for (const t of targets) {
      try {
        if (!fs.existsSync(t)) continue;
        fs.chownSync(t, uid, (gid === null || Number.isNaN(gid)) ? -1 : gid);
        const st = fs.statSync(t);
        // dir needs traverse (750); files stay group-readable (640).
        fs.chmodSync(t, st.isDirectory() ? 0o750 : 0o640);
      } catch {}
    }
  } catch {}
}

// Return the list of users (from the shared pool) that have Hy2 enabled.
function getHy2Users() {
  return getAllUsers()
    .map(parseUserRow)
    .filter(u => Array.isArray(u.protocols) && u.protocols.includes('hy2'));
}

// Add the "hy2" protocol to every existing user that doesn't already have it,
// so that enabling/installing Hy2 lights up the Hy2 checkbox on all issued keys
// (operator request). Idempotent — users already carrying hy2 are untouched.
// Returns the number of users updated.
function enrollAllHy2() {
  let changed = 0;
  for (const raw of getAllUsers()) {
    let protocols;
    try { protocols = JSON.parse(raw.protocols || '[]'); } catch { protocols = []; }
    if (!Array.isArray(protocols)) protocols = [];
    if (protocols.includes('hy2')) continue;
    protocols.push('hy2');
    try {
      upsertUser({ ...raw,
        protocols: JSON.stringify(protocols),
        password:  raw.password || '',
        updatedAt: new Date().toISOString() });
      changed++;
    } catch (e) { try { console.error('[HY2 enroll]', raw.username, e.message); } catch {} }
  }
  return changed;
}

// YAML double-quoted scalar: escape backslash and double-quote (sufficient for
// double-quoted flow scalars per the YAML spec for our value set).
function yamlQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Build the replacement `auth:` block (userpass map) from the given users.
// A username maps to its plaintext password (Hy2 needs the plaintext to auth
// the client; we store `password` alongside the bcrypt hash for exactly the
// same reason Naive/Mieru links need it).
function buildHy2AuthBlock(users) {
  const lines = ['auth:', '  type: userpass', '  userpass:'];
  const seen = new Set();
  for (const u of users) {
    if (!u.username || seen.has(u.username)) continue;
    seen.add(u.username);
    const pw = u.password || '';
    if (!pw) continue;   // no stored plaintext → cannot auth; skip safely
    // v1.9.1 (subscriber bug): the username is a YAML MAP KEY. Emitting it bare
    // (`ivan.petrov: "pw"`) lets the YAML parser mis-read anything the key set
    // allows but plain-scalar semantics reinterpret — notably a DOT (some
    // parsers/tools treat `a.b` as a nested path), a leading digit, a leading
    // `-`, etc. A single such user corrupts the WHOLE `auth:` map, so Hy2
    // refuses the config and the service falls over for EVERYONE. The panel
    // also advertises `.` as allowed (USERNAME_RE), so we must honour that.
    // Fix: quote the KEY too (same double-quoted scalar as the value). The
    // userpass map is unchanged for plain usernames (a quoted key `"ivan"` and
    // a bare key `ivan` denote the identical string in YAML), so existing
    // installs auth byte-identically — only dotted/edge-case names get repaired.
    lines.push(`    ${yamlQuote(u.username)}: ${yamlQuote(pw)}`);
  }
  // Hysteria REJECTS an empty userpass map ("invalid config: auth.userpass:
  // empty auth userpass") — neither `userpass: {}` nor a bare `{}` on the next
  // line satisfy it. So when no user in the shared pool has Hy2 enabled we emit
  // a single DISABLED sentinel entry with a long random password nobody can
  // guess. This keeps the service UP (instead of crash-looping) while still
  // admitting zero real clients; it's silently replaced the moment a real Hy2
  // user is added.
  if (lines.length === 3) {
    const rnd = crypto.randomBytes(24).toString('hex');
    lines.push(`    ${yamlQuote('__disabled_no_hy2_users__')}: ${yamlQuote('disabled-' + rnd)}`);
  }
  return lines.join('\n') + '\n';
}

// Splice the freshly-built `auth:` block into the existing config text,
// replacing the old `auth:` … (up to the next top-level key or EOF).
function spliceHy2Auth(configText, authBlock) {
  const text = String(configText);
  // Match a top-level `auth:` line and everything indented under it, stopping
  // at the next top-level (column-0, non-comment, non-blank) key or EOF.
  const re = /^auth:[ \t]*\r?\n(?:[ \t].*\r?\n?|\r?\n)*/m;
  if (re.test(text)) {
    return text.replace(re, () => authBlock);
  }
  // No existing auth: block (unexpected) — insert after the `listen:` line, or
  // prepend if listen is also missing.
  const listenRe = /^listen:.*\r?\n/m;
  if (listenRe.test(text)) {
    return text.replace(listenRe, (m) => m + '\n' + authBlock);
  }
  return authBlock + '\n' + text;
}

// Basic structural sanity check for a Hy2 config before we commit it: must
// contain a listen directive and either tls or acme (so the server can bind
// and terminate QUIC/TLS). Prevents writing a config that would crash-loop.
function hy2ConfigLooksValid(text) {
  const t = String(text);
  if (!/^listen:/m.test(t)) return false;
  if (!/^tls:/m.test(t) && !/^acme:/m.test(t)) return false;
  if (!/^auth:/m.test(t)) return false;
  return true;
}

// Rewrite /etc/hysteria/config.yaml's auth block from the DB and restart Hy2.
// Atomic: write .new → validate structure → backup current to .last → rename →
// restart → verify is-active; on failure roll back to .last. Returns
// { ok, changed, error, active }.
function writeHysteriaConfig({ restart = true } = {}) {
  // If Hy2 was never installed there's no config to manage — no-op success so
  // user add/delete never fails just because Hy2 isn't present.
  if (!fs.existsSync(HY2_CONFIG)) {
    return { ok: true, changed: false, active: false, error: null, skipped: 'not-installed' };
  }
  let current = '';
  try { current = fs.readFileSync(HY2_CONFIG, 'utf8'); }
  catch (e) { return { ok: false, changed: false, active: false, error: 'read failed: ' + e.message }; }

  const users = getHy2Users();
  const authBlock = buildHy2AuthBlock(users);
  const next = spliceHy2Auth(current, authBlock);

  if (next === current) {
    // Nothing to change (idempotent). Optionally ensure it's running.
    let active = false;
    try { active = execSync('systemctl is-active hysteria-server 2>/dev/null', { timeout: 5000 }).toString().trim() === 'active'; } catch {}
    return { ok: true, changed: false, active, error: null };
  }

  if (!hy2ConfigLooksValid(next)) {
    return { ok: false, changed: false, active: false,
             error: 'refusing to write Hy2 config: failed structural validation (missing listen/tls/auth)' };
  }

  const tmp  = HY2_CONFIG + '.new';
  const last = HY2_CONFIG + '.last';
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    try { fs.copyFileSync(HY2_CONFIG, last); } catch {}   // backup for rollback
    fs.renameSync(tmp, HY2_CONFIG);                        // atomic replace
    hy2ChownConfig(HY2_CONFIG);   // hand back to service user (else perm-denied)
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, changed: false, active: false, error: 'write failed: ' + e.message };
  }

  if (!restart) return { ok: true, changed: true, active: false, error: null };

  const r = reloadHysteria();
  if (!r.ok) {
    // Roll back to the last-known-good config and restart again.
    try {
      if (fs.existsSync(last)) {
        fs.copyFileSync(last, HY2_CONFIG);
        hy2ChownConfig(HY2_CONFIG);   // keep rollback readable by the service user
        reloadHysteria();
      }
    } catch {}
    return { ok: false, changed: true, active: r.active, error: 'Hy2 failed to start with new users; rolled back. ' + (r.error || '') };
  }
  return { ok: true, changed: true, active: r.active, error: null };
}

// Restart hysteria-server and verify it came up. Clears any lingering
// systemd "failed" state first (mirrors restartMieru's Bug-96 handling).
function reloadHysteria() {
  try { execSync('systemctl reset-failed hysteria-server 2>/dev/null || true', { timeout: 5000 }); } catch {}
  try {
    execSync('systemctl restart hysteria-server', { timeout: 20000 });
  } catch (e) {
    return { ok: false, active: false, error: (e.stderr ? e.stderr.toString() : e.message) };
  }
  let active = false;
  try { active = execSync('systemctl is-active hysteria-server 2>/dev/null', { timeout: 8000 }).toString().trim() === 'active'; } catch {}
  if (!active) {
    let j = '';
    try { j = execSync('journalctl -u hysteria-server -n 15 --no-pager 2>/dev/null', { timeout: 5000 }).toString(); } catch {}
    return { ok: false, active: false, error: 'hysteria-server not active after restart. ' + j.slice(-500) };
  }
  return { ok: true, active: true, error: null };
}

// Is Hy2 installed on this box? (binary + config present, or stack flag set.)
function hy2Installed() {
  try {
    return fs.existsSync(HY2_CONFIG) && fs.existsSync('/usr/local/bin/hysteria');
  } catch { return false; }
}

// ── Hy2 installer orchestrator — scripts/install_hysteria.sh ─────────────────
const HY2_INSTALL_SCRIPT = path.join(__dirname, '../scripts/install_hysteria.sh');

// Run install_hysteria.sh with env from cfg. USE_CADDY_CERT defaults to 1
// (reuse Caddy's cert — no second email). Returns { ok, output }.
function runInstallHysteria(opts = {}) {
  try {
    const env = Object.assign({}, process.env, {
      HY_DOMAIN:      String(cfg.domain || ''),
      HY_PORT:        String(opts.port || cfg.hy2Port || 443),
      HY_EMAIL:       String(cfg.adminEmail || 'admin@example.com'),
      // Bootstrap password is optional — the panel rewrites userpass from the
      // DB immediately after install. Pass empty so the map starts empty.
      HY_PASSWORD:    '',
      USE_CADDY_CERT: opts.useCaddyCert === false ? '0' : '1',
    });
    const out = execFileSync('bash', [HY2_INSTALL_SCRIPT], { timeout: 300000, env }).toString();
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : e.message) };
  }
}

// ── naiveCascadeStatusText() — Bug 93 ────────────────────────────────────────
// The "Проверить статус" button used to only diagnose the Mieru cascade (Variant
// B), so a Naive-only cascade always showed "configured: 0 / inactive" — wildly
// misleading. This block diagnoses the Naive leg:
//   • whether an `upstream` line is present in the live Caddyfile
//   • `caddy-naive validate` result
//   • `systemctl is-active caddy-naive`
//   • egress IP measured THROUGH the naive upstream (curl -x https://u:p@exit:443)
// Credentials are redacted in the printed output.
function naiveCascadeStatusText() {
  const lines = [];
  lines.push('=== NAIVE CASCADE ===');

  const enabled = !!cfg.cascadeEnabled;
  const upstreamRaw = (cfg.cascadeNaiveUpstream || '').trim();
  const upstream = upstreamRaw ? normalizeUpstream(upstreamRaw) : '';
  const redact = (u) => u.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');

  lines.push(`cascadeEnabled : ${enabled}`);
  lines.push(`upstream (cfg) : ${upstream ? redact(upstream) : '(none)'}`);

  // 1) upstream present in the live Caddyfile?
  let inFile = false;
  try {
    if (fs.existsSync(resolvedCaddyFile)) {
      const c = fs.readFileSync(resolvedCaddyFile, 'utf8');
      inFile = /^\s*upstream\s+https:\/\//mi.test(c);
    }
  } catch {}
  lines.push(`upstream in Caddyfile : ${inFile ? 'yes' : 'no'}`);

  // 2) caddy-naive validate
  let validate = 'unknown';
  try {
    execSync(`${CADDY_BIN} validate --config '${resolvedCaddyFile}' --adapter caddyfile 2>&1`, { timeout: 15000 });
    validate = 'Valid';
  } catch (e) {
    const out = ((e.stdout && e.stdout.toString()) || (e.stderr && e.stderr.toString()) || e.message || '').trim();
    validate = 'INVALID: ' + out.split('\n').slice(-3).join(' ');
  }
  lines.push(`caddy validate : ${validate}`);

  // 3) systemctl is-active caddy-naive
  let active = 'unknown';
  try { active = execSync('systemctl is-active caddy-naive 2>/dev/null', { timeout: 5000 }).toString().trim(); }
  catch (e) { active = (e.stdout ? e.stdout.toString().trim() : '') || 'inactive'; }
  lines.push(`caddy-naive    : ${active}`);
  if (active !== 'active') {
    const err = collectCaddyError(null);
    if (err) lines.push('  ↳ ' + err.split('\n').join('\n  ↳ '));
  }

  // 4) egress IP through the naive upstream itself.
  if (enabled && upstream) {
    let egress = '';
    try {
      // -x routes through the exit's forward proxy; api.ipify.org returns the
      // public IP the request egressed from (= exit node IP when cascade works).
      egress = execSync(
        `curl -fsS --max-time 12 -x '${upstream}' https://api.ipify.org 2>/dev/null`,
        { timeout: 15000 }
      ).toString().trim();
    } catch (e) {
      egress = 'FAILED (' + ((e.stderr && e.stderr.toString().trim()) || e.message || 'no response') + ')';
    }
    lines.push(`egress via upstream : ${egress || '(empty)'}`);
  } else {
    lines.push('egress via upstream : (cascade not enabled / no upstream)');
  }

  return lines.join('\n');
}

// BUG-176 ("Failed to fetch" when toggling Hy2 / saving a user): a user CRUD
// call ran applyAllConfigs() SYNCHRONOUSLY before responding. That serially
// restarts caddy-naive (~20s budget), mita, AND hysteria-server (~20s) — the
// combined wall-time could exceed the browser/reverse-proxy idle window, so the
// fetch connection was dropped and the UI showed "Failed to fetch", even though
// the DB write had already succeeded (hence "reopen and it's there"). Fix: run
// the heavy service apply in the BACKGROUND and let the request return as soon
// as the DB write is durable. The last result is cached so the UI can poll it.
let _lastApplyResult = { caddyOk: true, mitaOk: true, hy2Ok: true,
                         caddyError: '', hy2Error: '', servicesReloaded: true,
                         at: null, running: false };
let _applyQueued = false;

// Kick a background apply. Coalesces bursts (multiple CRUD ops in quick
// succession) into a single trailing run so we never pile up restarts.
function applyAllConfigsAsync() {
  _lastApplyResult.running = true;
  if (_applyQueued) return;   // a run is already scheduled; it will pick up latest state
  _applyQueued = true;
  setImmediate(() => {
    _applyQueued = false;
    let r;
    try { r = applyAllConfigs(); }
    catch (e) { r = { caddyOk: false, mitaOk: false, hy2Ok: false,
                      caddyError: e.message, hy2Error: e.message, servicesReloaded: false }; }
    _lastApplyResult = { ...r, at: new Date().toISOString(), running: false };
  });
}

// ── applyAllConfigs() — unified pipeline ─────────────────────────────────────
// Rebuilds Caddyfile, (re)starts Caddy, rebuilds mita state, applies mita config.
// Called after every user CRUD operation.
// Bug 89: creating a naive key used to "not work" until `update.sh --force`,
// because writeCaddyfileAtomic left the file root:root (Bug 90) and reloadCaddy
// silently failed/kept the old config (Bug 91). With the chown in
// writeCaddyfileAtomic and the full restart+verify in applyCaddyConfig, a new
// key now activates immediately. We also surface the real caddy error.
function applyAllConfigs() {
  let caddyOk = false, mitaOk = false, hy2Ok = true, caddyError = '', hy2Error = '';
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);          // Bug 90: chown root:caddy inside
    const r = applyCaddyConfig();           // Bug 91: full restart + verify
    caddyOk = r.ok;
    if (!r.ok) {
      caddyError = r.error;
      console.error('[CADDY] apply failed:', r.error);
    }
  } catch (e) { caddyError = e.message; console.error('[CADDY]', e.message); }
  try { mitaOk = applyMitaConfig(); }
  catch (e) { console.error('[MITA]', e.message); }
  // Hy2: only acts when installed (config file present); otherwise it's a
  // no-op success so user CRUD never fails just because Hy2 isn't deployed.
  try {
    const h = writeHysteriaConfig();
    hy2Ok = h.ok;
    if (!h.ok) { hy2Error = h.error || ''; console.error('[HY2] apply failed:', h.error); }
  } catch (e) { hy2Ok = false; hy2Error = e.message; console.error('[HY2]', e.message); }
  return { caddyOk, mitaOk, hy2Ok, caddyError, hy2Error,
           servicesReloaded: caddyOk && mitaOk && hy2Ok };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'",
                        'https://cdn.jsdelivr.net'],
      // Bug CSP: script-src-attr 'none' prevents inline event handlers
      scriptSrcAttr:   ["'none'"],
      styleSrc:        ["'self'", "'unsafe-inline'",
                        'https://fonts.googleapis.com',
                        'https://fonts.gstatic.com'],
      fontSrc:         ["'self'", 'https://fonts.gstatic.com'],
      connectSrc:      ["'self'", 'ws:', 'wss:', 'https://fonts.googleapis.com'],
      imgSrc:          ["'self'", 'data:', 'blob:'],
      mediaSrc:        ["'none'"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(morgan('combined', {
  stream: { write: m => { try { fs.appendFileSync(LOG_PANEL, m); } catch {} } }
}));
// v1.6.0: backup import can be a large JSON (many users + full config), so lift
// the default 100kb body cap to 25mb. All other endpoints send tiny bodies, so
// this only matters for POST /api/backup/import.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

// Session
let sessionSecret;
const secretFile = path.join(path.dirname(resolvedDb), '.session_secret');
try { sessionSecret = fs.readFileSync(secretFile, 'utf8').trim(); }
catch {
  sessionSecret = require('crypto').randomBytes(64).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600 });
  } catch {}
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // v1.4.0: cookie Path is explicitly '/'. Externally the panel is served behind
  // Caddy's `handle_path /<webBasePath>/*`, which STRIPS the prefix before the
  // request reaches the panel — so the app always sees paths at the root and the
  // cookie scoped to '/' survives a webBasePath change (no forced re-login).
  cookie: { path: '/', secure: false, httpOnly: true, maxAge: 86400000, sameSite: 'lax' }
}));

// Rate limits
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  message: { error: 'Too many attempts' } });
const apiLimiter   = rateLimit({ windowMs:      60 * 1000, max: 300, message: { error: 'Rate limit exceeded' } });
app.use('/api/', apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/');
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Missing credentials' });

  const isAdmin =
    username === cfg.adminUser &&
    cfg.adminPassHash &&
    bcrypt.compareSync(password, cfg.adminPassHash);

  if (!isAdmin) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, authenticated: true });
});

// ── Config API ────────────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  // v1.4.0: never leak the panel basic-auth bcrypt hash to the browser — expose
  // a boolean "set" flag instead so the UI can show whether a password exists.
  const { adminPassHash, panelBasicAuthHash, ...safe } = cfg;
  safe.panelBasicAuthSet = !!panelBasicAuthHash;
  // Bug 143 (recurring): the UI also reads `version` from here (loadConfig +
  // settings render). The in-memory cfg.version can lag behind after an update
  // until the process restarts, so always serve the LIVE version (same single
  // source as /api/status) — this is what makes the header reflect the new
  // VERSION immediately after update.sh, with no manual edits.
  safe.version = readPanelVersion();
  // Never expose secrets to the browser. Mask the cascade exit password and the
  // legacy native-egress proxy passwords; expose a boolean "set" flag instead.
  if (safe.cascadeMieru && typeof safe.cascadeMieru === 'object') {
    const { pass, ...cm } = safe.cascadeMieru;
    safe.cascadeMieru = { ...cm, pass: !!pass };   // pass becomes true/false
  }
  if (safe.cascadeMieruEgress && Array.isArray(safe.cascadeMieruEgress.proxies)) {
    safe.cascadeMieruEgress = {
      ...safe.cascadeMieruEgress,
      proxies: safe.cascadeMieruEgress.proxies.map(p => {
        if (p && p.socks5Authentication) {
          const { password, ...auth } = p.socks5Authentication;
          return { ...p, socks5Authentication: { ...auth, password: !!password } };
        }
        return p;
      })
    };
  }
  res.json(safe);
});

app.post('/api/config', requireAuth, (req, res) => {
  const prevSubBase = cfg.subBaseUrl || '';
  ['domain','naivePort','mieruPortStart','mieruPortEnd',
   'trafficPattern','mtu','udpEnabled','adminEmail','language',
   'probeSecret','fakeSiteUrl','subBaseUrl'].forEach(k => {
    if (req.body[k] !== undefined) cfg[k] = req.body[k];
  });
  // v1.8.7: normalize subBaseUrl (trim; strip trailing slash; allow clearing).
  if (typeof cfg.subBaseUrl === 'string') {
    cfg.subBaseUrl = cfg.subBaseUrl.trim().replace(/\/+$/, '');
  }
  saveConfig();
  // v1.8.7: if the sub domain changed, rebuild the Caddyfile so Caddy serves
  // (and auto-provisions a TLS cert for) the new sub.<domain> and reverse-
  // proxies /sub/* to the panel. Best-effort + logged; never blocks the save.
  if ((cfg.subBaseUrl || '') !== prevSubBase) {
    try {
      writeCaddyfileAtomic(buildCaddyfile(cfg, getAllUsers()));
      reloadCaddy();
      console.log('[SUB] Caddy reloaded for subBaseUrl change ->', cfg.subBaseUrl || '(cleared)');
    } catch (e) {
      console.warn('[SUB] Caddy reload after subBaseUrl change failed:', e && e.message);
    }
  }
  const { adminPassHash, ...safe } = cfg;
  res.json({ ok: true, cfg: safe });
});

app.post('/api/config/password', requireAuth, (req, res) => {
  const { current, newPass } = req.body;
  if (!current || !newPass) return res.status(400).json({ error: 'Missing fields' });
  if (newPass.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const valid = cfg.adminPassHash && bcrypt.compareSync(current, cfg.adminPassHash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
  cfg.adminPassHash = bcrypt.hashSync(newPass, 12);
  saveConfig();
  res.json({ ok: true });
});

// ── v1.6.0: Backup (export) / Restore (import) ───────────────────────────────
// Disaster-recovery: export EVERYTHING needed to bring a fresh server back to
// the exact same state — all users (INCLUDING plaintext passwords + bcrypt
// hashes, which are what regenerate the SAME working keys) and the full panel
// config (domains, ports, protocols, cascade/WARP, admin credentials).
//
// Why plaintext passwords are in the backup: a NaiveProxy/Mieru key is
// `…://<user>:<pass>@…`. To make an existing client keep working after a
// server move, the restored server MUST reissue the identical user/pass. The
// bcrypt `passHash` alone cannot reproduce the plaintext, so we carry both.
// The file is therefore SECRET — the UI warns the operator to store it safely.
//
// Restore is idempotent and non-destructive to the mechanism: it upserts users
// by id, writes the config, then rebuilds the Caddyfile + mita config and
// restarts the services — the very same code path used by every normal
// add/delete, so nothing bespoke can drift.
const BACKUP_FORMAT = 'rixxx-panel-backup';
const BACKUP_SCHEMA = 1;

app.get('/api/backup/export', requireAuth, (req, res) => {
  try {
    const users = getAllUsers().map(u => ({
      id:        u.id,
      email:     u.email || null,
      username:  u.username,
      passHash:  u.passHash,
      password:  u.password || '',
      expiry:    u.expiry || null,
      protocols: u.protocols || '["naive","mieru"]',
      quotaMB:   u.quotaMB || 0,
      usedMB:    u.usedMB || 0,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastSeen:  u.lastSeen || null
    }));

    // Full config incl. admin credentials — this is a privileged, auth-gated
    // download (never exposed via /api/config, which masks secrets).
    const backup = {
      format:    BACKUP_FORMAT,
      schema:    BACKUP_SCHEMA,
      version:   readPanelVersion(),
      exportedAt: new Date().toISOString(),
      config:    cfg,
      users
    };

    const domainTag = (cfg.domain || 'server').replace(/[^A-Za-z0-9._-]/g, '_');
    const dateTag   = new Date().toISOString().slice(0, 10);
    const filename  = `rixxx-backup-${domainTag}-${dateTag}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (e) {
    console.error('[BACKUP] export failed:', e && e.message);
    res.status(500).json({ error: 'Backup export failed: ' + (e && e.message) });
  }
});

// Import/restore. Body: { backup: <parsed backup object>, domainMode: 'backup'|'current' }
//   domainMode 'backup'  → keep domains/IP/ports from the backup (same-DNS move; clients unaffected)
//   domainMode 'current' → keep THIS server's current domain/IP/ports (new DNS; clients need new keys)
app.post('/api/backup/import', requireAuth, (req, res) => {
  const backup     = req.body && req.body.backup;
  const domainMode = (req.body && req.body.domainMode) === 'current' ? 'current' : 'backup';

  // ── Validate shape before touching anything ────────────────────────────────
  if (!backup || typeof backup !== 'object')
    return res.status(400).json({ error: 'No backup payload provided' });
  if (backup.format !== BACKUP_FORMAT)
    return res.status(400).json({ error: 'Not a RIXXX panel backup file (bad format tag)' });
  if (!Number.isInteger(backup.schema) || backup.schema > BACKUP_SCHEMA)
    return res.status(400).json({ error: `Unsupported backup schema (${backup.schema}); this panel supports up to ${BACKUP_SCHEMA}` });
  if (!backup.config || typeof backup.config !== 'object')
    return res.status(400).json({ error: 'Backup is missing its config section' });
  if (!Array.isArray(backup.users))
    return res.status(400).json({ error: 'Backup is missing its users list' });

  // Per-user validation — reject a malformed file rather than half-import it.
  for (const u of backup.users) {
    if (!u || typeof u !== 'object' || !u.id || !u.username || !u.passHash)
      return res.status(400).json({ error: 'Backup contains a malformed user record (need id, username, passHash)' });
  }

  try {
    // ── 1) Restore config, honouring the chosen domain mode ──────────────────
    // Keys that describe THIS box's network identity. In 'current' mode we keep
    // the live values so we don't point the restored server at the wrong host.
    const NETWORK_KEYS = ['domain', 'serverIp', 'naivePort', 'mieruPortStart', 'mieruPortEnd'];
    const incoming = { ...backup.config };

    if (domainMode === 'current') {
      for (const k of NETWORK_KEYS) {
        if (cfg[k] !== undefined) incoming[k] = cfg[k];
      }
    }
    // Never let a backup silently downgrade/overwrite the recorded version tag
    // (the live version comes from readPanelVersion() anyway).
    incoming.version = cfg.version || incoming.version;

    // Preserve local runtime paths (dbPath/caddyBin/…) from the CURRENT server —
    // a backup from another box may have different absolute paths.
    const PATH_KEYS = ['dbPath', 'caddyBin', 'caddyFile', 'caddyConfigDir',
                       'fakeSiteDir', 'mitaStateFile'];
    for (const k of PATH_KEYS) {
      if (cfg[k] !== undefined) incoming[k] = cfg[k];
    }

    cfg = incoming;
    saveConfig();

    // ── 2) Restore users (upsert by id — idempotent) ─────────────────────────
    let restored = 0;
    for (const u of backup.users) {
      upsertUser({
        id:        u.id,
        email:     u.email || null,
        username:  u.username,
        passHash:  u.passHash,
        password:  u.password || '',
        expiry:    u.expiry || null,
        protocols: u.protocols || '["naive","mieru"]',
        quotaMB:   u.quotaMB || 0,
        usedMB:    u.usedMB || 0,
        createdAt: u.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeen:  u.lastSeen || null
      });
      restored++;
    }

    // ── 3) Rebuild real configs + restart services (same path as add/delete) ──
    const apply = applyAllConfigs();

    res.json({
      ok: true,
      restoredUsers: restored,
      domainMode,
      domain: cfg.domain,
      servicesReloaded: apply.servicesReloaded,
      caddyOk: apply.caddyOk,
      mitaOk:  apply.mitaOk,
      caddyError: apply.caddyError || undefined,
      message: `Restored ${restored} user(s). ` +
        (domainMode === 'backup'
          ? 'Domains/ports taken from the backup — existing client keys keep working if DNS points here.'
          : 'Kept this server\'s current domains/ports — clients must download fresh keys.')
    });
  } catch (e) {
    console.error('[BACKUP] import failed:', e && e.message);
    res.status(500).json({ error: 'Backup import failed: ' + (e && e.message) });
  }
});

// ── v1.4.0: external panel access (domain + TLS + basic auth + webBasePath) ───
// All changes regenerate the Caddyfile (which now contains the panel subdomain
// block) and apply it ATOMICALLY (Bug 91): write → restart caddy-naive → verify
// is-active. On failure we roll back config + Caddyfile and report a clear error
// so the panel never stays in a broken state.

// Generate a random 16-hex webBasePath (does NOT persist — UI persists via save).
app.get('/api/panel/webbasepath/generate', requireAuth, (req, res) => {
  res.json({ webBasePath: crypto.randomBytes(8).toString('hex') });
});

// BUG-155: a valid bcrypt token is exactly  $2[aby]$NN$<53 base64-ish chars>.
// We use this to (a) sieve a hasher's stdout down to the one valid line and
// (b) reject any multi-line / package-manager-polluted value before it reaches
// config.json or the Caddyfile (which is what put caddy-naive in a failed loop).
const BCRYPT_RE = /\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}/;
function isValidBcrypt(s) {
  return typeof s === 'string' && /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/.test(s);
}
// Extract a single valid bcrypt token from arbitrary text (the last match wins,
// matching how `caddy hash-password` prints the hash on the final line even if
// something noisy preceded it).
function extractBcrypt(text) {
  const m = String(text || '').match(/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}/g);
  return m && m.length ? m[m.length - 1] : '';
}

// Hash a basic-auth password with `caddy hash-password` (bcrypt). Falls back to
// bcryptjs so the panel works even if the caddy binary lacks the subcommand.
// BUG-155: always sieve the output to a single valid bcrypt token so a polluted
// stdout can never be stored.
function caddyHashPassword(plain) {
  try {
    const out = execFileSync(resolvedCaddyBin, ['hash-password'],
      { input: String(plain), timeout: 8000 }).toString();
    const tok = extractBcrypt(out);
    if (tok) return tok;
  } catch (_) { /* fall through */ }
  const fb = bcrypt.hashSync(String(plain), 12);
  return isValidBcrypt(fb) ? fb : extractBcrypt(fb) || fb;
}

const WEBBASE_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

app.post('/api/panel/external-access', requireAuth, (req, res) => {
  const body = req.body || {};
  const enabled = !!body.enabled;

  // Snapshot current state for rollback.
  const prev = {
    exposePanel:        cfg.exposePanel,
    panelDomain:        cfg.panelDomain,
    panelBasicAuthUser: cfg.panelBasicAuthUser,
    panelBasicAuthHash: cfg.panelBasicAuthHash,
    webBasePath:        cfg.webBasePath,
  };
  const oldWebBasePath = String(cfg.webBasePath || '');

  if (enabled) {
    const domain = String(body.panelDomain || cfg.panelDomain || '').trim();
    if (!domain || !HOSTNAME_RE.test(domain))
      return res.status(400).json({ error: 'Valid panel subdomain required (e.g. panel.example.com)' });

    // webBasePath: explicit value (sanitized) or keep existing or generate.
    let wbp = String(body.webBasePath || cfg.webBasePath || '').trim().replace(/^\/+|\/+$/g, '');
    if (!wbp) wbp = crypto.randomBytes(8).toString('hex');
    if (!WEBBASE_RE.test(wbp))
      return res.status(400).json({ error: 'webBasePath must match [A-Za-z0-9._~-] (1–64 chars)' });

    const baUser = String(body.basicAuthUser || cfg.panelBasicAuthUser || 'admin').trim();
    if (!USERNAME_RE.test(baUser))
      return res.status(400).json({ error: 'basic-auth login must match [a-zA-Z0-9_.-] (max 64)' });

    // Password: only (re)hash when a new one is provided. Keep the old hash
    // otherwise. Require a hash to exist when first enabling.
    // BUG-155: sieve the carried-forward hash to a single valid bcrypt token; a
    // polluted value (apt output captured by an old installer) is discarded so
    // it can never reach the Caddyfile and fail-loop caddy-naive.
    let baHash = isValidBcrypt(cfg.panelBasicAuthHash || '')
      ? cfg.panelBasicAuthHash
      : extractBcrypt(cfg.panelBasicAuthHash || '');
    const newPass = body.basicAuthPass != null ? String(body.basicAuthPass) : '';
    if (newPass) {
      if (newPass.length < 6) return res.status(400).json({ error: 'basic-auth password too short (min 6)' });
      baHash = caddyHashPassword(newPass);
    }
    if (!isValidBcrypt(baHash))
      return res.status(400).json({ error: 'A valid basic-auth password is required to enable external access (the stored hash was invalid — set a new password)' });

    cfg.exposePanel        = true;
    cfg.panelDomain        = domain;
    cfg.webBasePath        = wbp;
    cfg.panelBasicAuthUser = baUser;
    cfg.panelBasicAuthHash = baHash;
    cfg.panelHost          = '127.0.0.1';   // never bind externally
    cfg.panelPort          = cfg.panelPort || 3000;
    if (!cfg.panelStubPage) cfg.panelStubPage = '/var/www/panel-stub/index.html';
  } else {
    // Disable: keep panelDomain/webBasePath/hash so it can be re-enabled later.
    cfg.exposePanel = false;
    cfg.panelHost   = '127.0.0.1';
  }

  // Persist, regenerate Caddyfile, and apply atomically (Bug 91).
  const prevCaddy = (() => { try { return fs.readFileSync(resolvedCaddyFile, 'utf8'); } catch { return null; } })();
  saveConfig();
  try {
    writeCaddyfileAtomic(buildCaddyfile(cfg, getAllUsers()));
  } catch (e) {
    Object.assign(cfg, prev); saveConfig();
    return res.status(500).json({ error: 'Failed to write Caddyfile: ' + e.message });
  }
  const r = applyCaddyConfig();
  if (!r.ok) {
    // Roll back config + Caddyfile and re-apply the previous good state.
    Object.assign(cfg, prev); saveConfig();
    try {
      if (prevCaddy != null) writeCaddyfileAtomic(prevCaddy);
      else writeCaddyfileAtomic(buildCaddyfile(cfg, getAllUsers()));
    } catch (_) {}
    applyCaddyConfig();
    return res.status(500).json({ error: 'Caddy failed to apply the change — rolled back. ' + (r.error || '') });
  }

  // Build the response: new full URL + whether webBasePath changed.
  const result = { ok: true, exposePanel: cfg.exposePanel };
  if (cfg.exposePanel) {
    result.url = `https://${cfg.panelDomain}/${cfg.webBasePath}/`;
    result.panelDomain = cfg.panelDomain;
    result.webBasePath = cfg.webBasePath;
    result.basicAuthUser = cfg.panelBasicAuthUser;
    if (oldWebBasePath && oldWebBasePath !== cfg.webBasePath) {
      result.webBasePathChanged = true;
      result.warning = 'webBasePath changed — the old URL/tab now shows the stub. Open the new URL.';
    }
  }
  res.json(result);
});

// ── BUG-141: custom panel-stub HTML editor ────────────────────────────────────
// The panel-stub is the static page Caddy serves at the panel subdomain root and
// for any path outside webBasePath. It is a SEPARATE entity from the naive
// fake-site (probe-resistance). The operator can replace it with their own HTML.
function panelStubFile() {
  return String(cfg.panelStubPage || '/var/www/panel-stub/index.html').trim()
    || '/var/www/panel-stub/index.html';
}

app.get('/api/panel/stub', requireAuth, (req, res) => {
  const f = panelStubFile();
  let html = '';
  try { html = fs.readFileSync(f, 'utf8'); } catch (_) { html = ''; }
  res.json({ path: f, html });
});

app.post('/api/panel/stub', requireAuth, (req, res) => {
  const body = req.body || {};
  let html = body.html != null ? String(body.html) : '';
  // Strip a stray leading "Copy" token (clipboard artifact) and BOM.
  html = html.replace(/^\uFEFF/, '').replace(/^Copy(?=\s*<)/, '');
  if (!html.trim()) return res.status(400).json({ error: 'Stub HTML must not be empty' });
  if (html.length > 256 * 1024) return res.status(400).json({ error: 'Stub HTML too large (max 256 KiB)' });

  const f = panelStubFile();
  const dir = path.dirname(f);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.new';
    fs.writeFileSync(tmp, html, { mode: 0o644 });
    fs.renameSync(tmp, f);           // atomic replace — no half-written stub
    try { fs.chmodSync(f, 0o644); } catch (_) {}
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write stub file: ' + e.message });
  }
  // file_server serves the file directly; no Caddy restart needed.
  res.json({ ok: true, path: f, bytes: Buffer.byteLength(html) });
});

// ── Validation helpers ────────────────────────────────────────────────────────
const VALID_PROTOCOLS = ['naive', 'mieru', 'hy2'];
const USERNAME_RE     = /^[a-zA-Z0-9_.-]{1,64}$/;
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bug 35: generate a password from a SAFE alphabet only ([a-zA-Z0-9]).
//   Special characters (and Cyrillic) in a password break NaiveProxy clients
//   such as Karing/NekoBox: the naive link encodes the password with
//   encodeURIComponent, but some clients do not URL-decode it back before
//   handing it to the proxy, so "@ : / # % +" etc. corrupt the credential.
//   A pure alphanumeric password is byte-identical whether parsed from the
//   link or from JSON, so it works everywhere with no encoding ambiguity.
//   Bug 100: previously used crypto.randomInt() — that was only added in Node
//   v14.10.0, and on the production box (older Node) the call threw
//   "TypeError: crypto.randomInt is not a function".  We now do unbiased
//   selection with crypto.randomBytes() + rejection sampling, which works on
//   every Node version that ships crypto (i.e. all of them).
const SAFE_PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateSafePassword(len) {
  let n = parseInt(len, 10);
  if (isNaN(n) || n < 8)  n = 16;   // sensible default / floor
  if (n > 64)             n = 64;   // matches USERNAME_RE-style sanity cap

  const alphabetLen = SAFE_PW_ALPHABET.length;          // 62
  // Largest multiple of alphabetLen that fits in a byte; bytes >= this are
  // rejected so every character is equally likely (no modulo bias).
  const limit = 256 - (256 % alphabetLen);              // 248 for len 62
  let out = '';
  while (out.length < n) {
    // Over-allocate a bit to reduce the number of randomBytes() calls.
    const buf = crypto.randomBytes(n - out.length + 8);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i];
      if (b >= limit) continue;                         // reject to avoid bias
      out += SAFE_PW_ALPHABET[b % alphabetLen];
    }
  }
  return out;
}

/**
 * Bug 8: normalise quota — accept quotaMB or quotaGb (gb * 1024 → MB).
 * Bug 9: validate all user input fields.
 */
function validateUserInput({ email, username, password, protocols, quotaMB, quotaGb }, requirePassword) {
  if (!username || !USERNAME_RE.test(username))
    return { error: 'username required and must match [a-zA-Z0-9_.-] (max 64 chars)' };
  // Email is optional (TLS cert is configured at install time via Caddy ACME,
  // not per-user). If provided, it must still be a valid address.
  if (email !== undefined && email !== null && email !== '' && !EMAIL_RE.test(email))
    return { error: 'email is invalid' };
  if (requirePassword) {
    if (!password) return { error: 'password is required for new users' };
    if (password.length < 8) return { error: 'password must be at least 8 characters' };
  } else if (password !== undefined && password !== null && password !== '' && password.length < 8) {
    return { error: 'new password must be at least 8 characters' };
  }
  // Bug 8: accept quotaGb; convert to quotaMB
  let resolvedQuotaMB = 0;
  if (quotaMB !== undefined && quotaMB !== null) {
    resolvedQuotaMB = parseInt(quotaMB, 10);
    if (isNaN(resolvedQuotaMB) || resolvedQuotaMB < 0)
      return { error: 'quotaMB must be a non-negative integer' };
  } else if (quotaGb !== undefined && quotaGb !== null) {
    const gb = parseFloat(quotaGb);
    if (isNaN(gb) || gb < 0) return { error: 'quotaGb must be a non-negative number' };
    resolvedQuotaMB = Math.round(gb * 1024);
  }
  // Bug 9: protocols allowlist
  let resolvedProtocols = ['naive', 'mieru'];
  if (protocols !== undefined) {
    if (!Array.isArray(protocols))
      return { error: 'protocols must be an array' };
    const invalid = protocols.filter(p => !VALID_PROTOCOLS.includes(p));
    if (invalid.length)
      return { error: `unknown protocol(s): ${invalid.join(', ')}. Allowed: ${VALID_PROTOCOLS.join(', ')}` };
    if (!protocols.length)
      return { error: 'at least one protocol is required (naive, mieru, hy2)' };
    resolvedProtocols = protocols;
  }
  return { quotaMB: resolvedQuotaMB, protocols: resolvedProtocols };
}

/**
 * Bug 7: parse all TEXT JSON columns back to JS types when returning user rows.
 */
function parseUserRow(u) {
  return {
    ...u,
    protocols: typeof u.protocols === 'string'
      ? (() => { try { return JSON.parse(u.protocols); } catch { return []; } })()
      : (u.protocols || []),
    // v1.9.0: personal bonus links. Stored as a JSON array of {url, enabled}.
    // NULL/empty/garbage all normalize to [] so an un-migrated or bonus-less
    // user behaves EXACTLY as before.
    bonus_links: normalizeBonusLinks(u.bonus_links),
  };
}

// v1.9.0: normalize whatever is stored in the bonus_links column into a clean
// array of {url:string, enabled:boolean}. Accepts a JSON string (from SQLite),
// an already-parsed array (mem fallback), or NULL/undefined → []. Never throws.
// Content is stored AS-IS (no url validation) per spec — we only coerce shape.
function normalizeBonusLinks(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try { arr = JSON.parse(s); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => {
      if (typeof item === 'string') return { url: item, enabled: true };
      if (item && typeof item === 'object' && typeof item.url === 'string')
        return { url: item.url, enabled: item.enabled !== false };
      return null;
    })
    .filter(x => x && x.url.trim() !== '');
}

// ── Password generator (Bug 35) ───────────────────────────────────────────────
// Returns a fresh safe ([a-zA-Z0-9]) password for the "Random password" button
// in the key-issuance UI. Default length 16. The backend user-creation flow is
// untouched — the admin still submits whatever password they choose; this
// endpoint only suggests a safe one.
app.get('/api/password/generate', requireAuth, (req, res) => {
  const length = req.query.length || 16;
  res.json({ password: generateSafePassword(length) });
});

// ── Users API ─────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  const users = getAllUsers().map(u => {
    const { passHash, password, ...rest } = u;
    return parseUserRow(rest);
  });
  res.json(users);
});

// BUG-176: outcome of the most recent background applyAllConfigsAsync() run.
// The UI polls this after a user CRUD (servicesReloading:true) to learn whether
// caddy/mita/hy2 actually reloaded, without blocking the CRUD request itself.
app.get('/api/apply-status', requireAuth, (req, res) => {
  res.json(_lastApplyResult);
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  const validation = validateUserInput(
    { email, username, password, protocols, quotaMB, quotaGb }, true);
  if (validation.error)
    return res.status(400).json({ error: validation.error });

  const normEmail = (email && email.trim()) ? email.trim() : null;

  if (expiry && isNaN(Date.parse(expiry)))
    return res.status(400).json({ error: 'expiry must be a valid ISO date string' });

  // Bug 149 (race, v1.4.5): coalesce a rapid double-submit BEFORE any duplicate
  // gate. This is critical and must be the very first thing after validation:
  // under Node's microtask ordering the FIRST request's INSERT (behind an
  // `await`) completes before the SECOND request's handler even begins. So if
  // we ran ANY synchronous duplicate check first (username OR email), the twin
  // would see the row the first request just inserted and wrongly 409 — that
  // was the "Email already in use" symptom: the email pre-check fired before
  // the in-flight check. By consulting the in-flight map FIRST (keyed by
  // username), the twin awaits the SAME promise and gets the winner's identical
  // success — no false error, no duplicate row. The entry survives until the
  // winner fully resolves (its `finally` deletes it), so the twin always finds
  // it.
  if (inflightCreates.has(username)) {
    try {
      const r = await inflightCreates.get(username);
      return res.status(r.status).json(r.payload);
    } catch {
      return res.status(500).json({ error: 'Could not save user (database error)' });
    }
  }

  // Bug 149 (v1.4.5): idempotent double-submit handling. Two rapid HTTP POSTs
  // (double-click / Enter+click) do NOT overlap at the JS level — Node drains
  // microtasks between socket events, so request #1 fully completes (INSERT +
  // in-flight cleanup) before request #2's handler even starts. The in-flight
  // map alone therefore can't catch them, and #2 would see the row #1 just
  // created and wrongly 409. So when the username already exists we decide:
  //   • password matches the stored hash  → this is the SAME submit replayed
  //     (a double-submit) → idempotent SUCCESS, return the existing user (200).
  //   • password differs                  → a genuine clash with a different,
  //     pre-existing user → real 409 "Username already exists".
  // This satisfies "повторный/двойной клик не плодит ошибку" without masking a
  // real collision. (A double-submit always carries the identical password the
  // user just typed; a different user would have a different password.)
  const existingByName = getUserByUsername(username);
  if (existingByName) {
    const samePassword = password && existingByName.passHash &&
      bcrypt.compareSync(password, existingByName.passHash);
    if (samePassword) {
      const { passHash, password: _p, ...safe } = existingByName;
      return res.status(200).json({ ok: true, idempotent: true, ...parseUserRow(safe) });
    }
    return res.status(409).json({ error: 'Username already exists' });
  }
  // Email is optional and used only as a note. Only reject when the email
  // belongs to a DIFFERENT, already-existing user — never when empty (NULL is
  // exempt from UNIQUE). A same-submit replay was already handled above.
  if (normEmail) {
    const emailOwner = getUserByEmail(normEmail);
    if (emailOwner && emailOwner.username !== username)
      return res.status(409).json({ error: 'Email already in use' });
  }

  const work = (async () => {
    // Yield once so a near-simultaneous twin request observes the in-flight
    // entry (set below) and coalesces onto this promise instead of racing.
    await Promise.resolve();
    const now  = new Date().toISOString();
    const user = {
      id:        uuidv4(),
      // Email is optional: store NULL (not '') so the UNIQUE constraint allows
      // multiple users without an email.
      email:     normEmail,
      username,
      passHash:  bcrypt.hashSync(password, 12),
      password,
      expiry:    expiry || null,
      protocols: JSON.stringify(validation.protocols),
      quotaMB:   validation.quotaMB,
      usedMB:    0,
      // v1.8.7: mint a random subscription token (128-bit hex) up-front so the
      // /sub/:token link works the instant the user is created.
      sub_token: crypto.randomBytes(16).toString('hex'),
      createdAt: now, updatedAt: now, lastSeen: null
    };

    // Atomic create: INSERT ... ON CONFLICT(username) DO NOTHING. Because we
    // verified the username did NOT exist before this request, a no-op insert
    // here can only mean a concurrent twin won the race → treat as success
    // (idempotent) and return that row. A genuine pre-existing clash was already
    // rejected above.
    let result;
    try {
      result = createUserAtomic(user);
    } catch (e) {
      const d = describeDbError(e);
      console.error('[USERS] create failed:', e.message);
      return { status: d.status, payload: { error: d.error } };
    }

    // Run the (heavier) service rebuild only when WE actually inserted the row.
    // BUG-176: do it in the background so the POST returns promptly (avoids the
    // dropped-connection "Failed to fetch" during the 3 sequential restarts).
    if (result.created) applyAllConfigsAsync();
    const row = result.user || user;
    const { passHash, password: _p, ...safe } = row;
    return { status: 201, payload: { ok: true, ...parseUserRow(safe),
             servicesReloading: !!result.created } };
  })();

  inflightCreates.set(username, work);
  try {
    const r = await work;
    return res.status(r.status).json(r.payload);
  } catch (e) {
    console.error('[USERS] create failed:', e && e.message);
    return res.status(500).json({ error: 'Could not save user (database error)' });
  } finally {
    inflightCreates.delete(username);
  }
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { email, username, password, expiry, protocols, quotaMB, quotaGb } = req.body;
  const validation = validateUserInput(
    { email: email ?? user.email,
      username: username ?? user.username,
      password,
      protocols,
      quotaMB: quotaMB !== undefined ? quotaMB : undefined,
      quotaGb: quotaGb !== undefined ? quotaGb : undefined }, false);
  if (validation.error)
    return res.status(400).json({ error: validation.error });

  if (expiry !== undefined && expiry !== null && isNaN(Date.parse(expiry)))
    return res.status(400).json({ error: 'expiry must be a valid ISO date string' });

  const newEmail = email !== undefined
    ? ((email && email.trim()) ? email.trim() : null)
    : user.email;

  // Bug 149: if the email is changing to a non-empty value already used by a
  // DIFFERENT user, return a clean 409 rather than throwing a UNIQUE error.
  if (newEmail) {
    const clash = getUserByEmail(newEmail);
    if (clash && clash.id !== user.id)
      return res.status(409).json({ error: 'Email already in use' });
  }
  // Same guard for a username change.
  if (username && username !== user.username && getUserByUsername(username))
    return res.status(409).json({ error: 'Username already exists' });

  const updated = {
    ...user,
    email:     newEmail,
    username:  username  ?? user.username,
    expiry:    expiry    !== undefined ? (expiry || null) : user.expiry,
    protocols: protocols
      ? JSON.stringify(validation.protocols)
      : user.protocols,
    quotaMB:   (quotaMB !== undefined || quotaGb !== undefined)
      ? validation.quotaMB
      : user.quotaMB,
    updatedAt: new Date().toISOString()
  };
  if (password) {
    updated.passHash = bcrypt.hashSync(password, 12);
    updated.password = password;
  }
  try {
    upsertUser(updated);
  } catch (e) {
    const d = describeDbError(e);
    console.error('[USERS] update failed:', e.message);
    return res.status(d.status).json({ error: d.error });
  }

  // BUG-176: apply configs in the background so the response returns promptly
  // (the DB write above is already durable). servicesReloading tells the UI to
  // poll /api/apply-status for the outcome instead of waiting on this request.
  applyAllConfigsAsync();

  const { passHash, password: _p, ...safe } = updated;
  res.json({ ok: true, ...parseUserRow(safe), servicesReloading: true });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  deleteUser(req.params.id);
  applyAllConfigsAsync();   // BUG-176: background apply
  res.json({ ok: true, servicesReloading: true });
});

// ── Server settings ───────────────────────────────────────────────────────────

// Caddy port: rebuild Caddyfile + full restart (port binding change)
// Bug 52: verify caddy-naive is active after restart; return HTTP 500 if not
app.post('/api/settings/naive-port', requireAuth, (req, res) => {
  const p = parseInt(req.body.port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1–65535)' });
  cfg.naivePort = p; saveConfig();
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    restartCaddy();
    // Bug 52: confirm the service is actually running after restart
    let active = false;
    try { execSync('systemctl is-active caddy-naive', { timeout: 8000 }); active = true; } catch {}
    if (!active) {
      return res.status(500).json({
        ok: false,
        error: 'caddy-naive failed to start after port change — run: journalctl -u caddy-naive -n 30'
      });
    }
    res.json({ ok: true, message: `NaiveProxy port changed to ${p}. Clients must download new configs.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mieru ports: UFW update + full restart
app.post('/api/settings/mieru-ports', requireAuth, (req, res) => {
  const s = parseInt(req.body.portStart, 10);
  const e = parseInt(req.body.portEnd,   10);
  if (!s || !e || s < 1025 || e > 65535 || e < s)
    return res.status(400).json({ error: 'Invalid port range (1025–65535, end ≥ start)' });

  const oldS = cfg.mieruPortStart, oldE = cfg.mieruPortEnd;
  cfg.mieruPortStart = s; cfg.mieruPortEnd = e; saveConfig();

  try {
    // Bug 7: use single-port helper to avoid UFW crash when start===end
    ufwMieruRule('delete', oldS, oldE, 'tcp', '');
    ufwMieruRule('delete', oldS, oldE, 'udp', '');
    ufwMieruRule('',       s,    e,    'tcp', 'Mieru TCP');
    if (cfg.udpEnabled) ufwMieruRule('', s, e, 'udp', 'Mieru UDP');
  } catch {}

  try {
    const ok = restartMieru();
    res.json({ ok, message: `Mieru ports changed to ${s}–${e}. Service restarted. Clients must download new configs.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hy2 (Hysteria2) settings ─────────────────────────────────────────────────

// Status: is Hy2 installed, on which port, and is the service active + how many
// users in the shared pool have hy2 enabled.
app.get('/api/settings/hy2', requireAuth, (req, res) => {
  const installed = hy2Installed();
  let active = false;
  if (installed) {
    try { active = execSync('systemctl is-active hysteria-server 2>/dev/null', { timeout: 5000 }).toString().trim() === 'active'; } catch {}
  }
  res.json({
    installed,
    active,
    port: parseInt(cfg.hy2Port, 10) || 443,
    stack: cfg.stack || { naive: true, mieru: true, hy2: false },
    hy2UserCount: (() => { try { return getHy2Users().length; } catch { return 0; } })()
  });
});

// Install (or reinstall) the Hy2 server. Runs install_hysteria.sh with the
// configured domain/port and USE_CADDY_CERT=1 (reuse Caddy cert, no 2nd email),
// then immediately writes the userpass map from the shared pool.
app.post('/api/settings/hy2/install', requireAuth, (req, res) => {
  if (!cfg.domain || cfg.domain === 'localhost')
    return res.status(400).json({ error: 'A real domain must be configured before installing Hy2 (TLS/SNI required).' });

  // Optional one-shot port override at install time.
  if (req.body && req.body.port !== undefined) {
    const p = parseInt(req.body.port, 10);
    if (!p || p < 1 || p > 65535) return res.status(400).json({ error: 'Invalid port (1–65535)' });
    cfg.hy2Port = p;
  }
  const useCaddyCert = !(req.body && req.body.useCaddyCert === false);

  const r = runInstallHysteria({ port: cfg.hy2Port, useCaddyCert });
  if (!r.ok) {
    return res.status(500).json({ ok: false, error: 'Hy2 install failed', output: r.output });
  }
  // Mark installed and persist BEFORE writing users so a restart mid-flow still
  // knows Hy2 is present.
  cfg.stack = cfg.stack || {};
  cfg.stack.hy2 = true;
  saveConfig();

  // Operator request: auto-enroll all EXISTING keys into Hy2 so they light up
  // the Hy2 checkbox and can use it immediately (no per-user re-edit). Opt-out
  // with { enrollAll:false }. Default true (installing Hy2 = "I want everyone
  // on Hy2"). Idempotent, so re-installing never double-adds.
  const enrollAll = !(req.body && req.body.enrollAll === false);
  let enrolled = 0;
  if (enrollAll) {
    try { enrolled = enrollAllHy2(); } catch (e) { try { console.error('[HY2 enroll]', e.message); } catch {} }
  }

  // Push the shared-pool users into the userpass map right away.
  let hy2Sync = { ok: true };
  try { hy2Sync = writeHysteriaConfig(); } catch (e) { hy2Sync = { ok: false, error: e.message }; }

  let active = false;
  try { active = execSync('systemctl is-active hysteria-server 2>/dev/null', { timeout: 5000 }).toString().trim() === 'active'; } catch {}

  res.json({
    ok: true,
    installed: true,
    active,
    port: cfg.hy2Port,
    hy2Sync,
    enrolled,
    message: `Hysteria2 установлен на порт ${cfg.hy2Port}/udp.` +
             (enrolled ? ` Hy2 включён на ${enrolled} существующих ключах.` : ' Пользователи с протоколом hy2 добавлены.') +
             ' Клиенты могут скачать hy2-ссылку.',
    output: r.output
  });
});

// Enroll all existing keys into Hy2 on demand (operator button), without
// re-running the installer. Only meaningful once Hy2 is installed.
app.post('/api/settings/hy2/enroll-all', requireAuth, (req, res) => {
  if (!hy2Installed())
    return res.status(400).json({ error: 'Hysteria2 не установлен на этом сервере.' });
  let enrolled = 0;
  try { enrolled = enrollAllHy2(); } catch (e) { return res.status(500).json({ error: e.message }); }
  let hy2Sync = { ok: true };
  try { hy2Sync = writeHysteriaConfig(); } catch (e) { hy2Sync = { ok: false, error: e.message }; }
  res.json({ ok: true, enrolled, hy2Sync,
    message: enrolled ? `Hy2 включён на ${enrolled} ключах.` : 'Все ключи уже используют Hy2.' });
});

// Change the Hy2 UDP port: update config.yaml's listen directive + restart.
app.post('/api/settings/hy2-port', requireAuth, (req, res) => {
  const p = parseInt(req.body.port, 10);
  if (!p || p < 1 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (1–65535)' });

  const oldPort = parseInt(cfg.hy2Port, 10) || 443;
  cfg.hy2Port = p; saveConfig();

  // If Hy2 isn't installed yet, just remember the port for the next install.
  if (!hy2Installed()) {
    return res.json({ ok: true, port: p, installed: false,
      message: `Hy2 порт сохранён (${p}/udp). Применится при установке Hy2.` });
  }

  // Rewrite the `listen:` line in config.yaml atomically, then restart.
  try {
    let text = fs.readFileSync(HY2_CONFIG, 'utf8');
    const before = text;
    text = text.replace(/^listen:.*$/m, `listen: :${p}`);
    if (text === before && !/^listen:/m.test(text)) {
      // No listen line at all — prepend one.
      text = `listen: :${p}\n` + text;
    }
    // Update firewall if UFW active (best-effort).
    try {
      execSync(`command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active' && ufw allow ${p}/udp >/dev/null 2>&1 || true`, { timeout: 8000 });
      if (oldPort !== p) execSync(`command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active' && ufw delete allow ${oldPort}/udp >/dev/null 2>&1 || true`, { timeout: 8000 });
    } catch {}

    const tmp = HY2_CONFIG + '.new';
    const last = HY2_CONFIG + '.last';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.copyFileSync(HY2_CONFIG, last); } catch {}
    fs.renameSync(tmp, HY2_CONFIG);
    hy2ChownConfig(HY2_CONFIG);   // hand back to service user (else perm-denied)

    const r = reloadHysteria();
    if (!r.ok) {
      // Roll back
      try { if (fs.existsSync(last)) { fs.copyFileSync(last, HY2_CONFIG); hy2ChownConfig(HY2_CONFIG); reloadHysteria(); } } catch {}
      cfg.hy2Port = oldPort; saveConfig();
      return res.status(500).json({ ok: false, error: 'Hy2 failed to start on new port; rolled back. ' + (r.error || '') });
    }
    res.json({ ok: true, port: p, installed: true,
      message: `Hy2 порт изменён на ${p}/udp. Сервис перезапущен. Клиенты должны обновить ссылки.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Traffic pattern + MTU: mita reload
app.post('/api/settings/traffic-pattern', requireAuth, (req, res) => {
  const validPatterns = ['NOOP', 'RANDOM_PADDING', 'RANDOM_PADDING_AGGRESSIVE'];
  const { pattern, mtu } = req.body;
  if (!validPatterns.includes(pattern))
    return res.status(400).json({ error: `Invalid pattern. Valid: ${validPatterns.join(', ')}` });
  if (mtu !== undefined) {
    const m = parseInt(mtu, 10);
    if (m < 1280 || m > 1400) return res.status(400).json({ error: 'MTU must be 1280–1400' });
    cfg.mtu = m;
  }
  cfg.trafficPattern = pattern; saveConfig();
  try {
    const ok = applyMitaConfig();
    // BUG-156: report a config/apply failure (e.g. an invalid trafficPattern)
    // instead of silently returning ok:false with no reason.
    const mitaError = getLastMitaError();
    res.json({ ok, pattern, mtu: cfg.mtu, mitaError: mitaError || undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// UDP toggle: requires full Mieru restart (port bindings change)
app.post('/api/settings/udp-toggle', requireAuth, (req, res) => {
  const enable = req.body.enabled === true || req.body.enabled === 'true';
  cfg.udpEnabled = enable; saveConfig();
  try {
    const s = cfg.mieruPortStart, e = cfg.mieruPortEnd;
    // Bug 7: use single-port helper to avoid UFW crash when start===end
    if (enable) {
      ufwMieruRule('', s, e, 'udp', 'Mieru UDP');
    } else {
      ufwMieruRule('delete', s, e, 'udp', '');
    }
  } catch {}
  try {
    const ok = restartMieru();
    res.json({ ok, udpEnabled: enable,
      message: `UDP ${enable ? 'enabled' : 'disabled'}. Mieru restarted.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Language setting
app.post('/api/settings/language', requireAuth, (req, res) => {
  const { language } = req.body;
  if (!['ru', 'en'].includes(language))
    return res.status(400).json({ error: 'Supported languages: ru, en' });
  cfg.language = language;
  saveConfig();
  res.json({ ok: true, language });
});

// Probe secret update — rebuilds Caddyfile and reloads Caddy.
// Setting a secret also switches probeMode to 'secret'.
app.post('/api/settings/probe-secret', requireAuth, (req, res) => {
  const { probeSecret } = req.body;
  if (!probeSecret || probeSecret.length < 8)
    return res.status(400).json({ error: 'probe_secret must be at least 8 characters' });
  cfg.probeSecret = probeSecret;
  cfg.probeMode = 'secret';          // Bug 81: setting a secret implies secret mode
  saveConfig();
  // Persist to file for install.sh smoke tests
  try {
    fs.writeFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), probeSecret, { mode: 0o600 });
  } catch {}
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const ok = reloadCaddy();
    res.json({ ok, message: 'Probe secret updated. Caddy reloaded.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bug 81: probe_resistance mode toggle ('off' | 'bare' | 'secret').
//   'off'    → remove probe_resistance entirely
//   'bare'   → bare  probe_resistance  (no secret) — matches known-good ref server
//   'secret' → probe_resistance <secret>  (requires an existing/provided secret)
app.post('/api/settings/probe-mode', requireAuth, (req, res) => {
  const { probeMode, probeSecret } = req.body || {};
  const mode = String(probeMode || '').trim().toLowerCase();
  if (!['off', 'bare', 'secret'].includes(mode))
    return res.status(400).json({ error: "probeMode must be one of: off, bare, secret" });

  if (mode === 'secret') {
    // A secret is required — either provided now or already stored.
    const newSecret = (probeSecret || '').trim();
    if (newSecret) {
      if (newSecret.length < 8)
        return res.status(400).json({ error: 'probe_secret must be at least 8 characters' });
      cfg.probeSecret = newSecret;
      try {
        fs.writeFileSync(path.join(resolvedCaddyCfgDir, 'probe_secret'), newSecret, { mode: 0o600 });
      } catch {}
    } else if (!(cfg.probeSecret || '').trim()) {
      return res.status(400).json({ error: "secret mode requires a probe_secret (>= 8 chars)" });
    }
  }

  cfg.probeMode = mode;
  saveConfig();
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const ok = reloadCaddy();
    res.json({ ok, probeMode: mode, message: `probe_resistance mode set to '${mode}'. Caddy reloaded.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bug 15: /api/services/rebuild-all — used by update.sh --repair
app.post('/api/services/rebuild-all', requireAuth, (req, res) => {
  try {
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const caddyOk = reloadCaddy();
    const mitaOk  = applyMitaConfig();
    res.json({ ok: true, caddyOk, mitaOk,
      message: 'Caddyfile and mita-state.json rebuilt from database.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v1.2.6: Cascade settings (Variant B) ──────────────────────────────────────
// Naive cascade  → Caddyfile `upstream` (handled by buildCaddyfile).
// Mieru cascade  → Variant B (mieru-client + redsocks + iptables) orchestrated
//                  by scripts/cascade_mieru.sh. The entry mita stays plain.
app.get('/api/settings/cascade', requireAuth, (req, res) => {
  const m = cfg.cascadeMieru || {};
  res.json({
    cascadeEnabled: !!cfg.cascadeEnabled,
    cascadeNaiveUpstream: cfg.cascadeNaiveUpstream || '',
    cascadeMieru: {
      host:      m.host || '',
      portStart: m.portStart || 2012,
      portEnd:   m.portEnd   || 2022,
      user:      m.user || '',
      mtu:       m.mtu || 1400,
      // never return the stored exit password; UI shows a placeholder
      hasPass:   !!m.pass
    }
  });
});

// Live cascade status — Bug 93: diagnose BOTH legs (Naive + Mieru).
app.get('/api/settings/cascade/status', requireAuth, (req, res) => {
  let naiveOut = '';
  try { naiveOut = naiveCascadeStatusText(); }
  catch (e) { naiveOut = '=== NAIVE CASCADE ===\n(error: ' + e.message + ')'; }

  const m = runCascadeMieru('status');
  const mieruOut = '=== MIERU CASCADE (Variant B) ===\n' + (m.output || '(no output)');

  const output = naiveOut + '\n\n' + mieruOut;
  res.json({ ok: m.ok, output });
});

app.post('/api/settings/cascade', requireAuth, (req, res) => {
  const { cascadeEnabled, cascadeNaiveUpstream, cascadeMieru } = req.body;
  const enabled = !!cascadeEnabled;

  // MUTUAL EXCLUSION: enabling the cascade must first fully disable + tear down
  // WARP (only one egress mode active at a time; BUG-150 clean-teardown rule).
  if (enabled && cfg.warpEnabled) {
    cfg.warpEnabled = false;
    try { runWarpEgress('teardown'); } catch {}
  }

  cfg.cascadeEnabled = enabled;
  if (cascadeNaiveUpstream !== undefined) {
    // Bug 92: normalize on store too (defense in depth) — strip "naive+" etc. so
    // the saved config and the generated Caddyfile both carry a clean https:// URL.
    const raw = String(cascadeNaiveUpstream || '').trim();
    cfg.cascadeNaiveUpstream = raw ? normalizeUpstream(raw) : '';
  }

  // Merge Mieru exit settings. A blank password means "keep existing".
  const prev = cfg.cascadeMieru || {};
  if (cascadeMieru !== undefined) {
    const m = cascadeMieru || {};
    cfg.cascadeMieru = {
      host:      String(m.host ?? prev.host ?? '').trim(),
      portStart: parseInt(m.portStart ?? prev.portStart ?? 2012, 10) || 2012,
      portEnd:   parseInt(m.portEnd   ?? prev.portEnd   ?? 2022, 10) || 2022,
      user:      String(m.user ?? prev.user ?? '').trim(),
      pass:      (m.pass !== undefined && String(m.pass).length > 0)
                   ? String(m.pass)
                   : (prev.pass || ''),
      // Bug 95: mtu must match the exit (mita). Default 1400, clamp 1280-1400.
      mtu:       (() => {
                   const v = parseInt(m.mtu ?? prev.mtu ?? cfg.mtu ?? 1400, 10) || 1400;
                   return (v < 1280 || v > 1400) ? 1400 : v;
                 })()
    };
  }
  saveConfig();

  try {
    // 1) Naive leg — rebuild Caddyfile (upstream applied when enabled).
    // Bug 90: writeCaddyfileAtomic chowns root:caddy.
    // Bug 91: applyCaddyConfig does a full restart + is-active verify and
    //         returns the real error (no more silent reload masking failures).
    const content = buildCaddyfile(cfg, getAllUsers());
    writeCaddyfileAtomic(content);
    const caddyRes = applyCaddyConfig();
    const caddyOk = caddyRes.ok;

    // 2) Mieru leg — Variant B orchestration.
    let cascadeOk = true, cascadeOut = '';
    const m = cfg.cascadeMieru || {};
    const hasMieruExit = enabled && m.host && m.user && m.pass;
    if (hasMieruExit) {
      const r = runCascadeMieru('setup', {
        host: m.host, portStart: m.portStart, portEnd: m.portEnd,
        user: m.user, pass: m.pass, mtu: m.mtu
      });
      cascadeOk = r.ok; cascadeOut = r.output;
    } else {
      // Cascade disabled (or no Mieru exit configured) → ensure relay is down.
      const r = runCascadeMieru('teardown');
      cascadeOk = r.ok; cascadeOut = r.output;
    }

    // Entry mita stays a plain server in Variant B — just re-apply its config.
    const mitaOk = applyMitaConfig();

    res.json({
      ok: caddyOk && cascadeOk,
      caddyOk, mitaOk, cascadeOk,
      // Bug 91: surface the real caddy-naive error to the UI on failure.
      caddyError: caddyOk ? '' : (caddyRes.error || ''),
      cascadeOutput: cascadeOut,
      message: enabled
        ? (hasMieruExit
            ? 'Cascade enabled. Naive upstream + Mieru relay (Variant B) applied.'
            : 'Cascade enabled for Naive only (no Mieru exit configured).')
        : 'Cascade disabled. Relay torn down.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Доработка 1 / Bug 150: explicit "Reset cascade" — one atomic, idempotent
// operation that returns the server to its exact pre-cascade state across EVERY
// layer, independent of the enable checkbox:
//   • UI/config state  : cascadeEnabled=false, clear Naive upstream + Mieru exit
//   • Caddyfile        : rebuilt with NO upstream (Naive leg back to direct)
//   • Network          : full Variant-B teardown (iptables/redsocks/mieru-client/
//                        watchdog/redsocks.conf) via cascade_mieru.sh teardown
//   • mita             : rebuilt from DB with the NATIVE users (Bug 151) and
//                        reset-failed + (re)started, or left idle if no keys
// Running it twice is safe (every step tolerates "already clean").
app.post('/api/settings/cascade/reset', requireAuth, (req, res) => {
  try {
    // 1) Wipe cascade state from config so nothing re-applies it on next boot.
    cfg.cascadeEnabled       = false;
    cfg.cascadeNaiveUpstream = '';
    const prevMieru = cfg.cascadeMieru || {};
    cfg.cascadeMieru = {
      host: '', portStart: prevMieru.portStart || 2012,
      portEnd: prevMieru.portEnd || 2022, user: '', pass: '',
      mtu: prevMieru.mtu || cfg.mtu || 1400
    };
    // Drop any legacy Variant-A native egress too.
    cfg.cascadeMieruEgress = {};
    saveConfig();

    // 2) Naive leg → Caddyfile with no upstream (back to direct).
    let caddyOk = false, caddyError = '';
    try {
      const content = buildCaddyfile(cfg, getAllUsers());
      writeCaddyfileAtomic(content);
      const r = applyCaddyConfig();
      caddyOk = r.ok; caddyError = r.ok ? '' : (r.error || '');
    } catch (e) { caddyError = e.message; }

    // 3) Mieru leg → full Variant-B teardown (idempotent).
    const td = runCascadeMieru('teardown');

    // 4) Entry mita → rebuild from DB with native users (Bug 151) + (re)start,
    //    or stay idle on an empty base.
    const mitaOk = applyMitaConfig();

    // 5) Report native egress so the operator sees egress=RU immediately.
    let egress = '';
    try {
      egress = execSync(
        "curl -s --max-time 8 https://api.ipify.org 2>/dev/null",
        { timeout: 10000 }
      ).toString().trim();
    } catch { egress = ''; }

    res.json({
      ok: caddyOk && td.ok,
      caddyOk, mitaOk, teardownOk: td.ok, caddyError,
      cascadeOutput: td.output || '',
      nativeEgress: egress || '(unknown)',
      message: 'Каскад полностью сброшен: конфиг очищен, Caddy без upstream, '
             + 'relay снят (iptables/redsocks/mieru-client/watchdog), '
             + 'mita пересобрана с родными ключами.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cloudflare WARP egress (server-wide) ─────────────────────────────────────
// Exactly one egress mode is active: native IP / Mieru cascade / WARP. WARP and
// cascade are MUTUALLY EXCLUSIVE — enabling WARP force-disables the cascade (and
// tears its relay down), and the cascade endpoints likewise disable WARP. The
// UI also blocks enabling both, but the server enforces it as the source of truth.

// Current WARP settings + a low-RAM advisory.
app.get('/api/settings/warp', requireAuth, (req, res) => {
  const ram = totalRamMB();
  res.json({
    warpEnabled:    !!cfg.warpEnabled,
    warpPersist:    !!cfg.warpPersist,
    cascadeEnabled: !!cfg.cascadeEnabled,   // so the UI can show the lockout
    ramMB:          ram,
    // The extra WireGuard layer adds memory/CPU pressure on tiny VPS.
    lowRam:         ram > 0 && ram <= 1024,
    lowRamWarning:  (ram > 0 && ram <= 1024)
      ? 'На VPS с ≤1 ГБ RAM дополнительный сетевой слой WARP (WireGuard) нагружает память — включайте только при необходимости.'
      : ''
  });
});

// Live WARP status incl. the measured public egress IP (should be Cloudflare).
app.get('/api/settings/warp/status', requireAuth, (req, res) => {
  const r = runWarpEgress('status');
  res.json({ ok: r.ok, enabled: !!cfg.warpEnabled, output: r.output });
});

// Toggle WARP egress on/off.
app.post('/api/settings/warp', requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.warpEnabled);

  // MUTUAL EXCLUSION: enabling WARP must first fully disable + tear down the
  // Mieru cascade (BUG-150 lesson: a clean teardown, no leftover routes).
  let cascadeTorn = false, cascadeOut = '';
  if (enabled && cfg.cascadeEnabled) {
    cfg.cascadeEnabled       = false;
    cfg.cascadeNaiveUpstream = '';
    const prevMieru = cfg.cascadeMieru || {};
    cfg.cascadeMieru = {
      host: '', portStart: prevMieru.portStart || 2012,
      portEnd: prevMieru.portEnd || 2022, user: '', pass: '',
      mtu: prevMieru.mtu || cfg.mtu || 1400
    };
    cfg.cascadeMieruEgress = {};
    // Naive leg back to direct (no upstream) + Mieru relay torn down.
    try {
      const content = buildCaddyfile(cfg, getAllUsers());
      writeCaddyfileAtomic(content);
      applyCaddyConfig();
    } catch {}
    const td = runCascadeMieru('teardown');
    cascadeTorn = td.ok; cascadeOut = td.output;
    try { applyMitaConfig(); } catch {}
  }

  // BUG-162: boot-persistence (autostart) only when the operator EXPLICITLY
  //   opts in via `persist: true`. Default = NOT persistent, so a faulty tunnel
  //   can never silently re-down the box on reboot — a restart restores access.
  const persist = !!(req.body && req.body.persist);
  cfg.warpEnabled = enabled;
  cfg.warpPersist = enabled ? persist : false;
  saveConfig();

  // Apply the WARP layer (passing the management ports + persist flag).
  const r = enabled
    ? runWarpEgress('setup', { persist })
    : runWarpEgress('teardown');

  // BUG-168: classify the outcome so the UI can show a friendly explanation.
  const wr = parseWarpResult(r.output);

  // If WARP was requested but the script rolled back (blocked / no handshake),
  //   the tunnel is DOWN — reflect that in config so the panel state is honest.
  const rolledBack = enabled && (!r.ok || wr.code === 'blocked_return' || wr.code === 'no_handshake');
  if (rolledBack) {
    cfg.warpEnabled = false;
    cfg.warpPersist = false;
    saveConfig();
  }

  // Report the egress IP so the operator can confirm it changed to Cloudflare.
  let egress = wr.egressIP || '';
  if (!egress) {
    try { egress = execSync('curl -s --max-time 8 https://api.ipify.org 2>/dev/null', { timeout: 10000 }).toString().trim(); }
    catch { egress = ''; }
  }

  // BUG-168: build a classified result {severity, code, message} for the panel.
  //   severity: 'success' (green) | 'warning' (yellow, NOT a panel error).
  const fmtBytes = (n) => (n == null ? '?' : (n >= 1024 ? (n / 1024).toFixed(1) + ' KiB' : n + ' B'));
  let warpResult;
  if (!enabled) {
    warpResult = { severity: 'success', code: 'disabled',
      message: 'WARP выключен. Возврат к родному IP сервера.' };
  } else if (wr.code === 'ok' || (r.ok && !rolledBack)) {
    warpResult = { severity: 'success', code: 'ok', egressIP: egress || '(unknown)',
      message: (cascadeTorn
        ? `WARP включён — egress теперь через Cloudflare (IP ${egress || '?'}). Каскад был автоматически отключён. SSH и панель доступны напрямую.`
        : (persist
            ? `WARP включён и добавлен в автозагрузку — egress через Cloudflare (IP ${egress || '?'}). В туннель идёт только исходящий прокси-трафик; SSH и панель доступны напрямую.`
            : `WARP включён — egress через Cloudflare (IP ${egress || '?'}). В туннель идёт только исходящий прокси-трафик; SSH и панель доступны напрямую. Автозагрузка ВЫКЛЮЧЕНА (после ребута WARP не поднимется автоматически).`)) };
  } else if (wr.code === 'blocked_return') {
    // Handshake OK but no return traffic → the HOSTING PROVIDER blocks WARP.
    warpResult = { severity: 'warning', code: 'blocked_return',
      message: 'WARP не удалось включить: ваш хостинг-провайдер блокирует входящий трафик Cloudflare WARP (WireGuard/UDP). '
        + 'Это ограничение сервера, не панели. Всё откачено, доступ к серверу сохранён, текущая работа не нарушена. '
        + 'Если нужен WARP — смените хостера на не блокирующего WireGuard, либо используйте каскад (chain). '
        + `(Туннель отправил ${fmtBytes(wr.tx)}, получил ${fmtBytes(wr.rx)} — обратный трафик заблокирован.)` };
  } else if (wr.code === 'no_handshake') {
    warpResult = { severity: 'warning', code: 'no_handshake',
      message: 'WARP не смог подключиться к Cloudflare ни на одном порту (2408/500/1701/4500). '
        + 'Вероятно, провайдер режет UDP. Всё откачено, доступ сохранён. Попробуйте другой сервер или каскад.' };
  } else {
    // Unknown failure — surface a safe generic message; rollback already ran.
    warpResult = { severity: 'warning', code: 'unknown',
      message: 'WARP включить не удалось. Всё откачено, доступ к серверу сохранён. '
        + 'Подробности в технических логах ниже.' };
  }

  res.json({
    ok: enabled ? (!rolledBack) : r.ok,
    warpEnabled: cfg.warpEnabled,
    warpPersist: cfg.warpPersist,
    rolledBack: rolledBack || undefined,
    cascadeDisabled: cascadeTorn || undefined,
    cascadeOutput: cascadeOut || undefined,
    egressIP: egress || '(unknown)',
    output: r.output,
    warpResult,                       // BUG-168: classified {severity, code, message}
    message: warpResult.message       // back-compat: plain message string
  });
});

// Explicit idempotent WARP reset — full teardown regardless of the toggle.
app.post('/api/settings/warp/reset', requireAuth, (req, res) => {
  cfg.warpEnabled = false;
  saveConfig();
  const r = runWarpEgress('teardown');
  let egress = '';
  try { egress = execSync('curl -s --max-time 8 https://api.ipify.org 2>/dev/null', { timeout: 10000 }).toString().trim(); }
  catch { egress = ''; }
  res.json({
    ok: r.ok, warpEnabled: false,
    nativeEgress: egress || '(unknown)',
    output: r.output,
    message: 'WARP полностью снят: интерфейс/маршруты/правила удалены, возврат к родному IP.'
  });
});

// ── Client configs ────────────────────────────────────────────────────────────

// Naive link (used with caddy-forwardproxy)
app.get('/api/users/:id/config/naive', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  // naive+https:// link for caddy-forwardproxy-naive
  const link = `naive+https://${user.username}:${encodeURIComponent(password)}@${cfg.domain}:${cfg.naivePort}`;
  res.json({ link, username: user.username });
});

// Bug 5: transport field (not protocol); Bug 12: server_ports array
// P3 (selectable mieru port): validate a requested port against the configured
//   range. mita listens on the WHOLE range (portRange "start-end"), so any port
//   inside [start,end] is valid for the client to dial. Returns `start` when the
//   request is absent, non-numeric, or outside the range.
function pickMieruPort(requested, start, end) {
  const p = parseInt(requested, 10);
  if (Number.isInteger(p) && p >= start && p <= end) return p;
  return start;
}

app.get('/api/users/:id/config/mieru', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';

  // Build server_ports array (Bug 12)
  // Bug 70: mieruPortStart/End may be strings or undefined; parseInt prevents
  // an infinite for-loop when NaN comparisons silently return false
  const _portStart70a = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _portEnd70a   = parseInt(cfg.mieruPortEnd,   10) || 2010;
  const serverPorts = [];
  for (let p = _portStart70a; p <= _portEnd70a; p++) {
    serverPorts.push(p);
  }
  // P3 (selectable port): allow the client to pick which port from the
  //   configured mieru range is written into server_port. Falls back to the
  //   range start when ?port= is absent or out of range.
  const mieruPort = pickMieruPort(req.query.port, _portStart70a, _portEnd70a);

  // Bug 74: align mieru outbound with the field-tested working client format
  // (Karing / sing-box mieru):
  //   - use `multiplexing: "MULTIPLEXING_HIGH"` (string enum), NOT
  //     `multiplex: { enabled: false }` (that object form is for other
  //     protocols' stream multiplexing and silently breaks the mieru parser);
  //   - use a single `server_port` (the working config does NOT send a
  //     `server_ports` array — sending both confuses the client);
  //   - prefer the raw server IP (mieru is IP-based, no SNI/TLS).
  const singboxCfg = {
    log: { level: 'info' },
    dns: {
      servers: [
        { tag: 'google', address: '8.8.8.8' },
        { tag: 'local',  address: '1.1.1.1', detour: 'direct' }
      ]
    },
    outbounds: [
      {
        type: 'mieru', tag: 'mieru-out',
        server: cfg.serverIp || cfg.domain,
        server_port: mieruPort,
        // Bug 5: transport field (TCP/UDP) — not protocol
        transport: 'TCP',
        username: user.username, password,
        // Bug 74: string enum, not an object
        multiplexing: 'MULTIPLEXING_HIGH'
      },
      { type: 'direct', tag: 'direct' }
    ],
    route: { final: 'mieru-out' }
  };
  // Keep the full port range available for clients/tooling that want it.
  void serverPorts;
  const filename = `mieru-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(singboxCfg);
});

// ── Mieru share-link (mierus://) — for routers (Keenetic / OpenWRT) ───────────
// Feature request: export Mieru not only as a sing-box JSON file but as a single
// copy-paste share link, like the Naive link. The canonical mieru share-link
// (as consumed by e.g. hoaxisr/awg-manager and the reference mieru client) is:
//
//   mierus://<user>:<pass>@<host>?profile=<name>&port=<p>&protocol=<TCP|UDP>[&port=&protocol=…][&multiplexing=<LEVEL>]
//
// Round-trip rules that matter for real router parsers:
//   • scheme is `mierus` (the plain-text share form; `mieru://` is base64 proto);
//   • username AND password are both mandatory (userinfo);
//   • `profile` is mandatory (we use "default");
//   • EACH port gets its OWN paired `protocol` (awg-manager issue #516: a single
//     `protocol` for several `port`s used to be rejected — pairing is the safe,
//     canonical shape that imports back cleanly);
//   • host is the raw server IP (mieru is IP-based, no SNI/TLS);
//   • userinfo + query values are percent-encoded so odd passwords stay valid.
function buildMierusLink({ username, password, host, ports, transport, multiplexing }) {
  const enc = encodeURIComponent;
  const userinfo = `${enc(username)}:${enc(password)}`;
  const parts = [`profile=default`];
  for (const p of ports) {
    parts.push(`port=${enc(String(p))}`);
    parts.push(`protocol=${enc(transport || 'TCP')}`);
  }
  if (multiplexing) parts.push(`multiplexing=${enc(multiplexing)}`);
  return `mierus://${userinfo}@${host}?${parts.join('&')}`;
}

app.get('/api/users/:id/config/mieru-link', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';

  const _ps = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _pe = parseInt(cfg.mieruPortEnd,   10) || 2010;
  // Default: a single port (matches the JSON's server_port and the simple router
  // form). ?range=1 emits every port in the configured range (mita listens on
  // the whole range), each paired with its protocol — still canonical.
  const wantRange = String(req.query.range || '') === '1';
  const ports = wantRange
    ? Array.from({ length: Math.max(0, _pe - _ps + 1) }, (_, i) => _ps + i)
    : [pickMieruPort(req.query.port, _ps, _pe)];

  const link = buildMierusLink({
    username: user.username,
    password,
    host: cfg.serverIp || cfg.domain,
    ports,
    transport: 'TCP',
    multiplexing: 'MULTIPLEXING_HIGH'
  });
  res.json({ link, username: user.username });
});

// Hy2 (Hysteria2) share link. Canonical form consumed by NekoBox/Karing/
// Shadowrocket/Streisand:
//   hysteria2://user:pass@domain:port?sni=domain&insecure=0#user
// Host is the DOMAIN (Hy2 uses real TLS SNI + a shared Caddy cert), port is the
// configurable cfg.hy2Port (default 443/udp). We percent-encode userinfo so odd
// passwords stay valid; `insecure=0` because the cert is a real trusted one.
function buildHy2Link({ username, password, domain, port }) {
  const enc = encodeURIComponent;
  const userinfo = `${enc(username)}:${enc(password)}`;
  const q = `sni=${enc(domain)}&insecure=0`;
  return `hysteria2://${userinfo}@${domain}:${port}?${q}#${enc(username)}`;
}

// ── Naive share-link (naive+https://) ────────────────────────────────────────
// Extracted so both the single-link route and the subscription builder share
// ONE canonical form. Matches the caddy-forwardproxy-naive client key.
// NOTE: this `naive+https://` form is what Karing/sing-box-family clients want,
// and it is also what the config-modal single-link button hands to the user.
// Shadowrocket does NOT parse `naive+https://` from a subscription — see
// buildShadowrocketHttpsLink() below for the form Shadowrocket actually eats.
function buildNaiveLink({ username, password, domain, port }) {
  const enc = encodeURIComponent;
  return `naive+https://${username}:${enc(password)}@${domain}:${port}`;
}

// ── v1.8.8: Shadowrocket-native Naive URI (HTTPS proxy scheme) ────────────────
// Field test (v1.8.7) proved Shadowrocket silently DROPS `naive+https://` lines
// from a subscription — so Naive never appeared, while Mieru/Hy2 did.
//
// Naive is, on the wire, just an HTTP CONNECT proxy tunnelled over TLS. That is
// exactly Shadowrocket's built-in "HTTPS" proxy type (shown in the UI as
// `HTTPS / AUTO`). Shadowrocket's subscription URI for an HTTPS proxy is:
//
//     https://<urlSafeBase64( username:password@host:port )>?remarks=<name>
//
// (Confirmed against the canonical subconverter `explodeHTTPSub` parser: it
// strips the scheme, url-safe-base64-decodes the remainder, then regex-matches
// `user:pass@host:port`; the `https://` scheme flags TLS on.) The `#name`
// fragment is NOT used by that path — the label comes from `?remarks=`.
function buildShadowrocketHttpsLink({ username, password, domain, port, name }) {
  const creds  = `${username}:${password}@${domain}:${port}`;
  // URL-safe base64, no padding — matches urlSafeBase64Decode() expectations.
  const b64    = Buffer.from(creds, 'utf8').toString('base64')
                   .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const remark = encodeURIComponent(name || username);
  return `https://${b64}?remarks=${remark}`;
}

// ── v1.8.7: shared per-user URI list for the subscription feature ─────────────
// Returns the list of client URI strings for exactly the protocols the user has
// enabled (respects the shared-pool checkboxes). This is the SINGLE source of
// truth for both:
//   • the base64 URI subscription (Shadowrocket / v2ray-style clients)
//   • the config modal single-link buttons (indirectly, via the same builders)
//
// `opts.client` (optional) lets a caller drop protocols a given client can't
// consume. NOTE (per field test on real devices, v1.8.7): Shadowrocket DOES
// support Mieru via the `mierus://` URI — so we do NOT filter Mieru for it.
// Karing consumes Mieru only via sing-box JSON (handled separately), so the
// Karing path uses buildSingboxConfig(), NOT this URI list.
function buildUserUris(user, opts = {}) {
  const protos   = parseUserRow(user).protocols || [];
  const password = opts.password || user.password || 'YOUR_PASSWORD';
  const uris = [];

  const _ps = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _pe = parseInt(cfg.mieruPortEnd,   10) || 2010;
  const mieruPort = pickMieruPort(opts.port, _ps, _pe);

  if (protos.includes('naive')) {
    // v1.8.8: this URI list feeds the base64 subscription consumed by
    // Shadowrocket / v2ray-style clients. Shadowrocket ignores `naive+https://`,
    // so emit its native HTTPS-proxy scheme instead (Naive == HTTP CONNECT over
    // TLS). Karing does NOT use this list — it gets Naive as a JSON outbound via
    // buildSingboxConfig(), which still uses buildNaiveLink()'s server key.
    uris.push(buildShadowrocketHttpsLink({
      username: user.username, password,
      domain: cfg.domain, port: cfg.naivePort,
      name: user.username
    }));
  }
  if (protos.includes('mieru')) {
    uris.push(buildMierusLink({
      username: user.username, password,
      host: cfg.serverIp || cfg.domain,
      ports: [mieruPort], transport: 'TCP',
      multiplexing: 'MULTIPLEXING_HIGH'
    }));
  }
  if (protos.includes('hy2') && cfg.stack && cfg.stack.hy2) {
    uris.push(buildHy2Link({
      username: user.username, password,
      domain: cfg.domain, port: parseInt(cfg.hy2Port, 10) || 443
    }));
  }
  return uris;
}

// v1.9.0: return the list of ENABLED bonus-link URL strings for a user, in
// stored order, ready to be pushed onto the subscription URI list. Disabled
// entries are skipped; a user with no bonuses returns []. Strings are returned
// AS-IS (no validation / no mutation) — the admin owns their correctness.
function enabledBonusUrls(user) {
  return normalizeBonusLinks(user && user.bonus_links)
    .filter(b => b.enabled)
    .map(b => b.url);
}

// ── v1.9.2: bonus URI → sing-box outbound ─────────────────────────────────────
// The base64 subscription (Shadowrocket / v2ray) already appends the admin's
// personal bonus links verbatim. But the sing-box-family clients (Karing,
// NekoBox, Exclave, Throne) consume JSON outbounds, not a URI list, so those
// bonus links were previously INVISIBLE to them. This parser converts the most
// common bonus schemes into sing-box outbound objects so they show up for
// sing-box clients too. Anything it can't parse (unknown scheme, malformed URL)
// returns null and is SILENTLY SKIPPED — a bad bonus link must never break the
// whole JSON. `tag` guarantees a unique, JSON-safe outbound name.
//
// Supported: vless:// vmess:// trojan:// ss:// (SIP002) hysteria2://|hy2://
// The admin owns correctness of the link; we only translate structure, we do
// not validate that the remote actually works.
function bonusUrlToSingboxOutbound(rawUrl, tag) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;
  const safeTag = String(tag || 'bonus');

  try {
    // ── VLESS ── vless://<uuid>@host:port?params#name
    if (url.startsWith('vless://')) {
      const u = new URL(url);
      const port = parseInt(u.port, 10);
      if (!u.username || !u.hostname || !port) return null;
      const q = u.searchParams;
      const security = (q.get('security') || 'none').toLowerCase();
      const out = {
        type: 'vless', tag: safeTag,
        server: u.hostname, server_port: port,
        uuid: decodeURIComponent(u.username),
        flow: q.get('flow') || undefined
      };
      if (security === 'tls' || security === 'reality') {
        out.tls = { enabled: true, server_name: q.get('sni') || q.get('host') || u.hostname };
        if (q.get('fp')) out.tls.utls = { enabled: true, fingerprint: q.get('fp') };
        if (security === 'reality') {
          out.tls.reality = { enabled: true, public_key: q.get('pbk') || '', short_id: q.get('sid') || '' };
        }
      }
      const type = (q.get('type') || 'tcp').toLowerCase();
      if (type === 'ws')   out.transport = { type: 'ws',   path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : undefined };
      if (type === 'grpc') out.transport = { type: 'grpc', service_name: q.get('serviceName') || '' };
      return out;
    }

    // ── Trojan ── trojan://<password>@host:port?params#name
    if (url.startsWith('trojan://')) {
      const u = new URL(url);
      const port = parseInt(u.port, 10);
      if (!u.username || !u.hostname || !port) return null;
      const q = u.searchParams;
      const out = {
        type: 'trojan', tag: safeTag,
        server: u.hostname, server_port: port,
        password: decodeURIComponent(u.username),
        tls: { enabled: true, server_name: q.get('sni') || q.get('host') || u.hostname }
      };
      const type = (q.get('type') || 'tcp').toLowerCase();
      if (type === 'ws')   out.transport = { type: 'ws',   path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : undefined };
      if (type === 'grpc') out.transport = { type: 'grpc', service_name: q.get('serviceName') || '' };
      return out;
    }

    // ── Hysteria2 ── hysteria2://|hy2://<auth>@host:port?params#name
    if (url.startsWith('hysteria2://') || url.startsWith('hy2://')) {
      const u = new URL(url.replace(/^hy2:\/\//, 'hysteria2://'));
      const port = parseInt(u.port, 10);
      if (!u.hostname || !port) return null;
      const q = u.searchParams;
      return {
        type: 'hysteria2', tag: safeTag,
        server: u.hostname, server_port: port,
        password: decodeURIComponent(u.username || u.password || ''),
        tls: { enabled: true, server_name: q.get('sni') || u.hostname,
               insecure: q.get('insecure') === '1' || q.get('insecure') === 'true' }
      };
    }

    // ── Shadowsocks ── ss://base64(method:pass)@host:port#name  (SIP002)
    if (url.startsWith('ss://')) {
      const u = new URL(url);
      const port = parseInt(u.port, 10);
      if (!u.hostname || !port) return null;
      let method = '', pass = '';
      if (u.username && !u.password) {
        // userinfo is base64(method:password)
        const dec = Buffer.from(decodeURIComponent(u.username), 'base64').toString('utf8');
        const i = dec.indexOf(':');
        if (i < 0) return null;
        method = dec.slice(0, i); pass = dec.slice(i + 1);
      } else {
        method = decodeURIComponent(u.username || '');
        pass   = decodeURIComponent(u.password || '');
      }
      if (!method || !pass) return null;
      return { type: 'shadowsocks', tag: safeTag,
               server: u.hostname, server_port: port, method, password: pass };
    }

    // ── VMess ── vmess://base64(json)
    if (url.startsWith('vmess://')) {
      const b64 = url.slice('vmess://'.length).trim();
      const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const port = parseInt(json.port, 10);
      if (!json.add || !json.id || !port) return null;
      const out = {
        type: 'vmess', tag: safeTag,
        server: json.add, server_port: port,
        uuid: json.id, security: 'auto',
        alter_id: parseInt(json.aid, 10) || 0
      };
      if ((json.tls || '').toLowerCase() === 'tls')
        out.tls = { enabled: true, server_name: json.sni || json.host || json.add };
      const net = (json.net || 'tcp').toLowerCase();
      if (net === 'ws')   out.transport = { type: 'ws',   path: json.path || '/', headers: json.host ? { Host: json.host } : undefined };
      if (net === 'grpc') out.transport = { type: 'grpc', service_name: json.path || '' };
      return out;
    }
  } catch { /* malformed → skip */ }

  return null; // unknown scheme → silently skipped
}

// ── v1.8.7: sing-box JSON builder (universal download + Karing subscription) ──
// Builds a complete sing-box config containing an outbound for EACH protocol
// the user has enabled (naive / mieru / hy2). The urltest selector is built
// dynamically from the enabled tags. This is what fixes "Hy2 missing from the
// universal config" AND powers the Karing subscription (which needs Mieru as a
// JSON outbound, not a URI).
function buildSingboxConfig(user, opts = {}) {
  const protos   = parseUserRow(user).protocols || [];
  const password = opts.password || user.password || 'YOUR_PASSWORD';

  const _ps = parseInt(cfg.mieruPortStart, 10) || 2000;
  const _pe = parseInt(cfg.mieruPortEnd,   10) || 2010;
  const mieruPort = pickMieruPort(opts.port, _ps, _pe);

  const proxyOutbounds = [];
  const selectTags     = [];

  if (protos.includes('naive')) {
    selectTags.push('naive-out');
    proxyOutbounds.push({
      type: 'naive', tag: 'naive-out',
      server: cfg.domain, server_port: cfg.naivePort,
      username: user.username, password,
      quic: false,
      tls: { enabled: true, server_name: cfg.domain }
    });
  }
  if (protos.includes('mieru')) {
    selectTags.push('mieru-out');
    proxyOutbounds.push({
      type: 'mieru', tag: 'mieru-out',
      server: cfg.serverIp || cfg.domain,
      server_port: mieruPort,
      transport: 'TCP',
      username: user.username, password,
      multiplexing: 'MULTIPLEXING_HIGH'
    });
  }
  if (protos.includes('hy2') && cfg.stack && cfg.stack.hy2) {
    selectTags.push('hy2-out');
    proxyOutbounds.push({
      // sing-box Hysteria2 outbound. Host is the DOMAIN (real TLS SNI + shared
      // Caddy cert); server_name pins SNI.
      //
      // v1.8.8 FIX (Karing red-triangle / Hy2 not connecting): the hysteria2
      // server runs with `auth.type: userpass` (see install_hysteria.sh), so the
      // real wire password is the pair `<username>:<password>`. The official
      // Hysteria2 client accepts a `userpass` alias, but sing-box does NOT — its
      // hysteria2 outbound has only a single `password` field. Therefore we must
      // hand sing-box the combined `username:password` string as the password,
      // otherwise auth fails and Karing shows the red warning triangle.
      type: 'hysteria2', tag: 'hy2-out',
      server: cfg.domain, server_port: parseInt(cfg.hy2Port, 10) || 443,
      password: `${user.username}:${password}`,
      tls: { enabled: true, server_name: cfg.domain, insecure: false }
    });
  }

  // v1.9.2: the admin's personal bonus links must reach sing-box-family clients
  // (Karing / NekoBox / Exclave / Throne) too — not just the base64 URI list.
  // Convert each ENABLED bonus URI into a sing-box outbound; unparseable ones
  // are silently skipped so a single bad link can never break the JSON. Tags
  // are made unique (bonus-1, bonus-2, …) and added to the urltest selector so
  // the client can actually pick them.
  const bonusUrls = enabledBonusUrls(user);
  for (let i = 0; i < bonusUrls.length; i++) {
    const ob = bonusUrlToSingboxOutbound(bonusUrls[i], `bonus-${i + 1}`);
    if (ob) { proxyOutbounds.push(ob); selectTags.push(ob.tag); }
  }

  // Fallback: if the user somehow has no proxy protocols enabled, keep the
  // config valid (direct only) rather than emitting a broken urltest.
  const hasProxies = proxyOutbounds.length > 0;

  const outbounds = [];
  if (hasProxies) {
    outbounds.push({
      type: 'urltest', tag: 'select',
      outbounds: selectTags,
      url: 'https://www.gstatic.com/generate_204',
      interval: '3m', tolerance: 50
    });
  }
  outbounds.push(...proxyOutbounds);
  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'dns',    tag: 'dns-out' });

  return {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: 'tls://8.8.8.8',              detour: hasProxies ? 'select' : 'direct' },
        { tag: 'local',  address: 'https://223.5.5.5/dns-query', detour: 'direct' }
      ],
      rules:  [{ outbound: 'any', server: 'local' }],
      final:  'remote'
    },
    outbounds,
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { geoip: 'cn',     outbound: 'direct'  },
        { geosite: 'cn',   outbound: 'direct'  }
      ],
      final: hasProxies ? 'select' : 'direct',
      auto_detect_interface: true
    }
  };
}

app.get('/api/users/:id/config/hy2', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Guard: the user must actually have Hy2 enabled in the shared pool.
  const protos = parseUserRow(user).protocols || [];
  if (!protos.includes('hy2'))
    return res.status(409).json({ error: 'User does not have the hy2 protocol enabled' });
  const password = req.query.password || user.password || 'YOUR_PASSWORD';
  const port = parseInt(cfg.hy2Port, 10) || 443;
  const link = buildHy2Link({
    username: user.username,
    password,
    domain: cfg.domain,
    port
  });
  res.json({ link, username: user.username });
});

app.get('/api/users/:id/config/universal', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // v1.8.7: delegate to the shared sing-box builder. This now adds a Hy2
  // outbound (was previously MISSING — the universal config only ever had
  // naive+mieru) AND respects the user's enabled-protocol checkboxes instead of
  // hard-coding both. The urltest selector is built from the enabled tags.
  const universalCfg = buildSingboxConfig(user, {
    password: req.query.password,
    port: req.query.port
  });
  const filename = `universal-${user.username}-${cfg.domain}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(universalCfg);
});

// Back-compat aliases
app.get('/api/users/:id/naive-link', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/naive${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/mieru-config', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/mieru${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});
app.get('/api/users/:id/universal-config', requireAuth, (req, res) => {
  res.redirect(307, `/api/users/${req.params.id}/config/universal${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// v1.8.7: PUBLIC SUBSCRIPTION LINK  —  GET /sub/:token
// ══════════════════════════════════════════════════════════════════════════════
// One "smart" URL the admin hands to a client. The client pastes it into their
// app and it auto-pulls every protocol the user has enabled (2 or 3 configs,
// per the checkboxes). NO admin login — auth is the unguessable 128-bit token.
//
// Client auto-detection (by User-Agent), overridable with ?client=:
//   • Shadowrocket / v2ray-style / unknown → base64 list of URI strings
//     (naive+https:// , mierus:// , hysteria2://). Shadowrocket parses ALL of
//     these, including Mieru (confirmed on a real device).
//   • Karing / sing-box → full sing-box JSON (Karing needs Mieru as a JSON
//     outbound, not a URI). ?format=singbox forces this for any client.
//
// Response headers (both formats):
//   • Subscription-Userinfo: upload=…; download=…; total=…; expire=…
//       → clients show remaining traffic + key expiry. total=0 ⇒ unlimited.
//   • Profile-Update-Interval: 24  → hint clients to refresh once a day.
// The body is generated LIVE on every request, so toggling a protocol checkbox
// or changing the password/ports is reflected the next time the client refreshes
// — no re-issuing, no manual JSON downloads.
//
// Rate-limited independently (public endpoint) to blunt token brute-forcing.
const subLimiter = rateLimit({ windowMs: 60 * 1000, max: 60,
  message: 'Rate limit exceeded' });

// v1.9.2: the sing-box FAMILY of clients. Karing, NekoBox (android), Exclave
// (android) and Throne are all sing-box-engine clients and consume the same
// sing-box JSON we already build for Karing. We collapse them all onto the
// 'karing' branch so there is exactly ONE JSON code path to maintain. Notes
// gathered 19.08.2026:
//   • NekoBox  — sing-box outbounds (also parses ClashMeta + v2ray base64).
//   • Exclave  — sing-box/mihomo-compatible: mieru v3, Hysteria2 and VLESS are
//                native; NaiveProxy needs a standalone plugin. If the plugin is
//                absent only the naive outbound fails to start — mieru/hy2/vless
//                still work, so the JSON stays useful (soft degradation).
//   • Throne   — sing-box outbounds (also base64-subscription).
// Shadowrocket + anything unknown stay on the base64 URI list (safe default).
const SINGBOX_FAMILY_UA = ['karing', 'sing-box', 'singbox', 'nekobox', 'exclave', 'throne'];

function detectSubClient(req) {
  // Manual force via ?client= (handy for support/testing). Every sing-box-family
  // name maps to the same 'karing' JSON branch. ?format=singbox also forces it.
  const forced = String(req.query.client || '').trim().toLowerCase();
  if (forced === 'shadowrocket' || forced === 'sr')      return 'shadowrocket';
  if (forced === 'karing' || forced === 'singbox' || forced === 'sing-box' ||
      forced === 'nekobox' || forced === 'exclave' || forced === 'throne')
    return 'karing';
  if (String(req.query.format || '').toLowerCase() === 'singbox') return 'karing';
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (SINGBOX_FAMILY_UA.some(name => ua.includes(name))) return 'karing';
  if (ua.includes('shadowrocket')) return 'shadowrocket';
  // Safe default: base64 URI list — the widest-compatibility format.
  return 'shadowrocket';
}

// Build the Subscription-Userinfo header value from the user's quota/usage/expiry.
function buildSubUserinfo(user) {
  const MB = 1024 * 1024;
  const usedBytes  = Math.max(0, Math.round((parseFloat(user.usedMB) || 0) * MB));
  const totalBytes = Math.max(0, Math.round((parseFloat(user.quotaMB) || 0) * MB)); // 0 ⇒ unlimited
  // We don't split upload/download here; report all usage as download so the
  // client's "used" figure is correct. upload=0 keeps the header well-formed.
  let val = `upload=0; download=${usedBytes}; total=${totalBytes}`;
  if (user.expiry) {
    const ts = Date.parse(user.expiry);
    if (!isNaN(ts)) val += `; expire=${Math.floor(ts / 1000)}`;
  }
  return val;
}

app.get('/sub/:token', subLimiter, (req, res) => {
  const user = getUserBySubToken(req.params.token);
  if (!user) return res.status(404).type('text/plain').send('Not found');

  const client = detectSubClient(req);
  res.setHeader('Profile-Update-Interval', '24');
  res.setHeader('Subscription-Userinfo', buildSubUserinfo(user));
  // A friendly profile title shown by most clients.
  res.setHeader('Content-Disposition',
    `inline; filename="${encodeURIComponent(user.username)}"`);

  if (client === 'karing') {
    // sing-box JSON (Mieru works here as a JSON outbound).
    const singbox = buildSingboxConfig(user, { port: req.query.port });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(JSON.stringify(singbox, null, 2));
  }

  // Default: base64 of the newline-joined URI list (Shadowrocket / v2ray style).
  const uris = buildUserUris(user, { port: req.query.port });
  // v1.9.0: append THIS user's enabled personal bonus links AFTER the standard
  // Naive/Mieru/Hy2 URIs, joined with the same '\n' separator, then base64 the
  // whole thing — exactly the one-point change the feature spec calls for:
  //   lines = [naiveLink, mieruLink, hy2Link, ...bonusLinksOfThisUser]
  //   return base64(lines.join('\n'))
  // When the user has no (enabled) bonuses this array is empty, so `uris` is
  // untouched and the response is byte-for-byte identical to before.
  for (const url of enabledBonusUrls(user)) uris.push(url);
  const body = Buffer.from(uris.join('\n'), 'utf8').toString('base64');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(body);
});

// v1.8.7: admin-only helper — returns the ready-to-share sub URL for a user
// (respecting the optional subBaseUrl setting; falls back to the panel domain).
app.get('/api/users/:id/sub-link', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = user.sub_token;
  if (!token) return res.status(409).json({ error: 'User has no subscription token' });
  const base = subBaseUrl();
  const link = `${base}/sub/${token}`;
  res.json({ link, token, base, username: user.username });
});

// ── v1.9.0: personal bonus links (admin-only, per-user) ─────────────────────
// GET  → the user's current bonus-link list (normalized [{url, enabled}]).
// PUT  → replace the whole list. The body is `{ links: [...] }` where each item
//        may be a raw string or {url, enabled}. NO content/liveness validation —
//        the string is stored AS-IS. Empty list clears the column back to '[]',
//        restoring the byte-identical baseline subscription.
app.get('/api/users/:id/bonus-links', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ links: normalizeBonusLinks(user.bonus_links) });
});

app.put('/api/users/:id/bonus-links', requireAuth, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Accept `{ links: [...] }`; normalizeBonusLinks tolerates strings or objects
  // and drops blank URLs. No url-format validation by design.
  const links = normalizeBonusLinks((req.body && req.body.links) || []);
  const json  = JSON.stringify(links);
  try {
    if (db) {
      db.prepare('UPDATE users SET bonus_links = ?, updatedAt = ? WHERE id = ?')
        .run(json, new Date().toISOString(), user.id);
    } else {
      const mem = memUsers.get(user.id);
      if (mem) { mem.bonus_links = json; mem.updatedAt = new Date().toISOString(); }
    }
  } catch (e) {
    const d = describeDbError(e);
    return res.status(d.status).json({ error: d.error });
  }
  res.json({ links });
});

// ── Monitoring — /api/status ──────────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.osInfo()
    ]);
    const exec_ = cmd => { try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return ''; } };

    // v1.2.3: check caddy-naive service (not legacy naive)
    const caddyActive  = exec_('systemctl is-active caddy-naive') === 'active';
    const caddyVersion = exec_(`${resolvedCaddyBin} version 2>/dev/null | head -1`) ||
                         exec_(`${resolvedCaddyBin} --version 2>/dev/null | head -1`);

    res.json({
      services: {
        naive: {   // kept as 'naive' key for front-end compatibility
          active:  caddyActive,
          version: caddyVersion
        },
        mieru: {
          active:  exec_('systemctl is-active mita') === 'active',
          version: exec_('mita version 2>/dev/null | head -1')
        },
        // Hy2: only report as a service if installed; UI hides the card
        // otherwise. `installed:false` lets the UI show a "Доустановить Hy2".
        hy2: {
          installed: hy2Installed(),
          active:    hy2Installed() && exec_('systemctl is-active hysteria-server') === 'active',
          version:   hy2Installed() ? exec_('/usr/local/bin/hysteria version 2>/dev/null | head -1') : '',
          port:      parseInt(cfg.hy2Port, 10) || 443
        },
        panel: { active: true }
      },
      system: {
        cpuPercent:  Math.round(cpu.currentLoad),
        ramUsedMB:   Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB:  Math.round(mem.total / 1048576),
        diskUsedGB:  disk.length ? Math.round(disk[0].used / 1073741824) : 0,
        diskTotalGB: disk.length ? Math.round(disk[0].size / 1073741824) : 0,
        uptime: Math.floor(process.uptime()),
        os:   osInfo.distro + ' ' + osInfo.release,
        arch: osInfo.arch
      },
      panel:    { userCount: getAllUsers().length, version: readPanelVersion() },
      domain:   cfg.domain,
      serverIp: cfg.serverIp,
      language: cfg.language || 'ru'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User traffic stats
app.get('/api/stats/users', requireAuth, (req, res) => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 8000 }).toString(); } catch { return ''; } };
  // BUG-160 (regression, v1.5.1): in v1.5.0 BOTH the «Naive (МБ)» and
  //   «Mieru (МБ)» columns dropped to 0.0 for every user. Mieru worked before
  //   the v1.5.0 refactor, so the failure was in the COMMON aggregator — if
  //   either source (mita exec OR the Caddy log read) threw, the unguarded
  //   handler 500'd and the UI rendered its 0.0 fallback for BOTH sources.
  //   Fix: isolate each source in its own try/catch so one failing source can
  //   NEVER zero the other, and log the failure so it is diagnosable instead of
  //   silently returning zeros.

  // ── Mieru source (mita get users) — fully isolated ──────────────────────────
  // Bug 78: the real mieru server command is `mita get users` (NOT the
  //   non-existent `mita describe users`, which always returned '' → traffic 0).
  //   Output is a table: User  LastActive  1DayDownload  1DayUpload  30DaysDownload  30DaysUpload
  let live = [];
  try {
    const raw = exec_('mita get users 2>/dev/null');
    live = parseMitaUsers(raw) || [];
  } catch (e) {
    live = [];
    try { console.error('[stats/users] mieru source failed:', e && e.message); } catch {}
  }

  // ── Naive source (Caddy access log) — fully isolated ────────────────────────
  // Bug 97: also account NaiveProxy traffic from the Caddy access log so
  //   naive-only users no longer show 0.0. Mieru + Naive figures are summed.
  // BUG-160: the access log only captures the RARE plain-HTTP request — it does
  //   NOT capture CONNECT tunnels (forward_proxy hijacks the connection, so a
  //   successful tunnel is never logged and bytes_read/size are 0). So this is
  //   best-effort per-user data; the authoritative Naive total comes from the
  //   kernel via systemd IP accounting (naiveTotalMB below).
  let naive = {};
  try {
    naive = parseCaddyTraffic(LOG_CADDY) || {};
  } catch (e) {
    naive = {};
    try { console.error('[stats/users] naive source failed:', e && e.message); } catch {}
  }

  // BUG-163 (honest accounting): authoritative server-wide NaiveProxy traffic
  //   from the kernel (systemd IPAccounting on caddy-naive.service). Per-user
  //   Naive is IMPOSSIBLE: forward_proxy hijacks the CONNECT connection, so the
  //   access log records nothing for a live tunnel and there is no per-key byte
  //   signal anywhere. Earlier (v1.5.1) we spread the server total evenly across
  //   users — that was MISLEADING (it invented per-user numbers). We now report
  //   Naive ONLY as an accurate server-wide total, and keep Mieru per-key.
  let naiveServerTotalMB = 0;
  try { naiveServerTotalMB = readNaiveTotalMB(); } catch { naiveServerTotalMB = 0; }

  // ── Hy2 source (Traffic Stats API on loopback) — fully isolated ─────────────
  // Per-user up/down bytes from GET /traffic. Works for direct AND cascaded Hy2.
  let hy2 = {};
  try {
    hy2 = readHy2Traffic() || {};
  } catch (e) {
    hy2 = {};
    try { console.error('[stats/users] hy2 source failed:', e && e.message); } catch {}
  }

  const allUsers = getAllUsers();

  const users = allUsers.map(u => {
    const s = live.find(x => x.username === u.username) || {};
    const n = naive[u.username] || {};
    const hy = hy2[u.username] || {};
    const mieruUp   = s.uploadMB   || 0;
    const mieruDown = s.downloadMB || 0;
    const hy2Up     = hy.uploadMB   || 0;
    const hy2Down   = hy.downloadMB || 0;
    // Per-user Naive = only what the access log actually attributed (rare plain
    //   HTTP requests). CONNECT tunnels are never logged → this is usually 0.
    //   The real Naive figure is server-wide (naiveServerTotalMB), shown apart.
    const naiveUp   = n.uploadMB   || 0;
    const naiveDown = n.downloadMB || 0;
    const uploadMB   = mieruUp   + naiveUp   + hy2Up;
    const downloadMB = mieruDown + naiveDown + hy2Down;
    // Combined used: prefer live mita "usedMB" when present, plus naive + hy2
    //   bytes; fall back to the stored cumulative value when no source reports.
    const liveUsed = (s.usedMB != null ? s.usedMB : 0) + (n.usedMB || 0) + (hy.usedMB || 0);
    const usedMB   = (s.usedMB != null || n.usedMB != null || hy.usedMB != null)
      ? liveUsed
      : (u.usedMB || 0);
    // Most recent activity across all protocols.
    const seenCandidates = [s.lastSeen, n.lastSeen, u.lastSeen].filter(Boolean);
    const lastSeen = seenCandidates.length
      ? seenCandidates.sort().slice(-1)[0]
      : null;
    return {
      username:   u.username,
      email:      u.email,
      expiry:     u.expiry,
      // BUG-160: never let a single malformed protocols blob 500 the whole
      //   stats endpoint (which would zero EVERY user's counters).
      protocols:  (() => { try { return JSON.parse(u.protocols || '[]'); } catch { return []; } })(),
      quotaMB:    u.quotaMB,
      usedMB,
      uploadMB,
      downloadMB,
      // BUG-163: per-user Naive is only the (rare) logged HTTP bytes — usually
      //   0. The real Naive number is server-wide (see naiveServerTotalMB).
      naiveMB:    naiveUp + naiveDown,
      mieruMB:    mieruUp + mieruDown,
      hy2MB:      hy2Up + hy2Down,
      lastSeen
    };
  });
  // BUG-163: return an object so the UI can show the honest server-wide Naive
  //   total separately from the per-key Mieru figures. `users` keeps the same
  //   shape; `naiveServerTotalMB` is the kernel-measured caddy-naive total.
  res.json({
    users,
    naiveServerTotalMB,
    naivePerUser: false,   // explicit: Naive cannot be broken down per key
  });
});

// BUG-160: read the kernel-measured server-wide NaiveProxy traffic from
//   systemd IPAccounting on caddy-naive.service. Returns total MB (in+out), or
//   0 if accounting is unavailable. This is the only reliable Naive figure
//   because forward_proxy hijacks CONNECT tunnels (never logged).
function readNaiveTotalMB() {
  let out = '';
  try {
    out = execSync(
      'systemctl show caddy-naive -p IPIngressBytes -p IPEgressBytes 2>/dev/null',
      { timeout: 5000 }
    ).toString();
  } catch { return 0; }
  let bytes = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^IP(?:Ingress|Egress)Bytes=(\d+)$/);
    if (m) bytes += Number(m[1]) || 0;
  }
  return bytes / 1048576;
}

// Read per-user Hysteria2 traffic from the Traffic Stats API (loopback).
// Returns a map { username: { uploadMB, downloadMB, usedMB } }. The stats API
// reports cumulative tx/rx bytes since the server started (tx = client upload,
// rx = client download). Works identically whether Hy2 is direct OR cascaded —
// it accounts what actually passed through the Hy2 server. Best-effort: returns
// {} if Hy2 isn't installed / stats not enabled / API unreachable, so it can
// NEVER zero the Naive/Mieru figures (same isolation contract as those).
function readHy2Traffic() {
  const out = {};
  try {
    if (!hy2Installed()) return out;
    let listen = '127.0.0.1:9999', secret = '';
    try {
      const cfgTxt = fs.readFileSync(HY2_CONFIG, 'utf8');
      // trafficStats:\n  listen: <host:port>\n  secret: "<secret>"
      const block = cfgTxt.split(/^trafficStats:\s*$/m)[1] || '';
      const lm = block.match(/^\s*listen:\s*(\S+)/m);
      const sm = block.match(/^\s*secret:\s*"?([^"\n]+)"?/m);
      if (lm) listen = lm[1].trim();
      if (sm) secret = sm[1].trim();
    } catch { return out; }
    if (!listen) return out;
    const hdr = secret ? `-H 'Authorization: ${secret.replace(/'/g, "")}'` : '';
    let raw = '';
    try {
      raw = execSync(`curl -fsS --max-time 5 ${hdr} 'http://${listen}/traffic' 2>/dev/null`,
        { timeout: 7000 }).toString();
    } catch { return out; }
    let obj;
    try { obj = JSON.parse(raw); } catch { return out; }
    if (!obj || typeof obj !== 'object') return out;
    for (const [user, v] of Object.entries(obj)) {
      const tx = (v && Number(v.tx)) || 0;   // client upload
      const rx = (v && Number(v.rx)) || 0;   // client download
      out[user] = {
        uploadMB:   tx / 1048576,
        downloadMB: rx / 1048576,
        usedMB:     (tx + rx) / 1048576,
      };
    }
  } catch { return out; }
  return out;
}

// Bug 78: parse the `mita get users` table.
//   User  LastActive            1DayDownload  1DayUpload  30DaysDownload  30DaysUpload
//   abcd  2025-04-23T01:02:03Z  938.1MiB      12.9MiB     4.0GiB          31.8MiB
//   "used" = 30-day download + 30-day upload (best per-key cumulative metric mita exposes).
//   Sizes use binary IEC units (B / KiB / MiB / GiB / TiB) and may also appear as KB/MB/GB.
function parseMitaUsers(raw) {
  const users = [];
  if (!raw) return users;
  const sizeRe = /^([\d.]+)\s*([KMGT]?i?B)$/i;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // skip header / separator rows
    if (/^user\b/i.test(line) || /^[-=\s]+$/.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const username = cols[0];
    const lastActive = cols[1];
    // last 4 columns are the size figures
    const sizeCols = cols.slice(-4);
    const vals = sizeCols.map(c => {
      const m = c.match(sizeRe);
      return m ? toMB(parseFloat(m[1]), m[2]) : null;
    });
    if (vals.some(v => v === null)) continue; // not a data row
    const [d1, u1, d30, u30] = vals;
    void d1; void u1;
    const downloadMB = d30;
    const uploadMB   = u30;
    users.push({
      username,
      uploadMB,
      downloadMB,
      usedMB:   uploadMB + downloadMB,
      lastSeen: /^\d{4}-\d{2}-\d{2}T/.test(lastActive) ? lastActive : null
    });
  }
  return users;
}
// Convert a size value to MB. Accepts both IEC (KiB/MiB/GiB/TiB) and
//   decimal-ish (KB/MB/GB/TB) unit spellings; bare "B" → bytes.
function toMB(v, unit) {
  switch ((unit || '').toUpperCase()) {
    case 'B':                return v / 1048576;
    case 'KB': case 'KIB':   return v / 1024;
    case 'GB': case 'GIB':   return v * 1024;
    case 'TB': case 'TIB':   return v * 1048576;
    default:                 return v; // MB / MiB
  }
}

// ── Bug 97: Naive (Caddy) per-user traffic accounting ────────────────────────
// Mieru traffic comes from `mita get users`, but NaiveProxy traffic was never
// accounted, so naive-only users always showed 0.0. caddy-forwardproxy-naive
// writes a JSON access log (the global `log { format json }` block). Each
// handled CONNECT request carries the authenticated basic_auth username under
// request.user_id and byte counters (bytes_read = client→server upload,
// size/bytes_written = server→client download). We sum per user over the
// current (un-rolled) log file. This is a best-effort "since last log roll"
// figure — the same character as mita's 30-day window — and is additive with
// the Mieru figure for users that have both protocols.
//
// Returns: { username: { uploadMB, downloadMB, usedMB, lastSeen } }
// Read one Caddy access-log file (capped tail) and fold its per-user byte
// counters into `out`. Returns nothing; mutates `out`.
function foldCaddyLogFile(file, out) {
  let raw;
  try {
    if (!fs.existsSync(file)) return;
    // Cap how much we read so a large log never blocks the event loop /
    // exhausts memory. 32 MiB tail is plenty for a 50mb-rolled file.
    const stat = fs.statSync(file);
    if (stat.size === 0) return;
    const MAX = 32 * 1024 * 1024;
    if (stat.size > MAX) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(MAX);
      fs.readSync(fd, buf, 0, MAX, stat.size - MAX);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      // Drop the first (likely partial) line.
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return; }

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    const req = e.request || {};
    // user_id is the basic_auth username for authenticated forward_proxy reqs.
    const user = req.user_id || e.user_id || '';
    if (!user) continue;
    const up   = Number(e.bytes_read)    || 0;                     // client → server
    const down = Number(e.size != null ? e.size : e.bytes_written) || 0; // server → client
    const ts   = e.ts;
    if (!out[user]) out[user] = { uploadB: 0, downloadB: 0, lastTs: 0 };
    out[user].uploadB   += up;
    out[user].downloadB += down;
    if (typeof ts === 'number' && ts > out[user].lastTs) out[user].lastTs = ts;
  }
}

// Traffic accounting: survive log rotation. Caddy rolls the access log to a
// sibling file in the same directory named like `access-2025-06-22T01-02-03.000.log`
// (older ones may be gzipped to `.log.gz`). The previous parser only read the
// single current file, so every roll silently reset Naive usage to 0. We now
// sum the current log PLUS all plain (un-gzipped) rolled siblings, so the figure
// is stable across rotations. (.gz files are skipped to avoid blocking the event
// loop on decompression — a best-effort, same character as mita's window.)
function parseCaddyTraffic(logPath) {
  const out = {};
  const file = logPath || LOG_CADDY;

  // 1) the current (live) access log
  foldCaddyLogFile(file, out);

  // 2) rolled siblings in the same directory: `<base>-<ts>.log`
  try {
    const dir  = path.dirname(file);
    const base = path.basename(file).replace(/\.log$/i, '');
    const rollRe = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-.*\\.log$', 'i');
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (name === path.basename(file)) continue;   // already counted
        if (!rollRe.test(name)) continue;             // not a rolled sibling
        foldCaddyLogFile(path.join(dir, name), out);
      }
    }
  } catch { /* best-effort: rolled files are a bonus, never fatal */ }

  const result = {};
  for (const [user, v] of Object.entries(out)) {
    const uploadMB   = v.uploadB   / 1048576;
    const downloadMB = v.downloadB / 1048576;
    result[user] = {
      uploadMB,
      downloadMB,
      usedMB:   uploadMB + downloadMB,
      // Caddy ts is float seconds since epoch.
      lastSeen: v.lastTs ? new Date(v.lastTs * 1000).toISOString() : null
    };
  }
  return result;
}

// ── Logs API ──────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', requireAuth, (req, res) => {
  const { service } = req.params;
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 1000);
  let cmd;
  switch (service) {
    // v1.2.3: caddy-naive logs (supports legacy 'naive' and 'caddy' aliases)
    case 'naive':
    case 'caddy':
      cmd = `journalctl -u caddy-naive -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} ${LOG_CADDY} 2>/dev/null`;
      break;
    case 'mieru': cmd = `journalctl -u mita -n ${lines} --no-pager 2>/dev/null || mita describe log 2>/dev/null`; break;
    // Hy2 (Hysteria2) service logs — same journalctl treatment as the others.
    case 'hy2':
    case 'hysteria':
      cmd = `journalctl -u hysteria-server -n ${lines} --no-pager 2>/dev/null`;
      break;
    case 'panel': cmd = `tail -n ${lines} ${LOG_PANEL} 2>/dev/null`; break;
    default: return res.status(400).json({ error: 'Unknown service' });
  }
  try { res.json({ logs: execSync(cmd, { timeout: 6000 }).toString() }); }
  catch { res.json({ logs: '(no logs available)' }); }
});

// ── Diagnostics ───────────────────────────────────────────────────────────────
app.get('/api/diagnostics', requireAuth, async (_req, res) => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 4000 }).toString().trim(); } catch { return ''; } };

  const chkPort = p => {
    try {
      return parseInt(
        execSync(`ss -tlnup sport = :${p} 2>/dev/null | grep -c :${p}`, { timeout: 3000 }).toString().trim(),
        10) > 0;
    } catch { return false; }
  };

  // v1.2.3: caddy-naive version check (replaces naive --version)
  let caddyVersionOk = false, caddyVersionStr = '';
  try {
    caddyVersionStr = execSync(`${resolvedCaddyBin} version 2>&1`, { timeout: 6000 }).toString().trim() ||
                     execSync(`${resolvedCaddyBin} --version 2>&1`, { timeout: 6000 }).toString().trim();
    caddyVersionOk  = caddyVersionStr.length > 0;
  } catch (e) { caddyVersionStr = e.message; }

  const mieruPortsListening = [];
  for (const p of [cfg.mieruPortStart, cfg.mieruPortEnd]) {
    if (p && chkPort(p)) mieruPortsListening.push(p);
  }

  res.json({
    ports: {
      naive:       chkPort(cfg.naivePort),
      mieru:       chkPort(cfg.mieruPortStart),
      mieruPorts:  mieruPortsListening,
      // Hy2 listens on UDP; chkPort uses `ss -tlnup` which covers UDP too.
      hy2:         hy2Installed() ? chkPort(cfg.hy2Port) : false,
      hy2Port:     parseInt(cfg.hy2Port, 10) || 443,
      hy2Installed: hy2Installed()
    },
    naiveVersionOk:    caddyVersionOk,
    naiveVersion:      caddyVersionStr,    // kept as 'naiveVersion' for front-end compat
    naiveConfigExists: fs.existsSync(resolvedCaddyFile),
    htpasswdExists:    false,              // htpasswd removed in v1.2.3 (users in Caddyfile)
    htpasswdUsers:     0,
    caddyfileExists:   fs.existsSync(resolvedCaddyFile),
    caddyfileUsers:    (() => {
      if (!fs.existsSync(resolvedCaddyFile)) return 0;
      const content = fs.readFileSync(resolvedCaddyFile, 'utf8');
      // Bug 23: directive is now "basic_auth" (underscore), not "basicauth"
      return (content.match(/^\s*basic_auth\s+\S+\s+\S+/gm) || []).length;
    })(),
    mitaStatus:   exec_('mita status 2>/dev/null'),
    mitaConfig:   exec_('mita describe config 2>/dev/null'),
    timeSynced:   exec_('timedatectl status 2>/dev/null').includes('synchronized: yes'),
    mitaStateFile: resolvedMitaFile,
    probeSecretSet: !!(cfg.probeSecret),
    probeMode: (cfg.probeMode || (cfg.probeSecret ? 'secret' : 'bare'))
  });
});

// ── Service control ───────────────────────────────────────────────────────────
app.post('/api/service/:name/:action', requireAuth, (req, res) => {
  const { name, action } = req.params;
  // Map legacy 'naive' name to 'caddy-naive'; keep 'mita' as-is
  const svcMap = { 'naive': 'caddy-naive', 'caddy-naive': 'caddy-naive', 'mita': 'mita',
                   'hy2': 'hysteria-server', 'hysteria-server': 'hysteria-server' };
  const svcName = svcMap[name];
  if (!svcName)
    return res.status(400).json({ error: 'Unknown service (valid: naive/caddy-naive, mita, hy2/hysteria-server)' });
  if (!['start','stop','restart','reload'].includes(action))
    return res.status(400).json({ error: 'Unknown action' });
  try {
    // BUG-155: never (re)start caddy-naive against an invalid Caddyfile — that's
    // exactly what put it in a "repeated too quickly" loop. Validate first and
    // refuse with the reason, leaving the currently-running service untouched.
    if (svcName === 'caddy-naive' && ['start','restart','reload'].includes(action)) {
      const v = validateCaddyfile();
      if (!v.ok)
        return res.status(409).json({ error: 'Caddyfile is invalid — not ' + action + 'ing caddy-naive: ' + v.error });
    }
    // Bug 96: before a manual start/restart, clear any lingering systemd
    //   "failed" state so the command is actually honoured (otherwise the
    //   unit can stay failed → "no user found" / mita=failed).
    if (['start','restart'].includes(action)) {
      try { execSync(`systemctl reset-failed ${svcName} 2>/dev/null || true`, { timeout: 5000 }); } catch {}
    }
    execSync(`systemctl ${action} ${svcName} 2>&1`, { timeout: 15000 });
    res.json({ ok: true, service: svcName, action });
  } catch (e) { res.status(500).json({ error: e.stdout?.toString() || e.message }); }
});

// ── WebSocket — real-time metrics ─────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const exec_ = cmd => { try { return execSync(cmd, { timeout: 2000 }).toString().trim(); } catch { return ''; } };
  let iv;
  const push = async () => {
    if (ws.readyState !== ws.OPEN) { clearInterval(iv); return; }
    try {
      const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
      ws.send(JSON.stringify({
        type:       'metrics',
        ts:         Date.now(),
        cpu:        Math.round(cpu.currentLoad),
        ramUsedMB:  Math.round((mem.total - mem.available) / 1048576),
        ramTotalMB: Math.round(mem.total / 1048576),
        // v1.2.3: check caddy-naive service
        naive:      exec_('systemctl is-active caddy-naive') === 'active',
        mieru:      exec_('systemctl is-active mita')        === 'active',
        // Hy2: only meaningful when installed; false otherwise (UI hides card).
        hy2:        hy2Installed() && exec_('systemctl is-active hysteria-server') === 'active'
      }));
    } catch {}
  };
  iv = setInterval(push, 5000);
  push();
  ws.on('message', d => { try { const m = JSON.parse(d); if (m.type==='ping') ws.send(JSON.stringify({type:'pong'})); } catch {} });
  ws.on('close',  () => clearInterval(iv));
  ws.on('error',  () => clearInterval(iv));
});

// ── Expiry cron — every 5 min ─────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  const now = new Date().toISOString();
  let changed = false;
  getAllUsers().forEach(u => {
    if (u.expiry && u.expiry < now) {
      console.log('[CRON] Removing expired user:', u.username);
      deleteUser(u.id); changed = true;
    }
  });
  if (changed) {
    try {
      const content = buildCaddyfile(cfg, getAllUsers());
      writeCaddyfileAtomic(content);
      reloadCaddy();
    } catch {}
    try { applyMitaConfig(); } catch {}
  }
});

// ── Traffic snapshot cron — every 60 s ───────────────────────────────────────
cron.schedule('* * * * *', () => {
  if (!db) return;
  try {
    // Bug 78: use `mita get users` (the real command); `mita describe users`
    //   does not exist and always produced empty output.
    let raw = '';
    try { raw = execSync('mita get users 2>/dev/null', { timeout: 5000 }).toString(); } catch {}
    const live = parseMitaUsers(raw);
    // Bug 97: also fold in NaiveProxy traffic from the Caddy access log so
    //   naive-only users are persisted with non-zero usage.
    const naive = parseCaddyTraffic(LOG_CADDY);

    // Build a combined per-username map.
    const combined = {};
    live.forEach(s => {
      combined[s.username] = {
        uploadMB:   s.uploadMB   || 0,
        downloadMB: s.downloadMB || 0,
        usedMB:     s.usedMB     || 0,
        lastSeen:   s.lastSeen   || null
      };
    });
    for (const [user, n] of Object.entries(naive)) {
      const c = combined[user] || { uploadMB: 0, downloadMB: 0, usedMB: 0, lastSeen: null };
      c.uploadMB   += n.uploadMB   || 0;
      c.downloadMB += n.downloadMB || 0;
      c.usedMB     += n.usedMB     || 0;
      if (n.lastSeen && (!c.lastSeen || n.lastSeen > c.lastSeen)) c.lastSeen = n.lastSeen;
      combined[user] = c;
    }

    const entries = Object.entries(combined);
    if (!entries.length) return;
    const ts   = new Date().toISOString();
    const ins  = db.prepare('INSERT INTO traffic_snapshots (username,uploadMB,downloadMB,ts) VALUES (?,?,?,?)');
    entries.forEach(([username, s]) => ins.run(username, s.uploadMB, s.downloadMB, ts));
    entries.forEach(([username, s]) => {
      const u = getUserByUsername(username);
      if (u) upsertUser({ ...u, usedMB: s.usedMB, lastSeen: s.lastSeen || ts, updatedAt: ts });
    });
  } catch {}
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Global error handler (Bug 149) ───────────────────────────────────────────
// Last-resort safety net: any error thrown synchronously inside a route (e.g. a
// SqliteError from an unguarded DB call) must NOT reach the client as a raw
// Express HTML stacktrace exposing internal file paths like
// "/opt/panel-naive-mieru/server/index.js:206". Log the detail server-side and
// return a clean JSON error. UNIQUE violations are mapped to a friendly 409.
// (Express identifies error-handling middleware by its 4-arg signature.)
app.use((err, req, res, next) => {     // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  console.error('[ERR]', req && req.method, req && req.path, '-', err && err.message);
  const d = (err && /SqliteError|UNIQUE constraint/i.test(String(err.message || err.code || '')))
    ? describeDbError(err)
    : { status: 500, error: 'Internal server error' };
  res.status(d.status).json({ error: d.error });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const HOST = process.env.PANEL_HOST || cfg.panelHost || '127.0.0.1';
const PORT = parseInt(process.env.PANEL_PORT || String(cfg.panelPort || 3000), 10);

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    '  ██████╗  ██╗ ██╗  ██╗ ██╗  ██╗ ██╗  ██╗',
    '  ██╔══██╗ ██║ ╚██╗██╔╝ ╚██╗██╔╝ ╚██╗██╔╝',
    '  ██████╔╝ ██║  ╚███╔╝   ╚███╔╝   ╚███╔╝ ',
    '  ██╔══██╗ ██║  ██╔██╗   ██╔██╗   ██╔██╗ ',
    '  ██║  ██║ ██║ ██╔╝ ██╗ ██╔╝ ██╗ ██╔╝ ██╗',
    '  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝',
    '',
    `  Panel Naive + Mieru v${readPanelVersion()} by RIXXX  (Caddy-forwardproxy-naive)`,
    `  http://${HOST}:${PORT}/`,
    HOST === '127.0.0.1' ? `  ⚠  SSH-only: ssh -L 3000:127.0.0.1:3000 root@<server>` : '',
    ''
  ];
  lines.forEach(l => console.log(l));
});

module.exports = app;
