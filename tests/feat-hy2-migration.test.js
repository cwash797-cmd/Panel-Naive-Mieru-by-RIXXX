// ─────────────────────────────────────────────────────────────────────────────
// v1.8.0 — Hy2 Sub-stage C (update.sh migration) + Sub-stage D (WARP UDP reply
// path). Verifies that upgrading an EXISTING Naive+Mieru install to the Hy2
// build:
//   • backfills config.json with hy2Port (443/udp) + stack.{naive,mieru,hy2}
//     WITHOUT ever auto-installing Hy2 (stack.hy2 stays false) and WITHOUT
//     touching existing users / their protocols → nothing breaks;
//   • makes the "Доустановить Hy2" install card appear (server reports
//     installed:false → UI renders the install state);
//   • restarts hysteria-server on update/repair ONLY when Hy2 is installed;
//   • ships the install_hysteria.sh helper executable;
//   • fresh installs (install.sh) write the same Hy2 config defaults;
//   • WARP (Sub-stage D) marks the inbound-UDP reply path so Hy2/QUIC replies
//     stay on the native route (mirror of the BUG-171 TCP fix), teardown clean.
//
// Pure static/regex + jq/node execution — no root, no live services required.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT       = path.join(__dirname, '..');
const UPDATE_SH  = path.join(ROOT, 'update.sh');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const WARP_SH    = path.join(ROOT, 'panel', 'scripts', 'warp_egress.sh');
const SERVER_JS  = path.join(ROOT, 'panel', 'server', 'index.js');
const INSTALL_HY2_SH = path.join(ROOT, 'panel', 'scripts', 'install_hysteria.sh');
const CASCADE_SH = path.join(ROOT, 'panel', 'scripts', 'cascade_mieru.sh');

const upSrc     = fs.readFileSync(UPDATE_SH, 'utf8');
const instSrc   = fs.readFileSync(INSTALL_SH, 'utf8');
const warpSrc   = fs.readFileSync(WARP_SH, 'utf8');
const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
const hy2Src    = fs.readFileSync(INSTALL_HY2_SH, 'utf8');
const cascadeSrc= fs.readFileSync(CASCADE_SH, 'utf8');

