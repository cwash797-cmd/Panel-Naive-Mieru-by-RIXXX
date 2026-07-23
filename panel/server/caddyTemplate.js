'use strict';
/**
 * caddyTemplate.js — canonical Caddyfile renderer  v1.2.6
 *
 * Single source of truth used by:
 *   • panel/server/index.js   → buildCaddyfile()
 *   • update.sh               → node -e "require('./caddyTemplate').render(cfg, users)"
 *   • install.sh              → node -e "require('./caddyTemplate').render(cfg, [])"
 *
 * Bug 23: forward_proxy uses  basic_auth  (with underscore) as the *block* directive;
 *         individual credential lines use the same  basic_auth  directive:
 *             basic_auth  <username>  <password>
 *         The standalone  "basic_auth"  token with no arguments is NOT valid in
 *         caddy-forwardproxy-naive — it causes the parse error:
 *             "wrong argument count or unexpected line ending after 'basic_auth'"
 *         We therefore emit ONLY the per-user lines; the block keyword is omitted.
 *
 * Bug 28: TLS is managed by the global  email  directive + Caddy's automatic HTTPS.
 *         A redundant  tls <email>  inside the site block is removed.
 *
 * Bug 29: Directive order inside forward_proxy:
 *             basic_auth  <user>  <pass>   (one line per user, or placeholder)
 *             hide_ip
 *             hide_via
 *             probe_resistance  <secret>   (only when secret is set)
 *
 * Bug 30 / Bug 102: Global  order forward_proxy first  ensures forwardproxy is
 *         evaluated before ANY masquerade handler (file_server OR reverse_proxy).
 *
 * Bug 34: Placeholder logic — emit ONE placeholder line only when naiveUsers is empty;
 *         as soon as the first real user exists, placeholder is dropped.
 *
 * Bug 38: Log rotation uses  roll_keep_for  720h  (30 days) instead of a fixed count.
 *
 * Bug 21: No duplicate site-level log block; global log block covers all traffic.
 */

const crypto = require('crypto');

// ── extractBcrypt() — BUG-155 ────────────────────────────────────────────────
// Return a single valid bcrypt token ($2[aby]$NN$<53 chars>) from arbitrary
// text. An old installer could capture apt/needrestart stdout into
// panelBasicAuthHash; this sieves it back down to the one real hash (last match)
// so the panel basic_auth block is always valid. Returns '' if there is none.
function extractBcrypt(text) {
  const m = String(text || '').match(/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}/g);
  return m && m.length ? m[m.length - 1] : '';
}

// ── normalizeUpstream() — Bug 92 ─────────────────────────────────────────────
// Caddy forward_proxy `upstream` only accepts a clean https:// URL. The panel
// already normalizes, but render() is also called directly from install.sh /
// update.sh, so we normalize here too (single source of truth). Strips a leading
// "naive+" (or any "<scheme>+") wrapper and upgrades a bare/http upstream to https.
function normalizeUpstream(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9.+-]*\+(?=https?:\/\/)/i, '');
  s = s.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

/**
 * render(cfg, naiveUsers) → string
 *
 * @param {object} cfg
 *   .adminEmail   {string}  ACME email (used in global block)
 *   .domain       {string}  VPN domain
 *   .naivePort    {number}  HTTPS port (default 443)
 *   .fakeSiteDir  {string}  path to fake-site root
 *   .probeSecret  {string}  probe_resistance token (used only when probeMode='secret')
 *   .probeMode    {string}  'off' | 'bare' | 'secret' (optional; derived from
 *                           probeSecret when unset — non-empty→'secret', empty→'bare')
 *   .logFile      {string}  caddy access log path (optional)
 *   .upstream     {string}  upstream proxy URL, e.g. https://user:pass@exit.example.com:443 (optional)
 * @param {Array<{username:string, password:string}>} naiveUsers
 *   Users with naive protocol enabled.  password must be the PLAINTEXT
 *   password (caddy-forwardproxy-naive hashes it internally).
 * @returns {string}  Full Caddyfile content ready to write.
 */