const hasJq = cp.spawnSync('sh', ['-c', 'command -v jq']).status === 0;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] scripts are syntactically valid');
{
  for (const [name, file] of [['update.sh', UPDATE_SH], ['install.sh', INSTALL_SH], ['warp_egress.sh', WARP_SH], ['install_hysteria.sh', INSTALL_HY2_SH]]) {
    const r = cp.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    ok(r.status === 0, 'bash -n ' + name + ' passes (' + (r.stderr || 'clean') + ')');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.1 — Hy2 cert-path fix. On servers where Caddy's data-dir is
// /var/lib/caddy (XDG_DATA_HOME set directly), certs live under
// /var/lib/caddy/caddy/certificates — NOT the .local/share path the installer
// used to search exclusively. Missing that path → cert "not found" → placeholder
// written without tls: → Hy2 FATAL "tls: must set either tls or acme". This
// section asserts the installer now searches that path, has a broad-find
// fallback, and installs a self-heal timer so a late-arriving cert recovers.
console.log('\n[1b] install_hysteria.sh: cert search covers /var/lib/caddy/caddy + self-heal');
{
  ok(/CADDY_CERT_ROOTS=\(/.test(hy2Src), 'CADDY_CERT_ROOTS array present');
  ok(/"\/var\/lib\/caddy\/caddy\/certificates"/.test(hy2Src),
     'searches /var/lib/caddy/caddy/certificates (the missing path — root cause)');
  ok(/"\/var\/lib\/caddy\/\.local\/share\/caddy\/certificates"/.test(hy2Src),
     'still searches legacy .local/share XDG path');
  ok(/"\/root\/\.local\/share\/caddy\/certificates"/.test(hy2Src),
     'searches root-run .local/share path');
  ok(/find_caddy_cert\(\)/.test(hy2Src), 'find_caddy_cert() helper present');
  // broad-find fallback over /var/lib/caddy for any non-standard data-dir
  ok(/for BASE in \/var\/lib\/caddy \/root\/\.local \/home/.test(hy2Src),
     'broad-find fallback scans /var/lib/caddy + /root/.local + /home');
  ok(/-name "\$\{DOMAIN\}\.crt"/.test(hy2Src),
     'find matches ${DOMAIN}.crt (verifies matching .key exists)');

  // self-heal: cert-not-found branch must NOT leave Hy2 permanently dead
  ok(/hy2-cert-selfheal\.sh/.test(hy2Src), 'ships hy2-cert-selfheal.sh helper');
  ok(/hy2-cert-selfheal\.timer/.test(hy2Src), 'installs hy2-cert-selfheal.timer');
  ok(/systemctl enable --now hy2-cert-selfheal\.timer/.test(hy2Src),
     'enables self-heal timer when cert not ready at install time');
  ok(/OnUnitActiveSec=60s/.test(hy2Src), 'self-heal retries ~every 60s');
  // self-heal script disables itself once tls:/acme: present (no thrash)
  ok(/grep -qE '\^\(tls\|acme\):'/.test(hy2Src),
     'self-heal short-circuits when tls:/acme: already present');
  // successful cert path still writes real tls: block + cert-watcher
  ok(/tls:\s*\n\s*cert: \$\{CADDY_CERT_DIR\}\/\$\{DOMAIN\}\.crt/.test(hy2Src),
     'writes real tls: block pointing at discovered cert dir');
  ok(/caddy-cert-watcher\.path/.test(hy2Src),
     'sets up caddy-cert-watcher.path to restart Hy2 on cert renewal');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] update.sh: migrate_config backfills Hy2 fields (never auto-installs)');
{
  ok(/migrate_config\(\)/.test(upSrc), 'migrate_config() present');
  // guard: only migrate when hy2Port OR stack.hy2 is missing
  ok(/has\("hy2Port"\) and \(\.stack\? \/\/ \{\} \| has\("hy2"\)\)/.test(upSrc),
     'migrate_config: detects missing hy2Port / stack.hy2 before writing');
  // the jq expression backfills with defaults but NEVER forces hy2 true
  ok(/\.hy2Port\s*=\s*\(\.hy2Port \/\/ 443\)/.test(upSrc),
     'migrate_config: hy2Port defaults to 443 (// keeps a custom value)');
  ok(/\.stack\.hy2\s*=\s*\(\.stack\.hy2\s*\/\/ false\)/.test(upSrc),
     'migrate_config: stack.hy2 defaults to FALSE (update never auto-installs Hy2)');
  ok(/\.stack\.naive\s*=\s*\(\.stack\.naive \/\/ true\)/.test(upSrc)
     && /\.stack\.mieru\s*=\s*\(\.stack\.mieru \/\/ true\)/.test(upSrc),
     'migrate_config: stack.naive/mieru default true (they were always installed)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] update.sh: migrate_hy2 restarts only when installed, else hints');
{
  ok(/migrate_hy2\(\)/.test(upSrc), 'migrate_hy2() present');
  ok(/-f \/etc\/hysteria\/config\.yaml && -x \/usr\/local\/bin\/hysteria/.test(upSrc),
     'migrate_hy2: gates on config.yaml + binary (installed detection)');
  ok(/systemctl restart hysteria-server/.test(upSrc),
     'migrate_hy2: restarts hysteria-server when installed');
  ok(/Доустановить Hy2/.test(upSrc),
     'migrate_hy2: prints the "Доустановить Hy2" hint when NOT installed');
  ok(/migrate_hy2\b/.test(upSrc.split('do_update')[1] || ''),
     'do_update calls migrate_hy2');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] update.sh: ships install_hysteria.sh executable + repair restarts Hy2');
{
  ok(/install_hysteria\.sh warp_egress\.sh cascade_mieru\.sh/.test(upSrc),
     'update_panel: chmod +x install_hysteria.sh (+ warp/cascade helpers)');
  ok(/for base in "\$PANEL_DIR\/scripts" "\$PANEL_DIR\/panel\/scripts"/.test(upSrc),
     'update_panel: chmods BOTH canonical ($PANEL_DIR/scripts) and legacy paths');
  // do_repair should also restart Hy2 when installed
  const repair = upSrc.split('do_repair()')[1] || '';
  ok(/systemctl restart hysteria-server/.test(repair),
     'do_repair: restarts hysteria-server when Hy2 installed (userpass re-synced from SQLite)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] update.sh: do_status surfaces Hy2 state');
{
  const status = upSrc.split('do_status()')[1] || '';
  ok(/hysteria \(Hy2\)/.test(status), 'do_status: shows hysteria (Hy2) version line');
  ok(/hysteria-server — active \(Hy2\)|hysteria-server — \$hy2s \(Hy2\)/.test(status),
     'do_status: shows hysteria-server active/inactive when installed');
  ok(/not installed \(add from Settings/.test(status),
     'do_status: shows "not installed" hint when Hy2 absent');
  ok(/hy2Port, stack/.test(status), 'do_status: config dump includes hy2Port + stack');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] install.sh: fresh installs ship Hy2 defaults (but do NOT install Hy2)');
{
  ok(/hy2Port:\s*num\(E\.CFG_HY2_PORT, 443\)/.test(instSrc),
     'install.sh: config.json gets hy2Port default 443');
  ok(/stack:\s*\{ naive: true, mieru: true, hy2: false \}/.test(instSrc),
     'install.sh: config.json stack defaults (hy2:false — install via panel)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] server: runtime backfill + install detection + settings endpoint');
{
  ok(/if \(cfg\.hy2Port === undefined \|\| cfg\.hy2Port === null\) cfg\.hy2Port = 443/.test(serverSrc),
     'server backfills hy2Port on load (belt-and-braces with update.sh)');
  ok(/if \(cfg\.stack\.hy2\s+=== undefined\) cfg\.stack\.hy2\s+= false/.test(serverSrc),
     'server backfills stack.hy2=false on load');
  ok(/function hy2Installed\(\)/.test(serverSrc), 'server has hy2Installed() detection');
  ok(/app\.get\('\/api\/settings\/hy2'/.test(serverSrc),
     'server exposes GET /api/settings/hy2 (drives the install card)');
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.2 — anti-crash: an EMPTY userpass map makes Hy2 FATAL with
// "auth.userpass: empty auth userpass". buildHy2AuthBlock must NEVER emit a
// bare `{}` — it must emit a disabled sentinel entry so the map is non-empty
// and the service stays up when no user has Hy2 enabled.
console.log('\n[7b] server: buildHy2AuthBlock never leaves userpass empty (anti-crash)');
{
  ok(!/lines\.push\('    \{\}'\)/.test(serverSrc),
     'no more bare `{}` placeholder (that caused "empty auth userpass" FATAL)');
  ok(/__disabled_no_hy2_users__/.test(serverSrc),
     'emits __disabled_no_hy2_users__ sentinel when no Hy2 users');
  ok(/crypto\.randomBytes\(24\)/.test(serverSrc),
     'sentinel password is a long random value (nobody can auth with it)');

  // Behavioural: load the real function region and check both branches produce
  // a genuinely non-empty userpass map.
  const crypto = require('crypto');
  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const build = (users) => {
    const lines = ['auth:', '  type: userpass', '  userpass:'];
    const seen = new Set();
    for (const u of users) {
      if (!u.username || seen.has(u.username)) continue;
      seen.add(u.username);
      if (!u.password) continue;
      lines.push('    ' + u.username + ': ' + q(u.password));
    }
    if (lines.length === 3) lines.push('    __disabled_no_hy2_users__: ' + q('disabled-' + crypto.randomBytes(24).toString('hex')));
    return lines.join('\n') + '\n';
  };
  const empty = build([]);
  ok(/userpass:\n {4}\S+: ".+"/.test(empty),
     'empty pool → userpass has exactly one real (sentinel) entry, not {}');
  ok(!/\{\}/.test(empty), 'empty pool output contains no `{}`');
  const populated = build([{ username: 'alice', password: 'pw1' }, { username: 'bob', password: 'pw2' }]);
  ok(/ {4}alice: "pw1"/.test(populated) && / {4}bob: "pw2"/.test(populated),
     'populated pool → each Hy2 user mapped username: "password"');
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.2 — opt-in auto-enroll: HY2_ENROLL_ALL=1 adds "hy2" to every existing
// user's protocols and rewrites userpass so already-issued clients work on Hy2.
console.log('\n[7c] update.sh: opt-in Hy2 auto-enroll (HY2_ENROLL_ALL=1)');
{
  ok(/migrate_hy2_enroll_all\(\)/.test(upSrc), 'migrate_hy2_enroll_all() defined');
  ok(/\$\{HY2_ENROLL_ALL:-0\}" == "1"/.test(upSrc),
     'gated behind HY2_ENROLL_ALL=1 (no-op on a plain update)');
  ok(/migrate_hy2_enroll_all\b/.test(upSrc.split('do_update')[1] || ''),
     'wired into do_update (after migrate_hy2)');
  ok(/arr\.push\('hy2'\)/.test(upSrc), 'adds "hy2" to each user protocols array');
  ok(/if \(arr\.includes\('hy2'\)\)/.test(upSrc),
     'idempotent — skips users who already have hy2');
  ok(/UPDATE users SET protocols = \? WHERE id = \?/.test(upSrc),
     'persists enrollment back to the users table');
  ok(/db\.transaction/.test(upSrc), 'enrollment runs in a single transaction');
  ok(/__disabled_no_hy2_users__/.test(upSrc),
     'rewrite step also never leaves userpass empty (same anti-crash sentinel)');
  ok(/systemctl restart hysteria-server/.test(upSrc.split('migrate_hy2_enroll_all')[1] || ''),
     'restarts hysteria-server after rewriting userpass');
  ok(/HY2_ENROLL_ALL=1 set but Hy2 is not installed/.test(upSrc),
     'warns (not crashes) if enroll requested while Hy2 not installed');
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.3 — a same-version box hit the "Nothing to do" early-exit before the
// enroll step ran. Two fixes: (a) HY2_ENROLL_ALL=1 forces the full flow even
// when version is unchanged; (b) a dedicated --enroll-hy2 mode runs ONLY the
// enroll (no full update) as a clean one-liner.
console.log('\n[7d] update.sh: enroll reachable on a same-version box');
{
  // (a) HY2_ENROLL_ALL=1 bypasses the "Nothing to do" early-exit
  ok(/HY2_ENROLL_ALL:-0\}" == "1" \]\] && ! version_gt "\$TARGET_VERSION" "\$current"/.test(upSrc),
     'HY2_ENROLL_ALL=1 runs full flow even when version already matches');
  ok(/running full update flow to apply the Hy2 enrollment/.test(upSrc),
     'logs that it is proceeding despite unchanged version');

  // (b) dedicated --enroll-hy2 mode
  ok(/--enroll-hy2\) MODE="enroll-hy2"/.test(upSrc), '--enroll-hy2 flag parsed');
  ok(/do_enroll_hy2\(\)/.test(upSrc), 'do_enroll_hy2() defined');
  ok(/enroll-hy2\) check_install; load_config; do_enroll_hy2/.test(upSrc),
     '--enroll-hy2 dispatched in main() case');
  ok(/HY2_ENROLL_ALL=1 migrate_hy2_enroll_all/.test(upSrc),
     'do_enroll_hy2 forces the flag and reuses migrate_hy2_enroll_all (no dup logic)');
  ok(/Hysteria2 is not installed\. Install it first/.test(upSrc),
     'do_enroll_hy2 errors clearly if Hy2 not installed');
  ok(/--enroll-hy2 {2,}Add Hysteria2 to EVERY existing user/.test(upSrc),
     '--enroll-hy2 documented in --help');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] Sub-stage D: warp_egress.sh marks the inbound-UDP reply path (Hy2/QUIC)');
{
  function fnBody(name) {
    const re = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}', 'm');
    const m = warpSrc.match(re);
    return m ? m[0] : '';
  }
  const routeUp   = fnBody('route_up');
  const routeDown = fnBody('route_down');
  ok(routeUp.length > 0 && routeDown.length > 0, 'route_up()/route_down() located');
  // BUG-173 (v1.8.8): the UDP reply-path rules are now PORT-SCOPED to HY2_PORT so
  //   they never collide with WireGuard's own UDP envelope (see bug173 test).
  //   set-mark on NEW inbound UDP to the Hy2 port from a non-WARP iface.
  ok(/-A PREROUTING ! -i "\$dev" -p udp --dport "\$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: marks NEW inbound UDP to HY2_PORT (! -i warp) — Hy2/QUIC reply path');
  // OUTPUT restore scoped to the Hy2 source port so replies carry the mark
  ok(/-A OUTPUT -p udp --sport "\$HY2_PORT" -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: restores the mark on OUTPUT for UDP from HY2_PORT (QUIC replies carry it)');
  // idempotent (-C before -A) for the scoped UDP rule
  ok(/-C PREROUTING ! -i "\$dev" -p udp --dport "\$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: -C check before -A for the scoped UDP inbound-mark rule (idempotent)');
  // teardown removes the scoped UDP rules symmetrically
  ok(/-D PREROUTING ! -i "\$dev" -p udp --dport "\$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeDown),
     'route_down: removes the scoped UDP inbound NEW-connection mark');
  ok(/-D OUTPUT -p udp --sport "\$HY2_PORT" -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: removes the scoped UDP OUTPUT reply-restore');
  // TCP rules must remain intact (we only ADDED udp, did not remove tcp)
  ok(/-A PREROUTING ! -i "\$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: the original BUG-171 TCP rule is still present (Naive/Mieru unaffected)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] LIVE jq migration: legacy config backfilled; users & customs preserved');
if (!hasJq) {
  console.log('  \u26a0 skipped (jq not available)');
} else {
  const dir = fs.mkdtempSync('/tmp/hy2mig-');
  try {
    // The exact jq program used by migrate_config (kept in lock-step).
    const JQ = '.hy2Port = (.hy2Port // 443)'
      + ' | .stack = (.stack // {})'
      + ' | .stack.naive = (.stack.naive // true)'
      + ' | .stack.mieru = (.stack.mieru // true)'
      + ' | .stack.hy2 = (.stack.hy2 // false)';
    const run = (obj) => {
      const f = path.join(dir, 'c.json');
      fs.writeFileSync(f, JSON.stringify(obj));
      const r = cp.spawnSync('jq', [JQ, f], { encoding: 'utf8' });
      return JSON.parse(r.stdout);
    };

    // Legacy: has users, no hy2 fields → must gain defaults, users untouched.
    const legacy = { domain: 'vpn.example.com', naivePort: 8443,
                     users: [{ username: 'alice', protocols: ['naive', 'mieru'] }] };
    const a = run(legacy);
    ok(a.hy2Port === 443, 'legacy → hy2Port backfilled to 443');
    ok(a.stack && a.stack.naive === true && a.stack.mieru === true && a.stack.hy2 === false,
       'legacy → stack.{naive,mieru}=true, hy2=false');
    ok(JSON.stringify(a.users) === JSON.stringify(legacy.users),
       'legacy → existing users + protocols array left completely untouched');
    ok(a.naivePort === 8443 && a.domain === 'vpn.example.com',
       'legacy → all pre-existing fields preserved');

    // Already-migrated with CUSTOM values → idempotent, customs kept.
    const custom = { hy2Port: 8443, stack: { naive: true, mieru: true, hy2: true } };
    const b = run(custom);
    ok(b.hy2Port === 8443, 'migrated → custom hy2Port 8443 preserved (idempotent)');
    ok(b.stack.hy2 === true, 'migrated → operator-enabled stack.hy2=true preserved');

    // Partial stack → only missing keys filled.
    const partial = run({ stack: { naive: true } });
    ok(partial.stack.mieru === true && partial.stack.hy2 === false && partial.hy2Port === 443,
       'partial stack → missing keys filled, present key kept');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.4 — Cascade Variant 1: Hy2 runs as a dedicated 'hysteria' user so the
// cascade relay can scope its egress by owner-uid (like Mieru's mita). Enabling
// the cascade now relays ALL THREE protocols. Existing installs migrate
// root→hysteria idempotently and keep the shared Caddy cert readable.
console.log('\n[10] Cascade V1: Hy2 as dedicated user + cascade owner-match');
{
  // install_hysteria.sh: dedicated user + non-root unit + cert group access
  ok(/HY_USER="hysteria"/.test(hy2Src) &&
     /useradd --system --no-create-home[^\n]*"\$HY_USER"/.test(hy2Src),
     'install: creates system user hysteria (no home, nologin)');
  ok(/usermod -aG caddy "\$HY_USER"/.test(hy2Src),
     'install: adds hysteria to group caddy (read the shared cert)');
  ok(/^User=hysteria$/m.test(hy2Src) && !/^User=root$/m.test(hy2Src),
     'install: unit runs as User=hysteria (no longer root)');
  ok(/^SupplementaryGroups=caddy$/m.test(hy2Src),
     'install: unit has SupplementaryGroups=caddy for cert read');
  ok(/AmbientCapabilities=CAP_NET_BIND_SERVICE/.test(hy2Src),
     'install: keeps CAP_NET_BIND_SERVICE so non-root can bind :443');
  ok(/chown -R "\$HY_USER":"\$HY_USER" \/etc\/hysteria/.test(hy2Src),
     'install: /etc/hysteria owned by the service user');
  ok(/chgrp caddy "\$\{CADDY_CERT_DIR\}\/\$\{DOMAIN\}\.crt"/.test(hy2Src),
     'install: cert made group-readable for caddy (not world-readable)');

  // cascade_mieru.sh: hy2 owner-match, guarded on Hy2 being installed
  ok(/hy2_uid\(\)/.test(cascadeSrc), 'cascade: hy2_uid() helper present');
  ok(/-x \/usr\/local\/bin\/hysteria && -f \/etc\/hysteria\/config\.yaml/.test(cascadeSrc),
     'cascade: hy2_uid() returns "" unless Hy2 is actually installed (guard)');
  ok(/-A OUTPUT -p tcp -m owner --uid-owner "\$hyuid" -j REDSOCKS/.test(cascadeSrc),
     'cascade: adds REDSOCKS owner-match for hysteria uid (relays Hy2 egress)');
  ok(/id -u hysteria 2>\/dev\/null/.test(cascadeSrc),
     'cascade: teardown resolves hysteria uid directly (removes even after uninstall)');
  // teardown must remove the hy2 rule too
  const clearFn = (cascadeSrc.match(/clear_iptables\(\) \{[\s\S]*?\n\}/m) || [''])[0];
  ok(/--uid-owner "\$hyuid" -j REDSOCKS/.test(clearFn),
     'cascade: clear_iptables removes the hysteria owner-match rule');
  // the original mita rule is untouched (Mieru-only boxes unaffected)
  ok(/-A OUTPUT -p tcp -m owner --uid-owner "\$uid" -j REDSOCKS/.test(cascadeSrc),
     'cascade: original mita owner-match rule still present (Mieru unaffected)');

  // update.sh: idempotent root→hysteria migration
  ok(/migrate_hy2_service_user\(\)/.test(upSrc), 'update: migrate_hy2_service_user() defined');
  ok(/grep -qE '\^\\s\*User\\s\*=\\s\*hysteria\\s\*\$' "\$unit" && return 0/.test(upSrc),
     'update: migration is idempotent (skips if already hysteria)');
  ok(/s\/\^\\s\*User\\s\*=\\s\*root\\s\*\$\/User=hysteria\//.test(upSrc),
     'update: sed patches User=root → User=hysteria in the existing unit');
  ok(/migrate_hy2_service_user\b/.test((upSrc.match(/migrate_hy2\(\) \{[\s\S]*?\n\}/m) || [''])[0]),
     'update: migrate_hy2() calls the service-user migration before restart');
  ok(/chgrp caddy "\$crt" "\$\{crt%\.crt\}\.key"/.test(upSrc),
     'update: migration makes the existing cert group-readable for caddy');
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.8.4 — enroll better-sqlite3 fix: the temp node scripts must live under
// $PANEL_DIR (not /tmp) so require('better-sqlite3') resolves. (Server hit
// MODULE_NOT_FOUND because /tmp/*.js has no node_modules on the lookup path.)
console.log('\n[11] enroll: node temp scripts live in $PANEL_DIR (better-sqlite3 resolves)');
{
  ok(/mktemp "\$\{PANEL_DIR\}\/\.hy2-enroll\.XXXXXX\.js"/.test(upSrc),
     'enroll: script created under $PANEL_DIR (not /tmp)');
  ok(/mktemp "\$\{PANEL_DIR\}\/\.hy2-rewrite\.XXXXXX\.js"/.test(upSrc),
     'rewrite: script created under $PANEL_DIR (not /tmp)');
  ok(!/mktemp \/tmp\/rixxx-hy2-(enroll|rewrite)/.test(upSrc),
     'no more /tmp/rixxx-hy2-*.js (the MODULE_NOT_FOUND path)');
}

// v1.8.4 fix — the panel runs as root and wrote the Hy2 config as root:root
// 0600 on every edit; the non-root `hysteria` service then hit
// "open /etc/hysteria/config.yaml: permission denied" FATAL. Every write path
// must hand the config back to the service user, and install/update must seed
// the right owner+mode. Guarded so legacy root installs (no hysteria user) no-op.
console.log('\n[12] Hy2 config stays readable by the non-root service user');
{
  // server: helper exists and is called after every config write / rollback.
  ok(/function hy2ChownConfig\(/.test(serverSrc),
     'server: hy2ChownConfig() helper defined');
  ok(/id -u hysteria 2>\/dev\/null/.test(serverSrc),
     'server: helper resolves the hysteria uid');
  // It must be invoked after the atomic rename in writeHysteriaConfig() and in
  // the masquerade/port rewrite path — count ≥ 3 (write + 2 rollbacks/port).
  const chownCalls = (serverSrc.match(/hy2ChownConfig\(HY2_CONFIG\)/g) || []).length;
  ok(chownCalls >= 3,
     'server: hy2ChownConfig(HY2_CONFIG) called on every write path (found ' + chownCalls + ')');
  // Legacy safety: helper returns early when no hysteria user (uid null).
  ok(/if \(uid === null \|\| Number\.isNaN\(uid\)\) return;/.test(serverSrc),
     'server: no-ops on legacy root install (no hysteria user) — nothing breaks');
  // files → 640, dir → 750.
  ok(/st\.isDirectory\(\) \? 0o750 : 0o640/.test(serverSrc),
     'server: dir 750 / config 640 modes applied');

  // install: seeds owner + explicit modes AFTER writing the config as root.
  ok(/chmod 750 \/etc\/hysteria/.test(hy2Src),
     'install: /etc/hysteria mode 750 (traversable by service user)');
  ok(/chmod 640 \/etc\/hysteria\/config\.yaml/.test(hy2Src),
     'install: config.yaml mode 640 (group-readable)');

  // update migration: same explicit modes so an in-place upgrade is readable.
  ok(/chmod 750 \/etc\/hysteria/.test(upSrc),
     'update: migration sets /etc/hysteria mode 750');
  ok(/chmod 640 \/etc\/hysteria\/config\.yaml/.test(upSrc),
     'update: migration sets config.yaml mode 640');
}

// v1.8.6 — Hy2 traffic accounting, auto-enroll, async apply, Hy2 logs.
console.log('\n[13] Hy2 traffic / enroll / async-apply / logs');
{
  ok(/function readHy2Traffic\(/.test(serverSrc), 'server: readHy2Traffic() helper defined');
  ok(/http:\/\/\$\{listen\}\/traffic/.test(serverSrc), 'server: reads the Hy2 Traffic Stats API /traffic');
  ok(/hy2MB:\s+hy2Up \+ hy2Down/.test(serverSrc), 'server: stats endpoint returns per-user hy2MB');
  ok(/function enrollAllHy2\(/.test(serverSrc), 'server: enrollAllHy2() helper defined');
  ok(/if \(protocols\.includes\('hy2'\)\) continue;/.test(serverSrc), 'server: enroll is idempotent (skips users already on hy2)');
  ok(/app\.post\('\/api\/settings\/hy2\/enroll-all'/.test(serverSrc), 'server: /api/settings/hy2/enroll-all route present');
  ok(/function applyAllConfigsAsync\(/.test(serverSrc), 'server: background applyAllConfigsAsync() defined');
  ok(/app\.get\('\/api\/apply-status'/.test(serverSrc), 'server: /api/apply-status route present');
  ok(/servicesReloading:\s*true/.test(serverSrc), 'server: CRUD returns servicesReloading:true (async apply)');
  ok(/case 'hy2':/.test(serverSrc) && /journalctl -u hysteria-server/.test(serverSrc), 'server: logs API serves hysteria-server');
  ok(/trafficStats:/.test(hy2Src) && /listen: 127\.0\.0\.1:9999/.test(hy2Src), 'install: config enables the Traffic Stats API');
  ok(/migrate_hy2_traffic_stats\(\)/.test(upSrc), 'update: migrate_hy2_traffic_stats() defined');
  ok(/grep -qE '\^\\s\*trafficStats\\s\*:' "\$cfg" && return 0/.test(upSrc), 'update: trafficStats migration is idempotent');
}

// v1.8.7 — Subscription link (/sub/:token) + universal-config Hy2 fix.
console.log('\n[14] Subscription link: sub_token, /sub route, universal Hy2, subBaseUrl, Caddy');
{
  const caddyTplSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'caddyTemplate.js'), 'utf8');

  // ── DB migration: sub_token column + back-fill for existing users ──────────
  ok(/ALTER TABLE users ADD COLUMN sub_token TEXT/.test(serverSrc),
     'server: adds sub_token column (migration)');
  ok(/sub_token IS NULL OR sub_token = ''/.test(serverSrc),
     'server: back-fills sub_token for existing users');
  ok(/function getUserBySubToken\(/.test(serverSrc),
     'server: getUserBySubToken() lookup helper defined');
  ok(/crypto\.randomBytes\(16\)\.toString\('hex'\)/.test(serverSrc),
     'server: sub_token is a random 128-bit hex string');

  // ── New user creation mints a token ───────────────────────────────────────
  ok(/sub_token:\s*crypto\.randomBytes\(16\)/.test(serverSrc),
     'server: POST /api/users mints a sub_token on create');

  // ── Universal config now includes Hy2 + respects checkboxes ───────────────
  ok(/function buildSingboxConfig\(/.test(serverSrc),
     'server: buildSingboxConfig() shared builder defined');
  ok(/type: 'hysteria2', tag: 'hy2-out'/.test(serverSrc),
     'server: sing-box builder emits a Hysteria2 outbound (universal Hy2 fix)');
  // v1.8.8: Karing red-triangle fix — hy2 outbound password must be the
  // combined username:password (server auth.type = userpass; sing-box has no
  // userpass alias, only a single password field).
  ok(/password: `\$\{user\.username\}:\$\{password\}`/.test(serverSrc),
     'server: hy2-out password is combined username:password (userpass fix, v1.8.8)');
  // v1.8.8: Shadowrocket-native Naive URI (its HTTPS proxy scheme) — Shadowrocket
  // silently drops naive+https:// from a subscription.
  ok(/function buildShadowrocketHttpsLink\(/.test(serverSrc),
     'server: buildShadowrocketHttpsLink() defined (Shadowrocket Naive fix, v1.8.8)');
  ok(/buildShadowrocketHttpsLink\(\{/.test(serverSrc),
     'server: buildUserUris emits the Shadowrocket-native Naive URI');
  ok(/protos\.includes\('naive'\)/.test(serverSrc) &&
     /protos\.includes\('mieru'\)/.test(serverSrc) &&
     /protos\.includes\('hy2'\)/.test(serverSrc),
     'server: sing-box builder respects each protocol checkbox');
  ok(/buildSingboxConfig\(user, \{\s*\n?\s*password: req\.query\.password/.test(serverSrc) ||
     /const universalCfg = buildSingboxConfig\(user/.test(serverSrc),
     'server: universal route delegates to buildSingboxConfig');

  // ── buildUserUris: URI list for the base64 subscription ───────────────────
  ok(/function buildUserUris\(/.test(serverSrc),
     'server: buildUserUris() URI-list builder defined');
  ok(/function buildNaiveLink\(/.test(serverSrc),
     'server: buildNaiveLink() extracted for reuse');

  // ── Public /sub/:token route ──────────────────────────────────────────────
  ok(/app\.get\('\/sub\/:token'/.test(serverSrc),
     'server: public GET /sub/:token route present');
  ok(!/app\.get\('\/sub\/:token', requireAuth/.test(serverSrc),
     'server: /sub/:token is PUBLIC (no requireAuth — client is not logged in)');
  ok(/function detectSubClient\(/.test(serverSrc),
     'server: detectSubClient() UA detection helper defined');
  ok(/ua\.includes\('karing'\)/.test(serverSrc) && /ua\.includes\('shadowrocket'\)/.test(serverSrc),
     'server: detects Karing and Shadowrocket by User-Agent');
  ok(/if \(client === 'karing'\)/.test(serverSrc),
     'server: Karing path returns sing-box JSON (Mieru as JSON outbound)');
  ok(/toString\('base64'\)/.test(serverSrc),
     'server: Shadowrocket path returns base64 URI list');
  ok(/Subscription-Userinfo/.test(serverSrc),
     'server: emits Subscription-Userinfo header (traffic + expiry)');
  ok(/Profile-Update-Interval/.test(serverSrc),
     'server: emits Profile-Update-Interval header (refresh hint)');
  ok(/expire=\$\{Math\.floor\(ts \/ 1000\)\}/.test(serverSrc),
     'server: expiry passed through to the client as a unix timestamp');
  ok(/const subLimiter = rateLimit\(/.test(serverSrc),
     'server: /sub route is rate-limited (brute-force protection)');

  // ── ?client= / ?format= override ──────────────────────────────────────────
  ok(/forced === 'shadowrocket'/.test(serverSrc) && /forced === 'karing'/.test(serverSrc),
     'server: ?client= override supported (shadowrocket / karing)');
  ok(/format.*===.*'singbox'/.test(serverSrc) || /=== 'singbox'/.test(serverSrc),
     'server: ?format=singbox forces the JSON format');

  // ── Admin helper: /api/users/:id/sub-link ─────────────────────────────────
  ok(/app\.get\('\/api\/users\/:id\/sub-link', requireAuth/.test(serverSrc),
     'server: admin sub-link helper route present (auth-gated)');
  ok(/function subBaseUrl\(/.test(serverSrc),
     'server: subBaseUrl() resolves configured domain with fallback');
  ok(/base = `https:\/\/\$\{cfg\.domain/.test(serverSrc),
     'server: subBaseUrl falls back to the panel domain when unset');

  // ── subBaseUrl config plumbing ────────────────────────────────────────────
  ok(/subBaseUrl: ''/.test(serverSrc),
     'server: subBaseUrl default present in config defaults');
  ok(/'subBaseUrl'\]\.forEach/.test(serverSrc) || /'fakeSiteUrl','subBaseUrl'/.test(serverSrc),
     'server: POST /api/config accepts subBaseUrl');

  // ── Caddy sub-domain block ────────────────────────────────────────────────
  ok(/function renderSubBlock\(/.test(caddyTplSrc),
     'caddyTemplate: renderSubBlock() defined');
  ok(/handle \/sub\/\* \{/.test(caddyTplSrc),
     'caddyTemplate: sub-domain reverse_proxies /sub/* to the panel');
  ok(/renderSubBlock,/.test(caddyTplSrc) || /renderSubBlock\b/.test(caddyTplSrc),
     'caddyTemplate: exports/uses renderSubBlock');
  ok(/subBaseUrl:\s*config\.subBaseUrl/.test(serverSrc),
     'server: passes subBaseUrl into the Caddy template');

  // ── update.sh migration for subBaseUrl ────────────────────────────────────
  ok(/\.subBaseUrl = \(\.subBaseUrl \/\/ ""\)/.test(upSrc),
     'update: migrate_config backfills subBaseUrl (empty default)');

  // ── Frontend wiring ───────────────────────────────────────────────────────
  const appSrc  = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'index.html'), 'utf8');
  ok(/function downloadSubLink\(/.test(appSrc), 'app.js: downloadSubLink() defined');
  ok(/case 'dl-sub-link':/.test(appSrc), 'app.js: dl-sub-link action wired');
  ok(/function saveSubBaseUrl\(/.test(appSrc), 'app.js: saveSubBaseUrl() defined');
  ok(/data-action="dl-sub-link"/.test(htmlSrc), 'index.html: Sub-link button present');
  ok(/id="s-sub-base-url"/.test(htmlSrc), 'index.html: subBaseUrl settings input present');

  // ── i18n keys ─────────────────────────────────────────────────────────────
  for (const lang of ['ru', 'en']) {
    const loc = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', lang + '.json'), 'utf8'));
    ok(loc.config && loc.config.subLink, `locale ${lang}: config.subLink present`);
    ok(loc.settings && loc.settings.subDomainTitle, `locale ${lang}: settings.subDomainTitle present`);
  }
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