// ── normalizeFakeUpstream() — Bug 98 ─────────────────────────────────────────
// The masquerade site can be served two ways:
//   • file_server  — static files from fakeSiteDir (default, always safe)
//   • reverse_proxy — proxy a real website (fakeSiteUrl) so the camouflage is
//     a live page instead of a single static file.
// We only switch to reverse_proxy when fakeSiteUrl is a real, absolute http(s)
// URL that is NOT the historical placeholder default ("https://www.example.com").
// Returns { host, scheme, useProxy } or { useProxy:false }.
function parseFakeUpstream(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return { useProxy: false };
  // Ignore the placeholder default so existing installs keep file_server.
  if (/^https?:\/\/(www\.)?example\.com\/?$/i.test(s)) return { useProxy: false };
  let m = s.match(/^(https?):\/\/([^\/\s]+)/i);
  if (!m) return { useProxy: false };
  const scheme = m[1].toLowerCase();
  const host   = m[2];                 // host[:port]
  if (!host) return { useProxy: false };
  return { useProxy: true, scheme, host };
}

// ── v1.4.0: panel external-access subdomain block ─────────────────────────────
// External access to the admin panel is served ONLY through a dedicated TLS
// subdomain (panel.<domain>), never via a bare HTTP port. The panel itself
// always listens on loopback (127.0.0.1:3000); Caddy reverse_proxies to it.
//
// Architecture:
//   https://panel.<domain>/<webBasePath>/*   →  basic_auth + handle_path → reverse_proxy 127.0.0.1:3000
//   https://panel.<domain>/  and any other path → static stub (file_server, local HTML)
//
//   • handle_path strips the /<webBasePath> prefix before proxying, so the
//     panel never sees (or needs to know) the prefix — the most robust approach.
//     A change of webBasePath therefore does not require any panel-side change.
//   • basic_auth is a layer OVER the panel login, never a replacement.
//   • The stub (panelStubPage / its directory) is served by file_server for the
//     subdomain root and every path outside webBasePath — NOT a redirect to login.
//   • This is a SEPARATE site block keyed on the panel.<domain> host, so it does
//     NOT collide with the naive ":<port>, <domain>" catch-all on :443.
//
// Returns '' (empty) when external access is disabled or misconfigured, so the
// caller appends nothing and the panel stays loopback-only.
function sanitizeWebBasePath(raw) {
  // Strip leading/trailing slashes and any unsafe characters; keep it path-safe.
  let s = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
  s = s.replace(/[^A-Za-z0-9._~-]/g, '');
  return s;
}

function renderPanelBlock(cfg) {
  const expose      = !!cfg.exposePanel;
  const panelDomain = String(cfg.panelDomain || '').trim();
  const email       = String(cfg.adminEmail || '').trim();
  const baUser      = String(cfg.panelBasicAuthUser || '').trim();
  // BUG-155: a polluted hash (apt output captured by an old installer) must
  // NEVER reach the Caddyfile — it produced a multi-line basic_auth block that
  // failed `caddy validate` and dropped caddy-naive into a restart loop. Sieve
  // the stored value to a single valid bcrypt token; if none is present, emit
  // no basic_auth line (the operator re-sets the password) rather than a broken
  // config.
  const baHash      = extractBcrypt(String(cfg.panelBasicAuthHash || ''));
  const stubFile    = String(cfg.panelStubPage || '/var/www/panel-stub/index.html').trim();
  const webBasePath = sanitizeWebBasePath(cfg.webBasePath);
  const panelPort   = parseInt(cfg.panelPort, 10) || 3000;

  // External access requires, at minimum, a panel subdomain and a webBasePath.
  if (!expose || !panelDomain || !webBasePath) return '';

  // The stub root directory holds the local static "CONNECTION" page that is
  // served for the subdomain root and any path outside webBasePath.
  const stubDir = stubFile.replace(/\/[^/]*$/, '') || '/var/www/panel-stub';

  // basic_auth block — only emitted when a username + bcrypt hash are present.
  // Caddy v2 syntax: `basic_auth { <user> <bcrypt-hash> }`. The hash must be a
  // bcrypt hash produced by `caddy hash-password`.
  let basicAuthBlock = '';
  if (baUser && baHash) {
    basicAuthBlock =
`    basic_auth {
      ${baUser} ${baHash}
    }
`;
  }

  // handle_path strips the /<webBasePath> prefix, so reverse_proxy sees "/".
  // Everything else (root + any non-matching path) falls through to file_server.
  //
  // BUG-140: the bare prefix (no trailing slash) MUST redirect to "/<wbp>/" so
  // the SPA's relative assets (style.css, app.js) resolve under the prefix.
  // Without it, https://d/<wbp> would load index.html but resolve app.js to
  // https://d/app.js (404). The frontend then carries the prefix on every
  // /api and /locales request via window-derived BASE_PATH.
  return `

# ── v1.4.0: panel external access (TLS + basic_auth + webBasePath) ────────────
${panelDomain} {
  tls ${email}

  # Normalize the bare base path to a trailing slash so relative assets resolve.
  redir /${webBasePath} /${webBasePath}/ 301

  handle_path /${webBasePath}/* {
${basicAuthBlock}    reverse_proxy 127.0.0.1:${panelPort}
  }

  # Root and any path outside the secret base path → static stub (not a redirect)
  handle {
    root * ${stubDir}
    file_server
  }
}
`;
}

// ── v1.8.7: subscription sub-domain block ────────────────────────────────────
// When the admin configures a dedicated subscription domain (cfg.subBaseUrl,
// e.g. https://sub.example.com), Caddy must (a) auto-provision a TLS cert for
// that host and (b) reverse_proxy the public /sub/* path to the loopback panel.
// Everything else on the sub domain returns 404 (no admin surface exposed).
//
// Returns '' when no sub domain is configured (or it equals the main domain, in
// which case /sub/ is already served by the panel externally) so the caller
// appends nothing.
function subHostFromCfg(cfg) {
  const raw = String(cfg.subBaseUrl || '').trim();
  if (!raw) return '';
  return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function renderSubBlock(cfg) {
  const host = subHostFromCfg(cfg);
  if (!host) return '';
  const email     = String(cfg.adminEmail || '').trim();
  const panelPort = parseInt(cfg.panelPort, 10) || 3000;
  return `

# ── v1.8.7: subscription domain (public /sub/* → panel; TLS auto) ─────────────
${host} {
  tls ${email}
  handle /sub/* {
    reverse_proxy 127.0.0.1:${panelPort}
  }
  handle {
    respond "Not found" 404
  }
}
`;
}

function render(cfg, naiveUsers) {
  const email      = (cfg.adminEmail  || '').trim();
  const domain     = (cfg.domain      || 'localhost').trim();
  const port       = cfg.naivePort   || 443;
  const fakeSite   = (cfg.fakeSiteDir || '/var/www/fake-site').trim();
  const fakeSiteUrl = (cfg.fakeSiteUrl || '').trim();
  const probeSecret = (cfg.probeSecret || '').trim();
  const logFile    = (cfg.logFile     || '/var/log/caddy-naive/access.log').trim();

  // ── Bug 23 + 34: basic_auth credential lines ──────────────────────────────
  // caddy-forwardproxy-naive forward_proxy block accepts:
  //   basic_auth  <username>  <password>
  // The bare  "basic_auth"  keyword with no args is invalid.
  // When there are no real users we emit a single unreachable placeholder so
  // the forward_proxy block is never left without credentials (which would
  // allow unauthenticated access).  The placeholder is replaced on the next
  // rebuild after the first real user is created.
  let authLines;
  if (naiveUsers && naiveUsers.length > 0) {
    authLines = naiveUsers
      .map(u => `    basic_auth ${u.username} ${u.password}`)
      .join('\n');
  } else {
    // Bug 34: unique random placeholder; no real client can match it.
    const rnd = crypto.randomBytes(20).toString('hex');
    authLines = `    basic_auth _placeholder_${rnd.slice(0, 16)} _disabled_${rnd.slice(16)}`;
  }

  // ── Bug 29 + Bug 81: probe_resistance line ───────────────────────────────
  // Three modes (cfg.probeMode):
  //   'off'    → no probe_resistance line at all
  //   'bare'   → bare  probe_resistance  (no secret) — matches the known-good
  //              reference server; the masquerade site is served on the main
  //              domain, no special secret domain is required.
  //   'secret' → probe_resistance <secret>  (requires a secret domain to reach
  //              the masquerade content).
  // Back-compat: if probeMode is unset, derive it from probeSecret
  //   (non-empty → 'secret', empty → 'bare').
  let probeMode = (cfg.probeMode || '').trim().toLowerCase();
  if (!probeMode) probeMode = probeSecret ? 'secret' : 'bare';

  let probeLine;
  if (probeMode === 'off') {
    probeLine = '';
  } else if (probeMode === 'secret' && probeSecret) {
    probeLine = `\n    probe_resistance ${probeSecret}`;
  } else {
    // 'bare' (or 'secret' with no secret available) → bare keyword
    probeLine = `\n    probe_resistance`;
  }

  // ── v1.2.6: cascade — upstream proxy support ──────────────────────────────
  // Bug 92: normalize (strip "naive+" etc.) so forward_proxy gets clean https://.
  const upstreamUrl = normalizeUpstream(cfg.upstream || '');
  const upstreamLine = upstreamUrl
    ? `\n    upstream ${upstreamUrl}`
    : '';

  // ── Bug 98: masquerade handler — file_server OR reverse_proxy ─────────────
  // When fakeSiteUrl points at a real site we reverse_proxy to it so the cover
  // page is a live website. Otherwise we serve the local static fake-site.
  // For HTTPS upstreams we rewrite the Host header to the upstream host and
  // enable TLS-SNI so the upstream serves the right vhost/cert.
  const fake = parseFakeUpstream(fakeSiteUrl);
  let masqueradeBlock;
  if (fake.useProxy) {
    if (fake.scheme === 'https') {
      masqueradeBlock =
`  reverse_proxy https://${fake.host} {
    header_up Host ${fake.host}
    transport http {
      tls
      tls_server_name ${fake.host}
    }
  }`;
    } else {
      masqueradeBlock =
`  reverse_proxy http://${fake.host} {
    header_up Host ${fake.host}
  }`;
    }
  } else {
    masqueradeBlock =
`  file_server {
    root ${fakeSite}
  }`;
  }

  // ── Bug 28: no redundant  tls <email>  inside the site block  ────────────
  // Caddy's automatic HTTPS handles TLS for domains that resolve to this
  // server's IP.  The global  email  directive supplies the ACME account.

  // Bug 63: use consistent 2-space indentation throughout to silence caddy fmt
  return `{
  # Bug 30 / Bug 102 (CRITICAL): forward_proxy MUST be evaluated before ANY other
  # handler. With Bug 98 the masquerade can be reverse_proxy (mirror mode), and
  # "before file_server" did NOT place forward_proxy ahead of reverse_proxy — so
  # the mirror handler hijacked authenticated CONNECT requests and every naive
  # key broke (client got "400 Bad Request" from the fake-site). "first" puts
  # forward_proxy ahead of BOTH file_server and reverse_proxy, covering local and
  # mirror masquerade modes. (Canonical form per caddyserver/forwardproxy.)
  order forward_proxy first
  # Bug 80: restrict to HTTP/1.1 + HTTP/2 only (disable HTTP/3 / QUIC).
  # NaiveProxy tunnels over HTTP/2 CONNECT; HTTP/3 can break some clients.
  servers {
    protocols h1 h2
  }
  email ${email}
  admin off
  # BUG (traffic accounting): the log directive in the GLOBAL options block only
  # configures Caddy's runtime (diagnostic) logger — it does NOT enable HTTP
  # access logging, so it never emits per-request user_id / byte counters. That is
  # why NaiveProxy traffic was always 0.0: parseCaddyTraffic() reads access.log,
  # but only runtime lines (no user_id, no bytes_read/size) were ever written
  # there. Access logging MUST be a log directive INSIDE the site block (below).
  # Keep the global logger on stderr (journald) so it never pollutes access.log.
  log {
    output stderr
    format console
    level ERROR
  }
}

# HTTP → HTTPS redirect (also needed for ACME HTTP-01 fallback)
:80 {
  redir https://{host}{uri} permanent
}

:${port}, ${domain} {
  # Bug 83: match the known-good reference server exactly:
  #   - listen on ":${port}, ${domain}" (catch-all :${port} + the domain) so the
  #     CONNECT request matches this site regardless of how the client sets SNI/Host
  #   - explicit "tls <email>" inside the block (not relying on the global email)
  #   - no route{} wrapper — forward_proxy/file_server directly in the site block
  #     (ordering comes from the global "order forward_proxy first")
  tls ${email}

  # Traffic accounting: per-site ACCESS log — THIS is what writes a JSON line
  # per handled request with request.user_id (the basic_auth username of the
  # authenticated CONNECT) and the byte counters (bytes_read = upload,
  # size = download). parseCaddyTraffic() sums these per user. Without this
  # site-level directive Naive traffic is never recorded.
  log {
    # Bug 38: 30-day retention by age instead of a fixed file count
    output file ${logFile} {
      roll_size 50mb
      roll_keep_for 720h
    }
    format json
  }

  forward_proxy {
    # Bug 23: no bare "basic_auth" token; each line IS the credential directive
    # Bug 29: order — credentials → hide_ip → hide_via → probe_resistance
${authLines}
    hide_ip
    hide_via${probeLine}${upstreamLine}
  }

${masqueradeBlock}
}
${renderPanelBlock(cfg)}${renderSubBlock(cfg)}`;
}

module.exports = { render, renderPanelBlock, renderSubBlock, sanitizeWebBasePath };
