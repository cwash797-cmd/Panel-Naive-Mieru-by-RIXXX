# Changelog — Panel Naive + Mieru by RIXXX

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v1.10.1]

### Fixed (CRITICAL) — "Довыпуск" failed with `fetch failed` / `401 Unauthorized`

PR-3b (v1.10.0) added the `POST /api/federation/provision` node endpoint, but the
Caddy **sub-domain block only proxied `/api/federation/fetch`** — it never
forwarded `/provision`. So a broadcast ("довыпуск") request to
`https://<sub-domain>/api/federation/provision` fell through to the sub-block's
catch-all and was rejected (**401/404**) — the hardened handler was never reached.
The hub surfaced this as `Довыпущено на 0/N нод` with `fetch failed` /
`401 Unauthorized` in the console.

**Fix:** the sub-domain block now proxies the whole **`/api/federation/*`**
prefix instead of pinning `/fetch` alone (in both the canonical
`caddyTemplate.renderSubBlock()` and the inline fallback in `index.js`). This
exposes `/fetch`, `/provision`, and any future federation endpoint uniformly.
It stays safe because **every** federation endpoint is individually hardened
(bearer token, constant-time compare, POST-only, 404-on-suspicious, rate-limited).

> After updating, on **each node** reload Caddy so the new sub-block takes
> effect: `sudo systemctl reload caddy-naive` (the panel does this automatically
> on the next settings save, but a manual reload applies it immediately). Both
> the hub **and** every node must be on ≥ v1.10.1.

### Changed — provisioned users keep the SAME username as on the hub

When a node creates a user during a broadcast it now uses the **exact username
the hub sent** (the email is already identical — it's the match key), instead of
deriving a name from the email. A numeric suffix is appended **only** if that
username is already taken on the node by a genuinely different user, so a deploy
still can never fail on a `UNIQUE(username)` clash. Existing users are updated in
place and keep their current username, password, and subscription token.

New/updated tests: `feat-federation-broadcast.test.js` (66 assertions — adds the
`/api/federation/*` Caddy-prefix checks and the same-username-as-hub assertion);
`feat-federation.test.js` (86 assertions — Caddy exposure now asserts the prefix).

---

## [v1.10.0]

### Added — Federation broadcast provision ("довыпуск") — PR-3b

Building on the read/aggregation federation from v1.9.5 (PR-3a), you can now
**deploy a user to every linked panel with one click**. Next to each user (when
this hub has at least one enabled federation node *and* the user has an email) a
**«Довыпуск» / «Deploy»** button appears. Clicking it creates — or idempotently
updates — that user on every enabled node, keyed by their **email** (the same
cross-server key the read path already uses).

- **Node side** — new `POST /api/federation/provision` endpoint, hardened
  **identically** to `/api/federation/fetch`: feature is OFF (bare 404) unless a
  node token is configured, requires a bearer token compared in constant time,
  POST-only, and rate-limited by the same `fedLimiter`. It upserts by email:
  - an **existing** user is updated (protocols / quota / expiry) — the node's
    **own local password and subscription token are left untouched**, so a node
    never learns another node's password and re-deploying never rotates a link;
  - a **new** user is created with a **fresh random password minted locally on
    that node** and its own subscription token, so it's immediately usable. The
    username is de-collided automatically, so a deploy can never fail on a
    username clash.
- **Hub side** — `broadcastProvision(user)` POSTs to every enabled node **in
  parallel** with a hard per-node timeout. A dead / old / wrong-token node is
  reported as a per-node failure and **never aborts the rest of the broadcast**.
- **Admin API** — `POST /api/users/:id/federation/deploy` (auth-gated) returns a
  **per-node result summary**; the UI shows how many nodes succeeded and names
  any that failed. The action asks for confirmation and is fully idempotent, so
  re-clicking is always safe.

Nothing changes for single-server installs: with no federation nodes configured
the button never appears and every existing endpoint behaves byte-identically.

New tests: `feat-federation-broadcast.test.js` (59 assertions — node endpoint
hardening, hub broadcast against live throwaway nodes incl. new/known/dead/
wrong-token/mixed-mesh cases, the no-password guarantee, admin route + UI +
i18n contracts).

---

## [v1.9.9]

### Fixed (CRITICAL) — subscription download broke with a TLS handshake error

After a burst of user edits (typically while wiring up federation — adding an
email to several existing users), clients suddenly **could not download the
subscription at all**: Shadowrocket/Karing/NekoBox showed a TLS handshake
failure (`HandshakeException … TLSV1_ALERT_INTERNAL_ERROR`) and **both** the
main and the federated nodes vanished. A page refresh didn't help because the
problem was the TLS layer, not the config content.

Root cause: `applyCaddyConfig()` runs after **every** user CRUD, and it did a
**full `systemctl restart caddy-naive`**. On a server with a dedicated
subscription sub-domain (`cfg.subBaseUrl`), each restart tears down the
listeners and makes Caddy re-load / re-provision its TLS certificates. A rapid
series of edits becomes a restart-storm that can leave the sub-domain **without
a live certificate mid-flight** — so the `/sub` TLS handshake fails.

Fix: prefer a **graceful reload**. The `caddy-naive.service` unit already ships
`ExecReload=/bin/kill -USR1 $MAINPID`, and per the official Caddy docs a SIGUSR1
has "the same effect as `caddy reload` with the currently loaded config" — it
hot-swaps the just-written Caddyfile **without dropping listeners or certs**, and
works even with `admin off`. `applyCaddyConfig()` now:

1. validates the Caddyfile first (unchanged);
2. if the service is active → `systemctl reload` (graceful, **no cert churn, no
   TLS gap**);
3. only falls back to a full `restart` if reload isn't possible or fails
   (still clearing any prior failure storm with `reset-failed`);
4. re-verifies the service is active afterwards (both paths).

This removes the restart-storm entirely for the common case (content-only
Caddyfile changes), so subscription downloads stay up during heavy editing.
Port/domain changes still use an explicit restart where needed. Covered by
`tests/bug-caddy-reload-cert-churn.test.js` (11 assertions). Full suite: **896
passed, 0 failed**.

> Note: this bug is **infrastructure/TLS-level**, independent of the v1.9.8
> federation parsing work — the sing-box aggregation itself is verified healthy
> (panel boots, `/sub` returns valid base64 + valid sing-box JSON with all
> outbounds). If a sub-domain cert was already knocked out by the storm, run
> `sudo systemctl restart caddy-naive` once on the server to let Caddy
> re-provision it cleanly; from then on reloads keep it stable.

---

## [v1.9.8]

### Fixed — federation into sing-box clients (NekoBox+/Karing) only pulled Hy2

After v1.9.6 fixed the transport, a **Shadowrocket** hub correctly pulled all 3
of a peer's configs — but **NekoBox+ / Karing** (and the whole sing-box family)
saw only **one** peer config, shown as `fed-3` and often flagged **"DNS
resolution error"**. Naive and Mieru from the peer were silently missing.

Root cause: the sing-box `/sub` path pulled the peer's **URI list** and tried to
translate each URI back into a sing-box outbound. But a peer emits its Naive URI
as `https://<base64>…` (Shadowrocket's HTTPS-proxy form) and its Mieru URI as
`mierus://…` — **neither is understood** by the URI→outbound translator (it only
knows vless/vmess/trojan/ss/hysteria2). So Naive and Mieru were dropped and only
the peer's Hy2 URI survived — appearing as the lone `fed-3`.

Fix — federation now hands sing-box hubs **ready-made outbounds** instead of a
lossy URI list:

- **New shared `buildProxyOutbounds(user, opts)`** — the single source of truth
  for a user's naive/mieru/hy2 (+ bonus) sing-box outbounds. `buildSingboxConfig()`
  now delegates to it, so behaviour is byte-identical for existing installs.
- **Node side** — `POST /api/federation/fetch` accepts `format: "singbox"` and
  then returns proper `{ uris, outbounds }` (every protocol correctly encoded
  with the peer's own domain/IP + SNI, so no more DNS/parse breakage). Plain
  requests still get `{ uris }`, so nothing else changes.
- **Hub side** — new `fetchFederatedOutbounds()` pulls those outbounds in
  parallel (same hard timeout + soft-skip guarantees as the URI path), gives each
  a **globally-unique tag** (`…-fed1`, deduped against local tags) and adds it to
  the urltest/selector. An **old peer** that only returns `uris` still contributes
  whatever the translator can parse (unchanged fallback — never a regression).

Covered by `tests/feat-federation.test.js` (now 85 assertions: live cases J–N
prove all 3 peer protocols cross the link, tags stay unique, old-peer fallback,
and a dead peer is soft-skipped). Full suite: **885 passed, 0 failed**.

---

## [v1.9.7]

### Fixed — editing an existing user showed "failed" even though it saved

Opening a previously-created user and, say, adding an email would flash a
"failed …" error — yet after a manual page refresh (F5) the change was in fact
saved. Nothing was actually broken on the server; it was a **client-side race**.

Root cause (BUG-176 async-apply race): a user create/edit responds instantly and
then regenerates the Caddyfile and restarts caddy/mita/hy2 **in the background**
(`applyAllConfigsAsync`). The UI immediately did `await loadUsers()` to refresh
the table, and because that GET travels through Caddy, it could land inside the
brief reload window — where `fetch()` rejects with a transport error
("Failed to fetch"). The old code surfaced that refresh error as a **save**
error, even though the write had already persisted.

Fix (front-end only, no server/behaviour change for existing installs):

- **`api()`** gains an opt-in **silent, retrying GET** for *transport* errors
  only (never retries mutations, never hides a real HTTP 4xx/5xx). Off by
  default, so every existing call is byte-for-byte unchanged.
- **`loadUsers(opts)`** forwards `{ retry, silent }`, and a failed *background*
  refresh re-throws instead of painting the table red.
- **`saveUser()`** now closes the modal on success, then refreshes with
  `loadUsers({ retry: 3 })`; if the panel is still briefly unreachable it shows a
  gentle "saved — the list will update shortly" hint (`users.savedRefreshHint`)
  rather than a false "save failed".

New i18n key `users.savedRefreshHint` (ru/en). Covered by
`tests/bug-user-edit-race.test.js` (live silent-retry + source/i18n contracts).

---

## [v1.9.6]

### Fixed — Federation node endpoint was not reachable from the internet

PR-3a added the `POST /api/federation/fetch` handler but never exposed it
through Caddy, so a hub panel calling a peer got the peer's **fake/masquerade
site** (e.g. a `405 Method Not Allowed` from the decoy stack) instead of the
panel — federation silently pulled nothing.

The panel is only reverse-proxied on two external surfaces: the panel subdomain
(`/<webBasePath>/*`, behind basic-auth — unusable for peers) and the
**subscription sub-domain** (`/sub/*`). Fix: the subscription sub-domain block
now **also proxies `/api/federation/fetch`** to the loopback panel — next to
`/sub`, where it belongs. The endpoint is already hardened (bearer token,
POST-only, 404-on-anything-suspicious, constant-time compare, rate-limited), so
it is safe to sit on the public sub-domain.

Both Caddyfile renderers are patched in lockstep: the canonical
`caddyTemplate.renderSubBlock()` (used by `install.sh` / `update.sh`) and the
inline fallback in `index.js`.

**Config for the admin:** a peer's URL in the Federation page must be that
panel's **subscription domain** (Settings → Subscription Domain, e.g.
`https://sub.example.com`) — **not** its main/fake-site domain. The peer node
therefore needs a subscription domain configured. The Federation UI now says so
(field renamed to "Peer sub-domain URL" + an explicit hint; the node-token card
also notes the sub-domain requirement). ru/en both updated.

No sub-domain configured ⇒ the block isn't emitted and the federation endpoint
stays unexposed — behaviour is unchanged for anyone not using federation.

`feat-federation.test.js` grew Caddy-routing assertions (now **70**): the sub
block proxies both `/sub/*` and `/api/federation/fetch`, the inline fallback
mirrors it, and no sub-domain ⇒ no block. Full suite green.

---

## [v1.9.5]

### Added — Federation (multi-panel link, part 1: read + aggregation)

Link several panels so **one subscription link delivers configs from multiple
servers**. Users are matched across servers by their **email**. Topology is
**hub → node, one-way pull**: the main panel pulls configs from the peer nodes
you add, and merges them into each user's `/sub`.

New **Federation** page (dedicated left-menu item) with two roles, both optional
and independent:

- **This server's node token** — a secret bearer token (generate / copy / save).
  Give it to your main panel so it can pull this server's configs. Empty ⇒ this
  server does not answer federation requests at all.
- **Peer servers** — the list of other panels this one pulls from
  (`name`, base `url`, that panel's node token, enable toggle). Add / enable /
  disable / remove from the UI.

Node endpoint `POST /api/federation/fetch` is deliberately paranoid: **POST-only**,
**bearer token** must equal `federationToken`, **constant-time** compare
(`timingSafeEqual` over SHA-256 digests), and **any** anomaly (feature off,
missing/short/wrong token, wrong verb) returns the **same bare 404** — a probe
can't even tell the feature exists. Unknown email ⇒ `200` with an empty list.
Rate-limited (per-minute cap) on top of the global API limiter.

Aggregation in `/sub` can **never break a subscription**:

- No email on the user ⇒ no pull (email is the only cross-server key).
- No enabled peers ⇒ output is **byte-identical** to pre-federation.
- Each peer is fetched **in parallel** with a hard **timeout**; a slow / dead /
  erroring / wrong-token / non-200 peer is **silently skipped**.
- Works for **both** subscription formats: base64 URI list (Shadowrocket / Happ /
  v2ray) and sing-box JSON (Karing / NekoBox / Exclave / Throne — peer URIs
  become `fed-N` outbounds, with the selector/urltest members extended so refs
  resolve). Peer URIs are de-duplicated against the local ones.

Secrets never reach the browser: `GET /api/config` masks `federationToken` →
boolean `federationTokenSet` and each node's `token` → boolean `tokenSet`;
`POST /api/config` preserves an unchanged node token by `id`, so re-saving the
list from the UI can't wipe a secret.

Existing installs are unaffected: `federationToken` defaults to `''` and
`federationNodes` to `[]`, so with no configuration `/sub` behaves exactly as
before. A small hint on the user form nudges admins to add an email so a user's
configs are pulled across federated servers.

Backend: `feat-federation.test.js` (63 assertions) — a **live** 2-process test
(hub `fetchFederatedUris` ↔ a real node endpoint) plus the endpoint / UI / i18n
contracts. Full suite green.

---

## [v1.9.4]

### Added — per-server display flag / label on all issued configs

The admin can now set a cosmetic **flag/prefix** (e.g. `🇷🇺` or `🇳🇱 RP`) in
**Settings → Server flag / label**. It is prepended to the **display name** of
every standard config this server hands out — **naive / mieru / hy2** — in
**both** the base64 URI list (Shadowrocket / Happ / v2ray) **and** the sing-box
JSON (Karing / NekoBox / Exclave / Throne):

- base64 path — the flag goes into the label: naive `?remarks=`, and the
  `#fragment` of the mieru and hy2 URIs.
- sing-box path — the outbound `tag` (which is both the client-visible node
  name **and** the urltest selector reference) is prefixed with the flag; the
  selector references are prefixed identically, so they always resolve.

It is a **label only** — it never touches credentials, host, port or protocol,
so it can never break a connection. Applied **live** by the sub builders: no
Caddy rebuild, no service restart — toggling it is instant, and clients pick up
the new name on their next subscription refresh.

**Bonus links are intentionally NOT flagged** — the admin puts a flag straight
into the bonus link's own `#fragment` if they want one.

Also lays groundwork for panel-linking (#3): when configs from several servers
are merged into one subscription, each server's own flag makes it obvious which
node a config belongs to.

### Compatibility

- No schema change, no migration. `serverFlag` defaults to empty, and an empty
  flag produces **byte-identical** output to v1.9.3 (hy2 URI still `#username`,
  sing-box tags still `naive-out`/`mieru-out`/`hy2-out`). Existing installs and
  clients are unaffected until the admin sets a flag.

---

## [v1.9.3]

### Added — change the fake (masquerade) site straight from the panel

The fake site — what a browser sees when it opens the server domain (DPI /
active-probe camouflage) — was only settable **at install time on the server**.
Now the admin can change it from **Settings → Fake site (masquerade)**:

- New field + **Save Fake Site** button on the settings page (ru/en i18n).
- Enter a full `https://…` URL to **reverse-proxy a real site**, or leave the
  field **empty** to serve the **built-in default fake site** bundled with the
  panel. The `example.com` install-time placeholder is shown as blank.
- `POST /api/config` now **validates** `fakeSiteUrl` (must be a full `http(s)://`
  URL or empty — a bad value is rejected with `400` and never persisted) and,
  on change, **rebuilds the Caddyfile + reloads Caddy** so the new camouflage
  goes live immediately — no SSH needed.

### Fixed — fakeSiteUrl changes now actually take effect

Previously `fakeSiteUrl` was saved to the config but **only a `subBaseUrl`
change triggered a Caddyfile rebuild**, so editing the fake site had no effect
until the next unrelated rebuild. The rebuild now fires when **either**
`subBaseUrl` **or** `fakeSiteUrl` changes.

### Compatibility

- No schema change, no migration. The rebuild is best-effort + logged and never
  blocks the save. Installs that never touch the fake site keep the built-in
  default — behaviour is unchanged.

---

## [v1.9.2]

### Added — subscription support for the sing-box family (NekoBox / Exclave / Throne)

The subscription endpoint previously auto-detected only **Karing** and
**Shadowrocket**. Based on a user poll we now also serve **NekoBox (android)**,
**Exclave (android)** and **Throne** — all of which are **sing-box-engine**
clients and consume the exact same **sing-box JSON** we already emit for
Karing. There is still exactly **one** JSON code path to maintain; the three
new clients just route onto it.

- `detectSubClient()` now recognises `nekobox` / `exclave` / `throne` in the
  User-Agent and maps them to the sing-box JSON format.
- The manual override is extended too: `?client=nekobox|exclave|throne`
  (and the existing `?client=karing|singbox`, `?format=singbox`) force the
  sing-box JSON — handy for support and testing. A force always beats a
  conflicting User-Agent.
- **Shadowrocket and every unknown client are unchanged** — they keep getting
  the base64 URI list (the safe, widest-compatibility default). Byte-for-byte
  identical output for existing installs.

### Fixed — admin bonus links now reach sing-box clients too

The admin's manually-added personal bonus links (e.g. a `vless://` link) were
appended to the base64 URI list (Shadowrocket) but were **invisible** to the
sing-box JSON path — so Karing/NekoBox/Exclave/Throne never saw them. A new
`bonusUrlToSingboxOutbound()` translates the common bonus schemes
(`vless` / `vmess` / `trojan` / `ss` / `hysteria2`) into sing-box outbounds and
adds them to the config's outbound list **and** the urltest selector. Anything
it can't parse is **silently skipped** — a single malformed bonus link can
never break the whole JSON.

### Compatibility

- No schema change, no migration. Existing Karing/Shadowrocket behaviour is
  preserved exactly; the new clients and the bonus-in-JSON delivery are purely
  additive.

---

## [v1.9.1]

### Fixed — Hy2 crashed when a username contained a dot (subscriber report)

A Hy2 user whose username contained a **dot** (e.g. `ivan.petrov`) took down
Hysteria2 **entirely** — not just for that user. The panel writes the Hy2
`auth.userpass` map as YAML; the password was already quoted, but the
**username (the map KEY) was emitted bare** (`ivan.petrov: "pw"`). A dot in a
bare YAML key is a classic footgun — a single such entry corrupts the whole
`auth.userpass` map, Hysteria rejects the config on reload, and every Hy2
client stops connecting. The panel also **advertises** the dot as allowed
(`USERNAME_RE = [a-zA-Z0-9_.-]`), so the promise and the behaviour disagreed.

- **Fix:** quote the map KEY too — `"ivan.petrov": "pw"` — exactly like the
  value. In YAML a double-quoted key and a bare key denote the identical string
  for plain names, so existing installs authenticate **byte-identically**; only
  dotted / leading-digit / leading-dash usernames get repaired. The username
  validator is **unchanged** (the dot stays allowed — we honour the promise
  rather than take the feature away).
- Also quotes the `__disabled_no_hy2_users__` sentinel key for consistency.

**Tests:** new `bug-hy2-dotted-username.test.js` (14 assertions) — dotted /
leading-digit / leading-dash / multi-dot names now emit unambiguous quoted keys
and parse to exactly one entry; plain usernames unchanged; disabled sentinel
still keeps the service up; validator still permits the dot.

---

## [v1.9.0]

### Added — Personal "bonus links" in a client's subscription

The admin can now manually attach one or more arbitrary extra links (primarily
`vless://` exported from 3x-ui, but **any** string format) to a **specific
client's** subscription. When added, a bonus link appears in that client's
sub-link right next to the standard Naive/Mieru/Hy2 configs (4+ nodes in one
subscription); when removed, it disappears. Bonuses are **strictly per-client**
— they are tied to the user (their `sub_token`), never global, so different
clients have different sets (or none). There is **no liveness validation, no
3x-ui sync, no API pulling** — the list is fully manual and the string is stored
verbatim; the admin owns its correctness.

- **DB:** new nullable `bonus_links TEXT` column on `users` holding a JSON array
  of `{url, enabled}` objects. Migration is idempotent (`try { ALTER TABLE …
  ADD COLUMN } catch {}`) so `update.sh` never fails on already-migrated live
  installs. DB file perms/owner are untouched (stays `600 root:root`).
- **Subscription assembly (one point of change):** the `/sub/:token` base64 path
  now appends this user's **enabled** bonus URLs to the URI array — joined with
  the same `\n` separator — before base64-encoding the whole thing:
  `lines = [naiveLink, mieruLink, hy2Link, ...bonusLinksOfThisClient]`. Standard
  Naive/Mieru/Hy2 generation and the base64-list response format are **unchanged**.
- **Regression guarantee:** a client with no (enabled) bonuses gets a
  **byte-identical** subscription to before (covered by a dedicated test).
- **API:** `GET`/`PUT /api/users/:id/bonus-links` (admin-only) to read/replace a
  user's list; no content validation.
- **UI:** a "Бонусные ссылки / Bonus links" block in the client's config modal —
  input + add/delete + per-link enable toggle + save. i18n (ru/en).
- **Karing (sing-box JSON) path** is intentionally left unchanged: bonus links
  are raw URI strings and belong to the base64/URI-list clients (Shadowrocket,
  v2ray-style), as the feature spec's example specifies.

**Tests:** new `feat-bonus-links.test.js` (31 assertions) — the critical
empty-bonuses-identical regression, append-order, per-client isolation, arbitrary
format pass-through, `normalizeBonusLinks` edge cases, and source-level wiring
(idempotent migration, route append, endpoints).

---

## [v1.8.9]

> **FIX (CRITICAL) — WARP is stable again: no more "hangs 3-4 min then
> `blocked_return`" on the first enable.** Regression introduced in v1.8.0.

### Fixed
- **WARP enable was flaky after updating (BUG-173).** Enabling WARP would hang
  for 3-4 minutes and then report the hosting-provider-block warning
  (`blocked_return`, rx≈92 B, tx≫0), yet a **second** attempt minutes later
  succeeded.
  - **Root cause:** the v1.8.0 "Hy2 WARP UDP return-path" change added a UDP twin
    of the BUG-171 TCP rule, but **unscoped** on OUTPUT:
    `iptables -t mangle -A OUTPUT -p udp -j CONNMARK --restore-mark`. Unlike the
    TCP twin, this is fatal — **WireGuard's own encrypted envelope is UDP.**
    WireGuard fwmarks its envelope (`WG_FWMARK`) so the `not fwmark → WARP` rule
    keeps it on the native route to Cloudflare. During a **fresh** handshake,
    before POSTROUTING has saved that fwmark onto the endpoint conntrack, the
    unscoped OUTPUT restore copied mark 0 onto the envelope, **wiping** the
    fwmark → the envelope got mis-routed into the WARP table (loop) and the
    return path black-holed. Warm conntrack on a retry was consistent → "worked
    the second time".
  - **Fix:** scope **both** UDP return-path rules to the **Hysteria2 service
    port only** (`--dport`/`--sport HY2_PORT`, injected by the panel via
    `WARP_HY2_PORT`, default 443). WireGuard's envelope (dst 2408/500/1701/4500,
    src ephemeral) never matches, so its fwmark is untouched. Result: **WARP is
    stable with or without Hy2, and with or without cascade.**
  - **Also:** the healthcheck now waits for a real `wg` handshake **before**
    probing egress, so the primary endpoint port (2408) is tested on a warm
    tunnel instead of racing — eliminating the needless "cycle through 4 ports
    for 3-4 minutes → false failure" path.

### Compatibility
- Teardown purges **both** the new port-scoped rules **and** the old broad
  v1.8.0 shape, so an in-place upgrade leaves no orphan mangle rule that could
  keep black-holing the return path. No config/DB changes. WARP without Hy2,
  with Hy2, and without cascade were all verified against the rule model.

---

## [v1.8.8]

> **FIX — Hy2 now connects in Karing, and Naive now imports into Shadowrocket.**
> Follow-up to the v1.8.7 subscription link, after real-device testing of both
> clients against the same `/sub/:token` link.

### Fixed
- **Karing: Hy2 showed a red warning triangle (never connected).** The
  Hysteria2 server runs with `auth.type: userpass`, so the real wire password is
  the pair `<username>:<password>`. The official Hysteria2 client exposes a
  `userpass` alias, but **sing-box does not** — its `hysteria2` outbound has a
  single `password` field only. The universal / Karing sing-box config was
  sending the bare password, so authentication failed. `buildSingboxConfig()`
  now sets the `hy2-out` password to the combined `username:password`.
- **Shadowrocket: the Naive server was silently dropped from the
  subscription** (only Mieru + Hy2 appeared). Shadowrocket does **not** parse
  `naive+https://` from a subscription. Naive is, on the wire, an HTTP CONNECT
  proxy over TLS — i.e. Shadowrocket's built-in **HTTPS proxy** type (shown as
  `HTTPS / AUTO`). The base64 subscription (`buildUserUris()`) now emits
  Shadowrocket's native HTTPS-proxy URI —
  `https://<urlSafeBase64(username:password@host:port)>?remarks=<name>` — via the
  new `buildShadowrocketHttpsLink()` helper.

### Unchanged (still correct)
- Karing keeps consuming **Naive as a JSON outbound** via `buildSingboxConfig()`
  (which still uses `buildNaiveLink()`'s server key) — Karing's Naive/Mieru were
  already working.
- The standalone `hysteria2://user:pass@host:port` URI (Shadowrocket) was already
  correct: Shadowrocket/subconverter treat everything before `@` as the password,
  which yields the same combined `username:password`.

### Compatibility
- No config-schema or DB changes. Existing installs pick up the fix on the next
  subscription fetch — nothing to migrate, nothing breaks.

---

## [v1.8.7]

> **FEATURE — one "smart" subscription link (Sub-ссылка) + fix: Hy2 was missing
> from the universal config.**

### Fixed
- **Hy2 missing from the universal config.** The universal sing-box config only
  ever emitted `naive-out` + `mieru-out` (hard-coded) and ignored the user's
  protocol checkboxes. It now builds outbounds from `user.protocols`, adds a
  proper `hysteria2` outbound, and builds the `urltest` selector dynamically.

### Added
- **Public subscription endpoint `GET /sub/:token`.** One URL the admin hands a
  client; pasted into their app it auto-pulls every enabled protocol (2 or 3
  configs, per the checkboxes). Generated LIVE on every request, so toggling a
  checkbox / changing a password is reflected on the client's next refresh — no
  re-issuing, no manual JSON downloads.
  - **Smart client detection by `User-Agent`:** Shadowrocket → base64 URI list
    (naive + mieru + hy2); Karing / sing-box → sing-box JSON (Karing consumes
    Mieru only as a JSON outbound). Overridable with `?client=` / `?format=singbox`.
  - **`Subscription-Userinfo`** header (used traffic + quota + expiry) and
    **`Profile-Update-Interval: 24`** so clients show remaining traffic / key
    expiry and refresh daily.
  - Per-user random `sub_token` (128-bit hex), separate from the id; back-filled
    for existing users by an idempotent migration. Route is rate-limited.
- **Optional `subBaseUrl` setting** (Settings → Subscription Domain). Empty ⇒
  sub-links use the panel domain; set a dedicated `sub.<domain>` and Caddy
  auto-provisions its TLS cert and reverse-proxies `/sub/*` to the panel.
- **"Sub-ссылка" button** in the config modal (copies the URL + shows a QR).

### Compatibility
- Nothing changes for existing installs: `subBaseUrl` defaults to empty, the
  Caddy sub-domain block is emitted only when configured, and the `sub_token`
  column + config field are added by idempotent migrations. Existing Naive /
  Mieru / Hy2 add/delete and all config downloads are untouched.

---

## [v1.8.6]

> **FEATURE — Hy2 traffic accounting, auto-enroll, Hy2 logs, and a fix for the
> "Failed to fetch" toast when saving a user.**

### Fixed
- **"Failed to fetch" when ticking Hy2 / saving a user.** A CRUD call ran
  `applyAllConfigs()` (3 sequential service restarts, up to ~60s) *before*
  responding, so the fetch connection was dropped even though the DB write
  had succeeded (hence "reopen and it's there"). Configs now apply in the
  **background**; the request returns immediately with `servicesReloading:true`
  and the UI polls `/api/apply-status` for the outcome.

### Added
- **Per-user Hy2 traffic (Hy2 (МБ) column)**, like Naive/Mieru. Reads the
  Hysteria2 **Traffic Stats API** (`GET 127.0.0.1:9999/traffic`) — works for
  direct **and** cascaded Hy2. Isolated source: if unavailable it returns 0
  and never zeroes the Naive/Mieru figures.
  - `install_hysteria.sh` enables `trafficStats` (loopback + per-install secret).
  - `update.sh` `migrate_hy2_traffic_stats()` backfills it on existing installs
    (idempotent — skips configs that already have it).
- **Auto-enroll existing keys into Hy2** when installing Hy2 from the panel:
  every issued key gets `hy2` added to its protocols (idempotent), so the Hy2
  checkbox/column light up without re-editing each user. Opt-out with
  `{enrollAll:false}`; also exposed as `POST /api/settings/hy2/enroll-all`.
- **Hy2 logs** in the Logs page (`journalctl -u hysteria-server`), next to
  Naive/Mieru/Panel.
- **Cascade UI hint:** a note under "Включить каскад (relay)" explaining that
  Hysteria2 cascades automatically through the same Mieru tunnel (matched by
  process owner) — no separate Hy2 exit address is required.

### Tests
- `tests/feat-hy2-migration.test.js` section **[13]** (122 passed); full suite
  18 files green.

---

## [v1.8.5]

> **BUGFIX — Hy2 died with `permission denied` on the config after the v1.8.4
> root→hysteria migration, whenever the panel rewrote the config.**

### The problem
v1.8.4 moved hysteria-server to a non-root `hysteria` user. But the **panel
runs as root** and rewrites `/etc/hysteria/config.yaml` on every edit
(toggling the Hy2 checkbox, add/delete user, port/masquerade change) with:
```js
fs.writeFileSync(tmp, next, { mode: 0o600 });  // → root:root 0600
fs.renameSync(tmp, HY2_CONFIG);
```
So right after you enabled Hy2 in the panel, the config became `root:root 0600`
and the service user could no longer read it:
```
FATAL failed to read server config
{"error": "open /etc/hysteria/config.yaml: permission denied"}
```
(The cert was fine — this was the **config file itself**, not the cert.)

### Fixed
- **`index.js` — new `hy2ChownConfig()` helper, called after every config
  write and rollback** (`writeHysteriaConfig()` + the masquerade/port rewrite
  path). It resolves the `hysteria` uid/gid and restores
  `hysteria:hysteria` ownership with dir `750` / config `640`, so the service
  user can always read what the root panel just wrote.
  - **Legacy-safe:** if there is no `hysteria` user (an old box still running
    Hy2 as root), the helper **no-ops** — nothing changes for old installs.
- **`install_hysteria.sh`** — after writing the config as root, explicitly
  `chown -R hysteria:hysteria /etc/hysteria` + `chmod 750` dir + `chmod 640`
  config (the `cat >` heredoc had left it root-owned).
- **`update.sh`** — the `migrate_hy2_service_user()` migration now also sets
  the explicit `750`/`640` modes, seeding correct perms on in-place upgrades.

### Upgrade note
Boxes already broken by v1.8.4 self-heal on the next panel config write. To fix
immediately without waiting: `chown -R hysteria:hysteria /etc/hysteria &&
chmod 750 /etc/hysteria && chmod 640 /etc/hysteria/config.yaml &&
systemctl restart hysteria-server`.

---

## [v1.8.4]

> **FEATURE — Hysteria2 now relays through the cascade (relay) chain, like
> Naive & Mieru.** Turning on **"Включить каскад (relay)"** now cascades all
> three protocols. Plus a `better-sqlite3` fix for the Hy2 enroll one-liner.

### The problem
The cascade chain (`cascade_mieru.sh`) captures egress **by process owner-UID**
(`iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner <mita> -j REDSOCKS`),
not by interface or mark. Hysteria2 ran as **root**, so its traffic never
matched the owner-UID rule and silently **bypassed the cascade entirely** —
even with the relay checkbox on, Hy2 clients exited from the panel's own IP.
(WARP egress is unaffected: it marks by interface, so it already relayed all
three protocols.)

### Fixed
- **Hysteria2 now runs under a dedicated `hysteria` system user** instead of
  root, so the cascade can add a parallel owner-match rule for it.
  - `install_hysteria.sh` creates a `--system --no-create-home` `hysteria`
    user, adds it to group `caddy`, and runs the unit as
    `User=hysteria` / `Group=hysteria` with `SupplementaryGroups=caddy`.
  - `CAP_NET_BIND_SERVICE` is kept so the non-root user can still bind `:443`.
  - The shared Caddy cert is made **group-readable for `caddy`** (dir chain
    `chgrp caddy` + `chmod g+rx`, cert/key `g+r`) instead of world-readable.
- **Cascade now relays Hy2 egress.** `cascade_mieru.sh` adds a guarded
  `hy2_uid()` helper and, when Hy2 is installed, an
  `-m owner --uid-owner <hysteria> -j REDSOCKS` rule alongside the mita rule;
  `clear_iptables` removes it on teardown. The existing `exit_ip` RETURN
  anti-loop and TCP-only REDIRECT already cover the new UID; QUIC/UDP replies
  to clients are never captured (return-path safe).
- **`update.sh` migrates existing installs in place.**
  `migrate_hy2_service_user()` idempotently rewrites a `User=root` unit to
  `User=hysteria` (+ user creation, caddy group, cert group-read,
  `daemon-reload`) and is called from `migrate_hy2()` before the restart. Boxes
  already on `hysteria` are skipped — **nothing changes for them.**
- **Fixed `Cannot find module 'better-sqlite3'` in the Hy2 enroll flow.** The
  temporary enroll/rewrite node scripts are now written into `$PANEL_DIR`
  (not `/tmp`) so Node resolves `$PANEL_DIR/node_modules` (`require()` resolves
  relative to the script file's directory).

### Compatibility
- Existing Naive/Mieru cascade behaviour is unchanged (the original mita
  owner-match rule is untouched). The migration is idempotent and no-ops on
  boxes that don't have Hy2 or are already migrated — **existing installs
  keep working.**

---

## [v1.8.3]

> **BUGFIX — `HY2_ENROLL_ALL=1 ./update.sh` did nothing on a same-version box**
> (it hit the "Nothing to do" early-exit before the enroll step) + a dedicated
> one-liner mode for the enrollment.

### Fixed
- **Enroll now runs even when the installed version already equals the target.**
  A box already on the current version answered the "Re-sync / force update
  anyway?" gate and exited with "Nothing to do" *before* reaching
  `migrate_hy2_enroll_all`, so `HY2_ENROLL_ALL=1` silently had no effect. When
  `HY2_ENROLL_ALL=1` is set the updater now proceeds through the full flow
  regardless of version.

### Added
- **`update.sh --enroll-hy2`** — dedicated mode that runs ONLY the Hy2
  enrollment (add `"hy2"` to every user → rewrite `userpass` → restart Hy2),
  with **no full update**. Cleaner one-liner than the env var; errors clearly if
  Hy2 isn't installed; confirms on a TTY (or `-y` to skip). Documented in
  `--help`.

### Tests
- `feat-hy2-migration.test.js`: +8 assertions (same-version bypass + the
  `--enroll-hy2` flag/dispatch/help wiring), 79 total. Full suite green
  (18 files, 0 failed). Nothing breaks.

---

## [v1.8.2]

> **BUGFIX — Hy2 crash-loops with `auth.userpass: empty auth userpass`** when no
> user in the shared pool has Hy2 enabled + **FEATURE — opt-in auto-enroll** so
> already-issued clients work over Hy2 without re-provisioning.

### Fixed
- **Empty `userpass` no longer FATALs Hy2.** `buildHy2AuthBlock()` used to emit a
  bare `{}` when no user had `"hy2"` in their `protocols` — but Hysteria2 rejects
  an empty userpass map (`invalid config: auth.userpass: empty auth userpass`) and
  crash-loops. It now emits a single **disabled sentinel** entry
  (`__disabled_no_hy2_users__` + a long random password) so the map is genuinely
  non-empty and the service stays **up** while admitting zero real clients. The
  sentinel is silently replaced the moment a real Hy2 user is added.

### Added
- **Opt-in auto-enroll (`HY2_ENROLL_ALL=1`).** Existing clients issued before Hy2
  existed have `protocols = ["naive","mieru"]` and never appear in `userpass`.
  Running `HY2_ENROLL_ALL=1 ./update.sh` now:
  - adds `"hy2"` to **every** user's `protocols` array (idempotent — users who
    already have it are skipped; runs in a single SQLite transaction);
  - rewrites `/etc/hysteria/config.yaml`'s `userpass` from the enrolled pool
    (same username → stored plaintext password, so the client's existing
    credential works — no re-provisioning);
  - restarts `hysteria-server` → all clients active over Hy2 immediately.
  Fully opt-in: a plain `update.sh` never changes which protocols users have.
  Warns (does not crash) if requested while Hy2 isn't installed.

### Tests
- `feat-hy2-migration.test.js`: +16 assertions (anti-crash sentinel behaviour +
  auto-enroll wiring). `feat-hy2-link.test.js`: empty-pool assertion updated to
  the sentinel + `crypto` bound for the extracted helper. Full suite green
  (18 files, 0 failed). No change to add/delete user, Naive/Mieru — nothing breaks.

---

## [v1.8.1]

> **BUGFIX — Hy2 fails to start with `tls: must set either tls or acme`.**
> On servers where Caddy's data-dir is `/var/lib/caddy` (i.e. `XDG_DATA_HOME`
> points there directly), the Let's Encrypt certificate lives under
> `/var/lib/caddy/caddy/certificates/…` — **not** the
> `/var/lib/caddy/.local/share/caddy/certificates` path the installer searched
> exclusively. The cert was never found → a placeholder comment (with no `tls:`
> block) was written → `hysteria-server` crash-looped with
> `FATAL … invalid config: tls: must set either tls or acme`.

### Fixed
- **`install_hysteria.sh` cert discovery** now covers the real-world layouts:
  - Added `/var/lib/caddy/caddy/certificates` (the missing path — root cause),
    plus `/root/.local/share/caddy/certificates`,
    `/home/caddy/.local/share/caddy/certificates`, `/etc/caddy/certificates`.
  - New `find_caddy_cert()` helper: checks all known roots **and** does a broad
    `find` under `/var/lib/caddy`, `/root/.local`, `/home` as a final fallback —
    catches any non-standard Caddy data-dir. Verifies a matching `.key` exists.

### Added
- **Self-heal for a late-arriving certificate.** If Caddy hasn't issued the
  cert within 150 s at install time, the installer no longer leaves Hy2
  permanently dead. It drops `/usr/local/bin/hy2-cert-selfheal.sh` and a
  `hy2-cert-selfheal.timer` (retries ~every 60 s): as soon as the cert appears
  it splices the real `tls:` block in, restarts `hysteria-server`, switches to
  the permanent `caddy-cert-watcher.path`, and disables itself. The self-heal
  script short-circuits when a `tls:`/`acme:` block is already present (no
  thrash), so it's safe on already-working configs.

### Tests
- `feat-hy2-migration.test.js`: +13 assertions covering the new cert-search
  roots, the broad-find fallback, and the self-heal timer/script wiring
  (55 assertions total, all green). No behavioural change to add/delete user,
  Naive/Mieru configs, or the shared user pool — nothing breaks.

---

## [v1.8.0]

> **FEATURE — Hysteria2 UI + WARP compatibility + upgrade migration
> (continuation of v1.7.0).** Completes the Hy2 frontend, makes Hy2/QUIC work
> through Cloudflare WARP, and makes existing installs upgrade cleanly — the
> "Доустановить Hy2" button appears after a plain `update.sh` with **zero data
> loss** (existing users, protocols, Naive/Mieru configs are untouched).

### Added
- **Upgrade migration (Sub-stage C)** — `update.sh` / `install.sh`:
  - `migrate_config`: backfills `hy2Port` (443/udp) and `stack.{naive,mieru,hy2}`
    into `config.json` for pre-Hy2 installs. **`stack.hy2` defaults to `false` —
    the update NEVER auto-installs Hy2**; it only makes the install card
    available in Settings. Idempotent — custom `hy2Port` / operator-enabled
    `stack.hy2=true` are preserved via jq `//` fallbacks. Existing `users` and
    their `protocols` arrays are left completely untouched.
  - `migrate_hy2`: on update, restarts `hysteria-server` **only if Hy2 is
    installed** (config.yaml + binary present); otherwise prints a one-line
    "Доустановить Hy2" hint. `do_repair` likewise restarts Hy2 when installed
    (the panel re-syncs the `userpass` map from the SQLite pool → no user loss).
  - `update_panel`: `chmod +x` the shipped `install_hysteria.sh` /
    `warp_egress.sh` / `cascade_mieru.sh` helpers (both `$PANEL_DIR/scripts` and
    the legacy `$PANEL_DIR/panel/scripts` layouts) so the panel can run them.
  - `do_status`: adds a `hysteria (Hy2)` version line, a hysteria-server
    active/inactive (or "not installed") indicator, and `hy2Port`/`stack` in the
    config dump.
  - `install.sh`: fresh installs write the same Hy2 config defaults
    (`hy2Port: 443`, `stack.hy2: false`) — Hy2 added later from the panel.
- **Full Hy2 frontend (Sub-stage B-UI):**
  - Dashboard: Hy2 service card (auto-shown when installed) with status badge
    and start/stop/restart service buttons.
  - User modal: Hy2 protocol checkbox with install-gating (disabled + hint when
    Hy2 not installed); edit keeps hy2 enabled for users that already have it.
  - Users table: new **Hy2** column (✓/—) after Mieru; colspan bumped 11→12
    across header + loading/error/empty render paths.
  - Config modal: Hy2 link download button (`hysteria2://…` + QR + copy),
    shown only when Hy2 installed AND the user has the `hy2` protocol.
  - Settings: Hy2 card with not-installed (install + port) and installed
    (reinstall + change-port) states.
  - i18n: 23 Hy2 keys added to ru/en; fixed pre-existing `toast.cascadeUpdated`
    gap in en.json (full locale parity restored).
- **WARP UDP return-path rule (Sub-stage D)** in `scripts/warp_egress.sh`:
  mirrors the BUG-171 TCP fix for UDP so Hysteria2/QUIC replies (udp/443 or
  configured `hy2Port`) stay on the NATIVE route instead of being swallowed
  into Cloudflare. Marks NEW inbound UDP from non-WARP ifaces + restores on
  OUTPUT; teardown mirrors the deletes. Hy2's own outbound dials still egress
  via WARP.

### Tests
- **`tests/feat-hy2-migration.test.js`** (40 assertions): validates the
  update.sh/install.sh Hy2 migration (config backfill, idempotency, users
  preserved), the Hy2 restart-only-when-installed logic, do_status wiring, the
  server runtime backfill + `/api/settings/hy2`, and the Sub-stage D WARP UDP
  reply-path rules (incl. that the BUG-171 TCP rule is untouched). Wired into
  `npm test`. Full suite: **18 files, all green, 0 failed.**

---

## [v1.7.0]

> **FEATURE — Hysteria2 (Hy2) integration.** The panel now manages a THIRD
> protocol, Hysteria2 (QUIC/UDP), alongside Naive and Mieru — **one shared user
> pool**: a user has Hy2 access iff its `protocols` array contains `"hy2"`.

### Added
- **`scripts/install_hysteria.sh`** — multi-arch Hy2 installer. Configurable
  UDP port (`HY_PORT`, default **443/udp**, coexists with Naive on TCP/443
  because our Caddy runs `protocols h1 h2` → HTTP/3 off → UDP/443 free).
  `USE_CADDY_CERT=1` reuses Caddy's existing certificate (**no second email,
  no second ACME**) and installs a `caddy-cert-watcher` to restart Hy2 on cert
  renewal. Standalone ACME path retained as a fallback.
- **Backend Hy2 config owner** — `writeHysteriaConfig()` rewrites ONLY the
  `auth.userpass` block of `/etc/hysteria/config.yaml` from the shared SQLite
  pool (atomic write → structural validate → `.last` backup → restart → verify
  → rollback on failure). No new dependency (targeted string splice, not YAML
  parse). `applyAllConfigs()` calls it after every user add/edit/delete/backup-
  restore — **non-fatal, no-op when Hy2 isn't installed**.
- **API** — `GET /api/users/:id/config/hy2` (`hysteria2://` share link),
  `GET /api/settings/hy2` (installed/active/port/user-count),
  `POST /api/settings/hy2/install`, `POST /api/settings/hy2-port` (atomic
  `listen:` rewrite + restart + rollback + UFW). `hy2` added to
  `VALID_PROTOCOLS`. `/api/status`, `/api/diagnostics`, WS metrics and the
  service-control map all report/allow `hy2`/`hysteria-server`.
- **Config** — `cfg.hy2Port` (default 443) and `cfg.stack {naive,mieru,hy2}`
  with runtime backfill so legacy configs upgrade seamlessly.
- **Tests** — `tests/feat-hy2-link.test.js` (33 assertions: link builder, auth
  block, config splice/preservation, structural validation).

## [v1.6.0]

> **FEATURE — Backup & Restore (one-file disaster recovery).** New card in
> **Server Settings → Backup & Restore**. Requested for server migration: if a
> server dies, the admin restores everything on a fresh box in a couple of
> clicks and every existing client key keeps working (if the new server uses the
> same domain — just repoint DNS).
>
> **Export** (`GET /api/backup/export`, auth-gated): downloads a single JSON
> containing **all users** (including plaintext passwords **and** bcrypt hashes —
> both are needed to reissue the *identical* `naive+https://` / `mierus://` keys)
> and the **full panel config** (domains, ports, protocols, cascade/WARP, admin
> credentials). Filename `rixxx-backup-<domain>-<date>.json`.
>
> **Restore** (`POST /api/backup/import`, auth-gated): validates the file
> (format tag, schema, required sections, per-user records) *before* touching
> anything, then upserts users and writes the config, and finally rebuilds the
> Caddyfile + mita config and restarts the services — the **same code path** as
> every normal add/delete, so nothing bespoke can drift.
>   - **Domain mode** is chosen at import time:
>     - *keep backup domain* → same-DNS move, existing client keys keep working;
>     - *keep this server's domain* → new DNS, clients download fresh keys.
>   - Local runtime paths (`dbPath`, `caddyBin`, …) are always taken from the
>     live server, never the backup (a backup from another box may differ).
>   - The live version tag is never downgraded by a backup.
>
> **UI:** "Download backup" + "Restore from backup" buttons, a plaintext-password
> warning banner, and an inline status line. i18n EN + RU. The JSON body limit
> was lifted to 25 MB so large user lists import cleanly.
>
> **Test:** `tests/feat-backup.test.js` (31 assertions) — structural checks
> (endpoints, auth, validation, non-destructive rebuild path) plus a standalone
> simulation of the export shape and the domain-mode merge.
>
> **Non-breaking:** purely additive. Existing add/delete/config flows and all
> issued keys are untouched. Anyone who updates can immediately take a backup and
> move to a new server.

---

## [v1.5.9]

> **FEATURE — Mieru share-link export (`mierus://`) for routers (Keenetic / OpenWRT).**
> Requested by a user: export a user's Mieru config not only as a sing-box JSON
> file, but also as a single copy-paste **share link**, so it can be imported
> directly on routers (Keenetic NDMS / OpenWRT) and by tools like
> [awg-manager](https://github.com/hoaxisr/awg-manager).
>
> **Link format (canonical, round-trippable):**
> ```
> mierus://<user>:<pass>@<host>?profile=default&port=<p>&protocol=TCP
> ```
> - scheme `mierus` (the plain-text share form);
> - `profile` always present (`default`);
> - **each** `port` paired with its own `protocol` (canonical shape accepted by
>   real router parsers — see awg-manager issue #516);
> - host is the raw server IP; userinfo + query values are percent-encoded so
>   unusual passwords stay valid.
>
> **Added — non-breaking (purely additive):**
> - New endpoint `GET /api/users/:id/config/mieru-link` (auth-gated), returning
>   `{ link, username }` exactly like the existing Naive-link endpoint. Supports
>   `?port=<n>` (single, default) and `?range=1` (every port in the configured
>   Mieru range, each paired with its protocol).
> - New **"Mieru Link"** button in the config modal, next to "Mieru JSON". It
>   reuses the shared link box + QR code and copies the link to the clipboard
>   (same UX as "Naive Link").
> - i18n: `config.mieruLink` / `config.mieruLinkCopied` in EN + RU.
> - Test `tests/feat-mieru-link.test.js` (29 assertions) locking down the
>   canonical format, per-port protocol pairing, percent-encoding, and that the
>   existing Mieru JSON download is untouched.
>
> **Nothing existing changed** — the Mieru JSON download, Naive link, and
> Universal config paths are all byte-for-byte the same. Safe for existing users;
> `update.sh` needs no migration for this feature.

---

## [v1.5.8]

> **BUG-172 (CRITICAL) — Mieru cascade silently dies after 2-5 days; watchdog
> blind to it.** With the cascade (Variant B: `redsocks` + `iptables` +
> `mieru-client`) enabled, everything works — then after 2-5 days of uptime
> client devices suddenly time out, while `mita` **and** `redsocks` still report
> `active (running)` and the web panel stays reachable. Only a manual
> `systemctl restart redsocks` (or a full reinstall) fixes it.
>
> **Field diagnosis (thanks to the reporter's excellent write-up):**
> - `curl -x socks5h://127.0.0.1:1080 https://api.ipify.org` → **OK** (mieru tunnel alive)
> - `sudo -u mita curl https://api.ipify.org` → **hangs at TLS handshake, times out**
> - `strace -p $(pidof redsocks)` while a request is pending → **zero syscalls**
> - No FD leak (~22 open), no CLOSE-WAIT zombies, iptables `RETURN` rule correct.
>
> **Root cause:** redsocks' `libevent` event-loop **dead-locks** under long
> uptime / connection micro-storms. The process is alive and `:12345` is still
> bound, but it stops servicing socket events — so the cascade data-plane
> (`iptables → redsocks → mieru`) is dead even though every unit is "healthy".
>
> **Why the old watchdog missed it:** `write_watchdog()` probed
> `curl --socks5 127.0.0.1:1080`, which talks to **mieru-client directly** and
> bypasses **both** iptables **and** redsocks. mieru was fine, so the probe
> passed, the watchdog concluded "internet is up", and never restarted anything
> — while real client traffic (which *does* traverse iptables → redsocks)
> black-holed.

### Fixed
- **BUG-172 (CRITICAL): cascade watchdog now probes the WHOLE chain.**
  `write_watchdog()` generates a watchdog that issues its health probe **as the
  `mita` user** (`sudo -u mita curl … https://api.ipify.org`), so the
  `iptables … OUTPUT -m owner --uid-owner <mita> -j REDSOCKS` rule forces it
  through the full `iptables → redsocks → mieru` path — exactly like a real
  client. A redsocks event-loop deadlock is therefore actually detected.
- **Self-heal targets the ACTUAL culprit** (after 3 consecutive end-to-end
  failures, to avoid flapping on a transient blip):
  - chain fails **but** the raw SOCKS5 (`:1080`) probe still works → redsocks is
    the wedged component → **restart `redsocks`** (the common deadlock case).
  - chain **and** SOCKS5 both fail → the mieru tunnel itself is down → **restart
    `mieru`, then `redsocks`** (so redsocks re-dials the fresh SOCKS5 listener).
  Healing actions are logged to `/var/log/cascade-watchdog.log`.

### Added
- **Preventive nightly redsocks recycle.** The cron now also runs
  `0 4 * * * root systemctl restart redsocks` — redsocks is historically prone
  to slow FD/memory leaks and event-loop wedges over 24/7 uptime, so a nightly
  restart keeps the loop fresh (the mieru session survives; brief <1 s blip).

### Changed
- **Safe in-place upgrade for existing cascades.** `update.sh` gains
  `migrate_cascade_watchdog`, which re-deploys the corrected watchdog + cron on
  boxes that already run the cascade — **without** touching the live
  tunnel/iptables (it sources only the orchestrator's function definitions, with
  the `case "$ACTION"` dispatcher stripped, and calls `write_watchdog` in a
  guarded subshell). It runs **only** when Variant B is actually deployed here
  (the `cascade-mieru.state` file or the existing watchdog binary is present)
  **and** `cascadeEnabled=true`, so a Variant-A-only or cascade-off host is never
  given a chain-probing watchdog. Idempotent and safe under `-y`.

### Tests
- `tests/bug172-cascade-watchdog.test.js` (18 assertions): the generated
  watchdog is valid bash, probes the full chain **as `mita`** (not the bare
  SOCKS5 shortcut that caused the blind spot), heals the correct component in
  each state, restarts mieru **before** redsocks, logs its actions, and installs
  both the 5-minute chain probe and the nightly recycle. Includes a **live**
  run that shims `sudo`/`curl`/`systemctl` to simulate the three real states
  (healthy → nothing restarted; redsocks deadlock → redsocks only; mieru down →
  mieru + redsocks).

---

## [v1.5.7]

> **BUG-171 (CRITICAL) — WARP: client keys never establish (stuck in SYN-RECV).**
> On a clean host (server 192187) with WARP egress fully healthy
> (`curl --interface warp` → `104.28.197.7`, 21 MB/s, 0 % loss), a client
> connects with a Naive or Mieru key but **no site loads**. `ss -tunap` shows
> every inbound client session frozen in **`SYN-RECV`**, never reaching `ESTAB`:
> `tcp SYN-RECV [::ffff:138.124.66.84]:443 [client]` (caddy-naive) and `:2012`
> (mita/mieru).
>
> **Root cause:** the policy-routing default rule `9500 not from all fwmark
> 0xca6c lookup 51820` pushes **all** outgoing server traffic into WARP —
> including the **SYN-ACK replies** our locally-terminated listening sockets
> (caddy-naive :443, mita :2012/:443) send back to clients. The existing `ip
> rule` exceptions (`9003 to <subnet>/24`, `9004 to <gw>`) only cover the local
> subnet/gateway, **not** reply packets headed to arbitrary external client IPs.
> So the SYN-ACK was routed into Cloudflare instead of back to the client and the
> TCP handshake never completed.
>
> v1.5.7 keeps the reply traffic of every locally-terminated inbound connection
> on the **native** route, while still tunnelling the proxies' own outbound
> (egress) dials through WARP — so the client connects, sites load, and the
> client's public IP still shows the Cloudflare egress (104.x).

### Fixed
- **BUG-171 (CRITICAL): SYN-ACK replies to clients were swallowed by WARP →
  handshake stuck in SYN-RECV.** `route_up()` now marks connections by their
  **origin** rather than by port (the old SSH/panel `--dport` exceptions could
  never cover arbitrary client IPs):
  - `iptables -t mangle -A PREROUTING ! -i warp -p tcp -m conntrack --ctstate NEW
    -j CONNMARK --set-mark 0x5152` — every **NEW inbound** TCP connection that
    enters from a non-WARP interface (a client/SSH/panel hitting one of our
    listening sockets) is tagged onto its conntrack entry.
  - `iptables -t mangle -A OUTPUT -p tcp -j CONNMARK --restore-mark` —
    **unconditionally** restores that mark onto the reply (SYN-ACK …). The
    existing `ip rule … fwmark 0x5152 lookup main` (prio 9000) then routes those
    replies **natively** back to the client instead of into WARP.
  - Connections the proxies **originate outbound** (the actual egress) start at
    `OUTPUT` with no inbound conntrack, get no mark, and fall through to the WARP
    table — so the client's checked IP still shows the Cloudflare egress (104.x).
- **The restore is UNCONDITIONAL — and that is the whole fix.** The first attempt
  matched `-m connmark --mark 0x5152` on the `OUTPUT` rule, but that matches the
  *packet* mark, which on a freshly-generated local SYN-ACK is still `0` (the
  restore is precisely what copies the conntrack mark onto the packet). So the
  rule never fired, the SYN-ACK stayed unmarked, and rule 9500 swallowed it into
  Cloudflare → SYN-RECV persisted. `CONNMARK --restore-mark` is a no-op when the
  conntrack carries no mark, so restoring on every local TCP packet only ever
  marks the replies of inbound connections. This is the canonical
  wg-quick / sshuttle / serverfault return-path recipe.

### Changed
- `route_down()` removes the new PREROUTING inbound-mark + the unconditional
  OUTPUT restore, and **also purges** the legacy v1 conditional `OUTPUT … -m
  connmark --mark 0x5152` shape and the older per-port `--dport` INPUT marks, so
  upgrading from any prior build leaves **no orphan mangle rules** (BUG-150
  idempotency preserved). SSH/panel and WARP-return-path guarantees from
  BUG-162/BUG-169 are unchanged; MSS clamping from BUG-170 is unchanged.

### Tests
- `tests/bug171-warp-inbound-reply.test.js` (20 assertions): asserts the
  mark-by-connection-origin shape, the **unconditional** OUTPUT restore (and that
  the never-firing `-m connmark --mark` match is gone), the `fwmark → main` rule,
  that proxy egress is still tunneled, idempotent install, and a live
  mock-kernel `route_up ×2 → route_down` run (8 rules installed without
  duplicates, 0 left after teardown).
- `tests/bug169-warp-fwmark.test.js` updated to the unconditional OUTPUT-restore
  shape (31 assertions, still green).

---

## [v1.5.6]

> **BUG-170 (HIGH) — WARP: "connect OK, nothing loads."** With `v1.5.5` the WARP
> tunnel is fully healthy on server 192187 (egress = Cloudflare, DNS OK, return
> traffic flows), but clients connect and heavy sites/video stall. Proven with
> `ping -M do` through the warp interface:
> `-s 1400` → *message too long, mtu=1280*, **100 % loss**; `-s 1200`/`-s 1000`
> → **0 % loss**. Packets larger than the 1280 MTU are dropped (DF set,
> fragmentation forbidden). A real client is **double-encapsulated**
> (client → Naive/Mieru → WARP), so the effective MTU is even lower; with PMTUD
> unreliable across the proxy / ICMP-filtered path, the sender never shrinks its
> segments → large TCP flows hang. **MTU 1280 alone is not enough — TCP MSS must
> be clamped.**

### Fixed
- **BUG-170 (HIGH): no TCP MSS clamping → large flows stall through WARP.**
  `route_up()` now clamps the TCP MSS on every connection that egresses via the
  warp interface, on **both** paths:
  - `iptables -t mangle -A FORWARD -o warp -p tcp --tcp-flags SYN,RST SYN -j TCPMSS …`
    — forwarded client egress.
  - `iptables -t mangle -A OUTPUT  -o warp -p tcp --tcp-flags SYN,RST SYN -j TCPMSS …`
    — **required** because `caddy-naive` / `mita` egress is generated by LOCAL
    processes (OUTPUT path), not only forwarded.
  We pin a deterministic hard ceiling **`--set-mss 1240`** (`1280 − 20` IPv4 `− 20`
  TCP — sized for the doubly-encapsulated path, survives broken PMTUD) **and**
  add **`--clamp-mss-to-pmtu`** as a belt-and-suspenders lower bound. Rules match
  SYN/SYN-ACK only (where MSS is negotiated) and are installed idempotently
  (`-C` before `-A`). Tunable via `WARP_MSS` (default `1240`).

### Changed
- `route_down()` removes the MSS clamping symmetrically from **both** FORWARD and
  OUTPUT (looped delete, so a partial prior run leaves no orphan rules — BUG-150
  idempotency). Verified live: install ×2 → 1 rule per chain; teardown → 0 left.
- `do_status` now also reports `mss : <WARP_MSS>` next to `mtu`.

### Preserved (unchanged guarantees)
- BUG-169 return-path routing (wg fwmark + conntrack save/restore +
  `src_valid_mark` + `not fwmark` + `suppress_prefixlength`).
- BUG-162: SSH/panel never tunneled. `Table = off`, `MTU = 1280`, IPv4-only.
- Healthcheck + auto-rollback + outcome classification.

### Acceptance criteria (from the report)
> До фикса: `ping -M do -s 1400 -I warp 1.1.1.1` падает (mtu=1280). После фикса:
> клиент по ключу (Naive и Mieru) при включённом WARP открывает тяжёлые
> сайты/видео без зависаний; проверка IP с клиента = CF-egress (104.x); скорость
> приемлемая.

✅ MSS is now clamped to 1240 on every WARP egress (forwarded **and** local), so
oversized segments are never emitted; the verified-CF egress from v1.5.5 stays
intact.

### Tests
- New `tests/bug170-warp-mss.test.js` (18 assertions incl. a **live** root-only
  install-×2 / teardown idempotency check; the live block validates the chain
  iteration + `-o <dev>` match + `-C`/`-A`/`-D` logic, since the sandbox kernel
  may lack `xt_TCPMSS`).
- Full suite: **222 passed, 0 failed** non-root / **228 passed** as root (the
  live route/MSS blocks add 6 root-only assertions; was 207 non-root; +15).

---

## [v1.5.5]

> **BUG-169 (CRITICAL) — the panel's own policy routing was breaking WARP's
> return path, not the provider.** Proven on a *clean* hoster (server 192187):
> a **bare** `wgcf` tunnel (`Table = off`, no policy routing) reached a
> Cloudflare egress IP (`curl --interface wgtest` → `104.28.197.7`), but the
> **panel** setup on the *same server, same endpoint, fresh account* returned
> `WARP_RESULT=blocked_return` with `rx=92 tx=4.8 GB` (handshake only). The only
> difference was the fwmark + `ip rule table 51820` the panel layered over
> `Table = off`. That layer was **missing the canonical wg-quick `add_default()`
> return-path mechanism**, so the encrypted reply UDP from Cloudflare never made
> it back to the WireGuard socket. This also means the `blocked_return` verdict
> was **false on clean hosters** — the scary "provider blocks WARP" banner could
> fire even when the provider was fine.

### Fixed
- **BUG-169 (CRITICAL): WARP return traffic dropped by the panel's fwmark/policy
  routing → false `blocked_return`.** `route_up()` now mirrors wg-quick's
  `add_default()` exactly:
  1. `wg set <iface> fwmark 51820` — WireGuard fwmarks its **own** encrypted
     envelope UDP (the missing key piece).
  2. `ip rule add not fwmark 51820 lookup 51820` — everything **except** the
     envelope is sent into the tunnel table (the envelope exits native, no loop).
  3. **conntrack save/restore of the envelope mark** — the return-path fix:
     `POSTROUTING -m mark --mark 51820 -p udp -j CONNMARK --save-mark` stamps the
     mark onto the outgoing envelope's conntrack entry, and
     `PREROUTING -p udp -j CONNMARK --restore-mark` restores it on the **incoming
     reply UDP** so the kernel delivers it back to the wg socket instead of
     dropping it (the `rx≈92 B` symptom).
  4. `sysctl net.ipv4.conf.all.src_valid_mark=1` — marked / locally-generated
     packets pass reverse-path filtering, so decrypted return packets survive.
  5. `ip rule add table main suppress_prefixlength 0` — specific routes in
     `main` (incl. the on-link route to the WARP endpoint) win, so the envelope
     leaves via the native NIC.
  - **Acceptance:** on a server where the bare `wgcf` tunnel yields a CF egress
    IP, the **panel** WARP now yields the same CF egress (`WARP_RESULT=ok`), not
    `blocked_return`.
- **BUG-169 regression (SIGPIPE/pipefail — same class as BUG-166):** the
  `route_down()` rule-cleanup loop used `while ip rule show | grep -q "^<prio>:"`
  as its condition. Under `set -o pipefail`, `grep -q` closes the pipe on the
  first match → `ip rule show` gets SIGPIPE (141) → pipefail makes the pipeline
  non-zero → the `while` wrongly evaluates **false** → the rule is **never
  deleted** (observed live to strand `ip rule` prio 9000). Fixed by snapshotting
  the table into a variable and matching in pure bash (no pipe). The same
  pattern in `has_ipv6()` (`ip -6 addr show | grep -q inet6 && return 0`) was
  fixed too — it could produce a false "no IPv6" verdict and wrongly strip
  `::/0` on a dual-stack host (touches BUG-167).

### Changed
- `route_down()` now tears down **every** new artifact idempotently (BUG-150
  guarantee): clears the WireGuard fwmark (`wg set <iface> fwmark 0`), removes
  the new mangle rules (POSTROUTING save-mark, PREROUTING restore-mark, OUTPUT
  connmark restore), and deletes the `suppress_prefixlength` (9400) and
  `not fwmark` default (9500) rules — plus the management exceptions (9000-9010)
  and the WARP route table. Verified live: `route_up` installs the policy rules,
  `route_down` removes **all** of them (0 left).
- The previous explicit `to <endpoint>/32 → main` exception is no longer needed
  — `suppress_prefixlength 0` covers the on-link endpoint route generically.

### Preserved (unchanged guarantees)
- **BUG-162:** SSH and the panel are still pinned to the native route via
  connmark + high-priority `ip rule … lookup main`; they are **never** tunneled.
- `Table = off`, `MTU = 1280`, IPv4-only Address/`AllowedIPs` (BUG-164/167).
- Healthcheck + auto-rollback + outcome classification (BUG-164/168).

### Tests
- New `tests/bug169-warp-fwmark.test.js` (31 assertions): asserts the
  `wg set fwmark`, `not fwmark`, conntrack save/restore, `src_valid_mark`, and
  `suppress_prefixlength` pieces in `route_up()`; the full idempotent teardown in
  `route_down()`; the SIGPIPE-free loop conditions; and — when run as root — a
  **live** `route_up → route_down` cycle proving the rule table ends up empty.
- Full suite: **207 passed, 0 failed** without root (the live route_up/route_down
  block skips when not root); **210 passed** as root (was 179; +28/+31).

---

## [v1.5.4]

> **WARP confirmed working — the v1.5.3 code is correct.** Verified on another
> hoster with a manual `wgcf` tunnel: `curl --interface … api.ipify.org` →
> `104.28.197.7` (a Cloudflare IP), return traffic flows, egress switched to CF.
> The original "WARP kills the server / one-way" report was a **provider-side
> block of inbound WireGuard/UDP** on the old host (`92 B received` on every
> port) — outside the panel's control. This release fixes a real registration
> bug found during that verification, hardens IPv6 stripping, and makes the
> provider-block case explain itself to the operator.

### Fixed
- **BUG-166 (HIGH): false "wgcf register failed" even though the account was
  created.** On a fresh server `wgcf register` printed *"Successfully created
  Cloudflare Warp account"* (Device active: true) but the panel still aborted with
  `[warp][ERROR] wgcf register failed`. **Root cause:** the script runs under
  `set -o pipefail`, and `yes | wgcf register` makes `yes` receive **SIGPIPE
  (exit 141)** the instant `wgcf` closes its stdin — *even on a fully successful
  registration*. `pipefail` then propagated 141 as the pipeline's status, so the
  `|| die` fired. Fix (`warp_egress.sh`):
  - **Dropped the `yes |` pipe entirely** — `--accept-tos` already answers the
    only prompt, so no pipe (and no SIGPIPE) is needed.
  - New `wgcf_register()` judges success by the **account file** Cloudflare wrote,
    **not** the exit code; uses an explicit `--config "$WGCF_ACCOUNT"` (and a
    CWD-relative fallback move) so the file is always written/read at the same
    path regardless of working directory.
  - `account_is_valid()` now reads the real `wgcf-account.toml` fields
    (`device_id` + `private_key` + `access_token`, single- **or** double-quoted)
    and rejects empty values. `wgcf generate` likewise uses `--profile` + a
    file-based success check.

- **BUG-167: guarantee IPv6 is fully stripped on IPv4-only hosts.** wgcf emits
  `Address = <v4>/32, <v6>/128` (comma-separated) and `AllowedIPs = 0.0.0.0/0,
  ::/0`. The generated `warp.conf` now provably contains **only** the IPv4
  `Address` line and **no** `::/0` (rebuilt from scratch, IPv4 fields only), so
  `wg-quick up` can never fail with *"IPv6 is disabled on this device"*. Locked in
  by tests against the exact wgcf comma-separated format.

- **BUG-168 (UX): friendly, non-error message when the HOSTER blocks WARP.** The
  auto-rollback (v1.5.3) already keeps the box safe; this release classifies the
  outcome so the operator understands *why* and *what to do* — instead of a scary
  technical error that triggers false support tickets. `warp_egress.sh` emits a
  structured `WARP_RESULT=…` line; the panel maps it to a colour + message:
  - **`ok`** → green: *"WARP включён — egress теперь через Cloudflare (IP …)"*.
  - **`blocked_return`** (handshake OK but `rx ≈ 92 B` on every port) → **yellow**
    (not red): *"Ваш хостинг-провайдер блокирует входящий трафик Cloudflare WARP
    (WireGuard/UDP). Это ограничение сервера, не панели. Всё откачено, доступ
    сохранён… смените хостера или используйте каскад. (Туннель отправил X,
    получил Y байт.)"*
  - **`no_handshake`** (no handshake on any port) → yellow: *"WARP не смог
    подключиться к Cloudflare ни на одном порту… вероятно, провайдер режет UDP.
    Всё откачено, доступ сохранён."*
  - On a rolled-back WARP the panel un-checks the toggle and reports
    `warpEnabled=false`, so the UI state stays honest.

---

## [v1.5.3]

### Fixed
- **BUG-164 (HIGH): WARP tunnel was ONE-WAY — egress black-holed.** After v1.5.2
  the WARP tunnel handshaked correctly but `wg show` reported `received ≈ 92 B`
  against `sent ≈ 425 MiB`: Cloudflare's return traffic never arrived. Everything
  routed into the WARP table (table 51820) went into a black hole — `curl ipify`
  on the server hung, key clients got no response, and from outside it looked like
  the panel had crashed. The BUG-162 control-plane exceptions were correct and are
  untouched; the breakage was purely the one-way data path. Fixes
  (`warp_egress.sh`):
  - **`MTU = 1280`** in the generated `warp.conf` (cause #1). With the default
    1420/1500 the encapsulated reply packets exceed the path MTU and are silently
    dropped — the classic "sent MiB / received ~0 B" symptom.
  - **Robust wgcf registration.** A key that is *generated* but never actually
    *registered* with Cloudflare gives the same picture. `account_is_valid()` now
    checks the account file really contains a `device_id` + `private_key`; an
    empty/corrupt account is re-registered, and setup hard-fails if registration
    does not produce a valid account.
  - **Endpoint-port fallback.** Some hosters block inbound UDP/2408. If the tunnel
    is unhealthy we retry across `2408 / 500 / 1701 / 4500`.
  - **Post-up healthcheck with AUTO-ROLLBACK.** After bring-up we probe the egress
    IP **through the warp interface** (`curl --interface warp … api.ipify.org`,
    timeout 5s). If no Cloudflare IP comes back on any endpoint port, we
    automatically `warp_down` (full teardown) and surface a clear error — the box
    is **never left in a black hole**, so the panel and SSH stay reachable on the
    native route even when WARP can't be brought up on a given host.
  - **Autostart enabled only after a healthy tunnel** (and only when
    `WARP_PERSIST=1`): a bad tunnel is never persisted into the boot path.
  - `do_status` now reports `rxBytes/txBytes/mtu`, and a `healthcheck` CLI action
    was added, so a one-way tunnel is immediately observable.
  - `update.sh` `migrate_warp_safety` now also tears down v1.5.2 confs **missing
    `MTU = 1280`**, so the panel regenerates the fixed conf on the next enable.

  **Acceptance:** after "Применить WARP", `wg show` shows non-zero `received`;
  `curl --interface warp` returns a Cloudflare IP in < 5s; a key client checking
  its IP sees the Cloudflare IP, not the server IP. Panel + SSH stay reachable
  throughout; if the tunnel can't be brought up healthy, it auto-rolls-back and
  access is preserved.

- **BUG-165 (cosmetic): removed the misleading "Naive (сервер, суммарно)" banner.**
  Since v1.5.2 Naive traffic is shown per key in the Users table, so the
  server-wide banner above the table was both incorrect and confusing. The banner
  (`renderNaiveServerBanner`) is removed; `removeNaiveServerBanner()` also strips
  any stale banner left in the DOM by a previously-cached build.

---

## [v1.5.2]

### Fixed
- **BUG-162 (CRITICAL): WARP locked the server out + re-downed it on every reboot.**
  In v1.5.1 enabling WARP routed EVERYTHING (`AllowedIPs 0.0.0.0/0`, wg-quick
  `Table=auto`) into the tunnel — including the SSH and panel management channels
  — so the operator lost all access (only the hoster console recovered the box).
  The unit was also `systemctl enable`d, so a reboot brought the server down
  again automatically. Fix (`warp_egress.sh`):
  - **`Table = off`** — wg-quick no longer installs ANY routes. We install our own
    **scoped policy routing**: a dedicated route table (51820) carries the WARP
    default, while **high-priority `ip rule` exceptions keep the control plane on
    the native route**: SSH port, panel port, local subnet, default gateway, the
    WARP endpoint itself, and replies to inbound/ESTABLISHED connections
    (conntrack mark). Only locally-originated egress (proxy upstream traffic) goes
    via WARP. **If the tunnel dies, SSH/panel access survives.**
  - **Autostart is now opt-in** (`WARP_PERSIST=1`, set only on explicit operator
    confirmation). By default WARP does NOT come back after a reboot — a bad
    tunnel can never silently re-down the box.
  - **`update.sh` recovery migration** (`migrate_warp_safety`): disables the old
    auto-enabled `wg-quick@warp` unit and tears down any stale unsafe tunnel
    (missing `Table=off`) so boxes already hit by v1.5.1 regain native access on
    update. Teardown leaves NO artifacts (ip rules, route table, conntrack marks,
    legacy `0xca6c` fwmark all cleaned — BUG-150 pattern).
  - UI: explicit "add to autostart" checkbox (default off) + a note that SSH/panel
    stay reachable.
- **BUG-163 (honest per-key accounting).** Confirmed: `IPAccounting` gives the
  **server-wide** caddy-naive total, NOT per-user — per-key Naive is impossible
  (forward_proxy hijacks CONNECT, access.log is empty for live tunnels). v1.5.1
  spread that total evenly across users, which **invented** per-user numbers.
  Now: **Mieru is per-key** (from mita), **Naive is shown as an accurate
  server-wide total** in a banner above the Users table, clearly labelled. Also
  fixed the Users table showing 0/0: it never fetched `/api/stats/users` — it now
  merges the Mieru per-key figures from there into the rows.

---

## [v1.5.1]

### Fixed
- **BUG-160 (HIGH, regression): traffic accounting zeroed BOTH Naive AND Mieru.**
  After v1.5.0 every user showed `Naive (МБ) = 0` and `Mieru (МБ) = 0`. Root
  cause: the `/api/stats/users` aggregator was unguarded — if **either** source
  (the `mita get users` exec, the Caddy log read, or a malformed `protocols`
  blob) threw, the whole handler 500'd and the UI fell back to 0.0 for *both*
  protocols. Fix: each source is now isolated in its own `try/catch`, so one
  failing source can never zero the other; failures are logged, not silent.
- **BUG-160: NaiveProxy traffic is now measured from the kernel.** Investigation
  proved Caddy `forward_proxy` **hijacks** the CONNECT connection: successful
  tunnels are never written to the access log and the logged handshake reports
  `bytes_read = size = 0`. Per-user CONNECT byte accounting via the access log
  is therefore impossible. We now enable `IPAccounting=yes` on
  `caddy-naive.service` and read `IPIngressBytes/IPEgressBytes` for an accurate
  server-wide Naive total (survives log rotation — no logs involved), attributed
  across Naive-capable users. (`update.sh` migrates existing units idempotently.)
- **BUG-161 (HIGH): WARP would not start on IPv4-only servers.** The wgcf profile
  always carries an IPv6 `Address` + `AllowedIPs = ::/0`; on hosts with IPv6
  disabled, `wg-quick` ran `ip -6 address add …` → "IPv6 is disabled on this
  device" → rolled the whole interface back → tunnel never came up. Fix:
  `warp_egress.sh` now detects usable IPv6 (`host_has_ipv6`) and, when absent,
  strips every IPv6 `Address` line and the `::/0` from `AllowedIPs`, bringing the
  tunnel up IPv4-only. The IPv6 step can no longer hard-fail the bring-up, and a
  post-start interface check tears down any half-built state cleanly (BUG-150
  pattern — no leftover routes/rules/interfaces after a failed enable).

---

## [v1.5.0] — 2026-06-22 (Naive traffic accounting fix + Cloudflare WARP egress mode)

- **TASK 1 (MEDIUM) — NaiveProxy traffic always 0.0:** root cause was the Caddy
  `log` directive living in the GLOBAL options block, which only configures
  Caddy's runtime logger and never writes HTTP access logs — so `access.log` had
  no per-request `user_id` / byte counters for `parseCaddyTraffic()` to sum.
  - Moved the access `log` directive INSIDE the `:port, domain` site block in all
    generators: `caddyTemplate.js` (primary) + the inline fallbacks in
    `install.sh` and `update.sh`. The global logger now writes only runtime errors
    to stderr/journald so it never pollutes `access.log`.
  - `parseCaddyTraffic()` now survives log rotation: it sums the current
    `access.log` PLUS all rolled siblings (`access-<ts>.log`), so a Caddy roll no
    longer resets Naive usage to 0. (.gz rolls are skipped to avoid blocking.)
  - **UI:** the single "Used (MB)" column is split into two — **Naive (MB)** and
    **Mieru (MB)** — backed by the existing `naiveMB` / `mieruMB` fields.
  - Tests: `bug-naive-caddylog.test.js` (9) verifies the access log is in the site
    block; `bug-naive-traffic.test.js` (17) verifies per-user attribution and
    rotation survival.
- **TASK 2 (FEATURE) — Cloudflare WARP egress mode:** optional server-wide egress
  through Cloudflare WARP so the server's real IP is never exposed.
  - New `scripts/warp_egress.sh` (wgcf + wg-quick) with idempotent
    `setup` / `teardown` / `status` / `egress-ip`; reboot-persistent via
    `wg-quick@warp` systemd unit; full teardown removes the interface, routes,
    fwmark rules and conf (BUG-150 clean-teardown lesson).
  - New API: `GET/POST /api/settings/warp`, `GET /api/settings/warp/status`,
    `POST /api/settings/warp/reset`. The POST reports the measured egress IP so
    the operator can confirm it switched to Cloudflare.
  - **Mutual exclusion:** exactly one egress mode is active (native IP / cascade /
    WARP). Enabling WARP force-tears-down the cascade and vice-versa — enforced
    server-side AND in the UI (the WARP toggle is locked while the cascade is on).
  - **Low-RAM advisory:** on VPS with ≤1 GB RAM the UI warns that the extra
    WireGuard layer adds memory pressure.

## [v1.4.9] — Hotfix 2026-06-12 (BUG-156: trafficPattern.seed boolean → int32, mita IDLE / Mieru port closed)

- **BUG-156 (HIGH):** enabling Mieru obfuscation (traffic pattern) in the UI made
  the panel serialize `trafficPattern.seed` as a **boolean** (`seed: true`)
  instead of an **int32** in `mita-state.json`. `mita apply config` then failed
  with `proto: (line 57:13): invalid value for int32 type: true` →
  `ValidateFullServerConfig() failed: server config is empty`, so mita stayed
  **IDLE**, `mita describe` was empty `{}` and the Mieru port (e.g. 2012) stayed
  closed — even though UFW allowed 2012–2022 and NaiveProxy kept working. The
  bad block looked like:
  `"trafficPattern": { "seed": true, "tcpFragment": false, "nonce": false }`.
  Root cause: the on/off **toggle** value (a boolean) was written into `seed`,
  and `tcpFragment` / `nonce` were emitted as bare booleans instead of objects.
- **Fix (panel `buildMitaStateFile` + `update.sh` `rebuild_mita_state_direct`):**
  generate the `trafficPattern` block against the authoritative mieru proto
  schema —
  `seed` is a **numeric int32** (a stable random 31-bit seed, persisted as
  `cfg.trafficPatternSeed` so regeneration is deterministic),
  `unlockAll` is the real boolean toggle, and `tcpFragment` / `nonce` are proper
  objects (`tcpFragment { enable, maxSleepMs }`,
  `nonce { type, applyToAllUDPPacket, minLen, maxLen }`). The UI toggle is never
  written into `seed` again.
- **Validation before apply:** added `validateMitaState()` — a structural
  JSON-vs-proto-type check that rejects a non-integer `seed`, non-boolean
  `unlockAll`, malformed `tcpFragment` / `nonce`, or port bindings missing an int
  `port` / `portRange`. A broken config is now refused **before** it reaches
  mita instead of leaving the server silently IDLE.
- **Apply → start → verify RUNNING:** `applyMitaConfig()` now captures
  `mita apply config` stderr, and after start/reload it verifies
  `mita status == RUNNING` (with mieru users present), recording the failure
  reason in `lastMitaError` (surfaced to the UI via the traffic-pattern API
  response) instead of leaving mita IDLE with no feedback.
- **Self-healing:** `cfg.trafficPattern` is only ever a string preset, so
  regenerating `mita-state.json` (toggle obfuscation, create/delete a key) on an
  already-broken server now writes a correct numeric seed automatically — no
  config migration needed.
- Added `tests/bug156-trafficpattern.test.js` (21 assertions): verifies each
  preset emits an int32 seed (never a boolean), NOOP/unknown return null, seed
  reuse is stable, the old `seed: true` shape is rejected by the validator,
  CUSTOM coerces a boolean seed, and the full state survives a JSON round-trip.

## [v1.4.8] — Hotfix 2026-06-11 (BUG-155: apt output captured into panelBasicAuthHash → caddy-naive failed-loop)

- **BUG-155 (HIGH):** enabling external panel access on a server where
  `apache2-utils` was **not yet installed** captured the entire
  `apt-get install` stdout (`Selecting previously unselected package…`,
  `Unpacking…`, the `needrestart` banner, …) into `panelBasicAuthHash`, with the
  real bcrypt token only on the last line. That multi-line value was written to
  `config.json` and regenerated into the Caddyfile as
  `basic_auth { admin <many lines> }`, so `caddy validate` failed
  (`wrong argument count … after 'previously'`) and `caddy-naive` dropped into a
  `Start request repeated too quickly` failed-loop — taking NaiveProxy down. It
  only reproduced on hosts where the package was freshly installed during
  hashing, and was not fixed by `--ssh-only` or `--repair`.

  Fixes (defence in depth):
  - **Hashers never capture apt noise.** `install.sh` / `update.sh`
    `panel_hash_password()` now pre-install `apache2-utils` via a new
    `ensure_htpasswd()` with **stdout fully redirected to /dev/null**, and sieve
    every hasher's output through `extract_bcrypt` so only a single valid bcrypt
    token can be returned. The admin-password fallback is hardened the same way.
  - **Caddyfile generator refuses polluted hashes.** `caddyTemplate.js`
    (the single source of truth for install/update/panel) and the panel's
    `buildCaddyfile()` now run `panelBasicAuthHash` through `extractBcrypt()`;
    a value that isn't a single valid bcrypt token yields **no** `basic_auth`
    line rather than a broken block.
  - **Validate before (re)start.** `applyCaddyConfig()` and the manual
    `/api/service/caddy-naive/{start,restart,reload}` route now run
    `caddy validate` first and refuse to restart on an invalid config, leaving
    the running service up (no more failed-loop).
  - **Panel API validation.** `/api/panel/external-access` sieves the carried
    hash and rejects enabling when no valid bcrypt is present (clear error:
    set a new password).
  - **Self-heal on update.** `migrate_config()` now calls a new
    `sanitize_basic_auth_hash()` that extracts the embedded bcrypt (or blanks
    the field) on **every** update, and `--ssh-only` cleans it too — so a server
    already broken by this bug recovers with a plain
    `update.sh … | sudo bash -s -- -y`, no manual `jq`/`nano`.
  - **`--repair` is reliable as a one-liner.** It no longer "Aborts" when run
    via `curl … | bash -s -- --repair`: with `-y` it never prompts, otherwise it
    prompts on `/dev/tty` when available and proceeds when there is no terminal
    (an explicit `--repair` is consent).

Tests: new `tests/bug155-basicauth.test.js` (12 assertions) verifies the
generator sieves the exact field dump down to one clean `basic_auth` line.

Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

---

## [v1.4.7] — Hotfix 2026-06-10 (BUG-154: cascade foolproof gate falsely blocked buttons)

- **BUG-154 (MEDIUM, cosmetic):** the v1.4.6 foolproof gate falsely disabled the
  "Применить каскад" / "Сбросить каскад" buttons on the Settings page until the
  Keys page had been visited at least once. Root cause: `applyFoolproofGates()`
  read the key count from the cached `state.users`, which is initialised to `[]`
  and only filled by `loadUsers()` — so a direct entry into Settings saw length 0
  and blocked the buttons even though keys existed in the DB.
  - The gate now reads the **live** key count from the backend (`/api/status`
    `panel.userCount`) instead of the cache, and **fails open** (assumes keys
    exist) on any request error, so a flaky probe never blocks a configured
    server.
  - **"Сбросить каскад" is no longer gated at all** — it is a safe cleanup that
    must always be available (a stuck cascade + a glitchy gate must never leave
    the operator unable to reset it). It is also actively re-enabled on every
    gate pass in case a stale `disabled`/`is-disabled` lingered.

Frontend-only change; no server behaviour altered.

Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

---

## [v1.4.6] — Release-fix 2026-06-10 (mieru users in mita-state, full cascade teardown, foolproofing)

Field-tested 1.2.x→1.4.5 batch. Six items:

- **BUG-151 (CRITICAL):** mita-state.json was rebuilt without a `users` section,
  so `mita` saw N endpoints, found no user → `FATAL: no user found` → failed-loop.
  Root cause: `update.sh rebuild_mita_state_direct` used a `'[]'` protocols-filter
  fallback (dropping NULL-protocol users) and suppressed Node errors with
  `2>/dev/null`, diverging from `index.js buildMitaStateFile` (which uses
  `'["naive","mieru"]'`). Fixed the filter to match index.js, removed error
  suppression, and added `reset-failed → apply → restart → is-active` verification.
  `index.js applyMitaConfig()` now keeps mita **idle** (not FATAL) on an empty
  base via `countMieruUsers()`.
- **BUG-150 (CRITICAL):** Cascade teardown was incomplete. `cascade_mieru.sh
  do_teardown` rewritten to be fully idempotent: flush/delete/destroy iptables
  REDSOCKS chain + OUTPUT jump (by line-number), stop+disable+reset-failed
  redsocks and delete `redsocks.conf`, remove watchdog/cron + fails file, stop
  mieru-client + remove unit, daemon-reload, shred client config, mark state
  disabled, verify native egress. `clear_iptables` hardened to remove ANY
  OUTPUT→REDSOCKS jump.
- **Доработка 1:** new explicit **"Сбросить каскад"** button →
  `POST /api/settings/cascade/reset` performs the full BUG-150 teardown as one
  atomic op (config.json, Caddyfile/upstream, mita rebuilt WITH native users,
  iptables/redsocks/watchdog), restarts services and reports native egress.
  Idempotent.
- **Доработка 2 (foolproofing):** cascade-apply, cascade-reset and mita
  restart/start buttons are greyed-out with a "Сначала создайте хотя бы один
  ключ" tooltip while `users.count == 0` (`applyFoolproofGates()`), and the
  delegated click handler now respects the `disabled` flag. mita no longer
  loops on an empty base.
- **BUG-153 (MEDIUM):** deleting a key now re-fetches the list + dashboard and
  re-applies the foolproof gates without a re-login (delete already regenerates
  Caddyfile/mita via `applyAllConfigs`).
- **BUG-152 (LOW):** doubled egress IP in cascade status fixed — the probe
  result is built once and trimmed.

Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

---

## [v1.4.5] — Audit 2026-06-09 (user-create double-submit: definitive fix — false "Email already in use")

Follow-up to v1.4.4. The v1.4.4 fix coalesced concurrent requests via an
in-flight map, but two rapid HTTP POSTs (double-click / Enter+click) do **not**
overlap at the JS level — Node drains microtasks between socket events, so
request #1 fully completes (INSERT + in-flight cleanup) before request #2's
handler even starts. The in-flight map therefore never caught them, and the
**email pre-check ran first**, so the replay saw the row #1 just inserted and
returned a false `Email already in use` (the user IS created — visible after F5).

Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

### Fixed

- **BUG-149 (race — false "Email already in use" / "Username already exists" while the user IS created).**
  - **Idempotent double-submit at the response level.** When the username already
    exists, the route now compares the submitted password against the stored
    `passHash`: a **match** means this is the same submit replayed (a double-click)
    → return the existing user as **200 success** (`idempotent:true`), not an
    error. A **mismatch** means a genuine clash with a different, pre-existing
    user → real `409 Username already exists`. A double-submit always carries the
    identical password the user just typed, so this reliably distinguishes the two
    without masking real collisions.
  - **In-flight coalesce check now runs BEFORE any duplicate gate** (username AND
    email), so a truly-concurrent twin still coalesces onto the same promise.
  - **Email is optional (business note only):** users can be created with no email
    at all (`NULL`, exempt from `UNIQUE`); a non-empty email is rejected **only**
    when it belongs to a *different* existing user — never against the row this
    same submit just created.
  - **Frontend (unchanged from v1.4.4, still in force):** `saveUser()` re-entrancy
    guard + disabled Save button during the request; `await loadUsers()`
    auto-refreshes the list so the new user appears with **no manual F5** and no
    error toast on success.
  - **Verified LIVE** against the real server (`tests/live-race-bug149.sh`):
    A) email double-submit → 201 + 200(idempotent), 1 row, no false error;
    B) no-email double-submit → 201 + 200, 1 row;
    C) genuine duplicate email (other user) → 409;
    D) genuine duplicate username, different password → 409.

- **BUG-143 (UI version desync).** Carried forward from v1.4.4: `readPanelVersion()`
  reads the live version (`/etc/rixxx-panel/version` → bundled `VERSION` →
  config.json → fallback) and is served by `/api/status` and `/api/config`, so
  every release the version in the UI (sidebar/topbar/about) updates automatically
  after `update.sh` with no manual edits or re-login.

---

## [v1.4.4] — Audit 2026-06-09 (user-create double-submit race + UI version desync)

Follow-up to v1.4.3. Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

### Fixed

- **BUG-149 (race — false "Username already exists" while the user IS created).**
  Creating a user could show `Username already exists` in the modal even though
  the user was actually created (visible only after F5, key worked). Root cause:
  the old flow did a `getUserByUsername()` pre-check then a separate INSERT, each
  request minting a fresh UUID. On a double-submit the first request created the
  user (201) while the second slipped past the pre-check, hit `UNIQUE(username)`
  and returned a false 409.
  - **Atomic + idempotent create:** `createUserAtomic()` now does a single
    `INSERT ... ON CONFLICT(username) DO NOTHING`. A genuine insert → success; if
    nothing was inserted but the existing row has the *same* passHash (i.e. this
    is the same create re-submitted) → return the existing user as **success**;
    only a clash with a *different* pre-existing user returns a real 409.
  - **In-flight de-dup:** concurrent `POST /api/users` for the same username are
    coalesced onto one promise, so a rapid double-submit never starts two INSERTs
    and both callers get the identical success response.
  - **Frontend:** `saveUser()` has a re-entrancy guard (ignores a second call
    while one is in flight) on top of the existing disabled-button/spinner, and
    now `await`s `loadUsers()` so the new user appears **without a manual F5**.
  - **Service rebuild** (Caddy/mita) runs only when a row was actually inserted,
    so an idempotent re-submit is cheap.
  - Still no raw stacktrace: unknown DB errors map to a generic message; only a
    real duplicate yields the friendly 409.
  - **Acceptance:** one click → user created, list refreshes itself, no false
    error; repeated click / double-submit neither errors nor duplicates the user.
- **BUG-143 (recurring — UI version lagged a release behind).** After updating to
  1.4.3 the header still showed v1.4.2 because the UI read the version from a
  source that could lag (in-memory `cfg` / `config.json` not reloaded).
  - **Single source of truth, read LIVE:** `readPanelVersion()` reads the version
    on every request with precedence `/etc/rixxx-panel/version` → bundled
    `VERSION` → `config.json` → fallback. Both `/api/status` (`panel.version`)
    **and** `/api/config` (`version`) now return this live value, so all three UI
    spots (sidebar / topbar / about) update the moment `update.sh` runs.
  - `install.sh`/`update.sh` already write `/etc/rixxx-panel/version`
    (`panel_version=X.Y.Z`) and sync `config.json` from the repo `VERSION`; the
    panel now consumes that file directly — no manual edits each release.
  - **Acceptance:** after `update.sh`, the header version (all places) equals the
    `VERSION` in main with no re-login / manual action.

### Tests

- `tests/race-bug149.test.js` — atomic/idempotent create: first create succeeds,
  identical re-submit is idempotent success (no 409, no dup row), a different user
  on the same name is a real duplicate, simulated double-submit → one row / one
  success. 10/10.
- `tests/version-bug143.test.js` — `readPanelVersion()` precedence + live re-read
  picking up a new version after a simulated `update.sh`. 7/7.
- `npm test` runs all three suites (migration + race + version).

### Notes

- No DB schema changes. Existing users/keys/cascades preserved. VERSION 1.4.3 → 1.4.4.

---

## [v1.4.3] — Audit 2026-06-09 (CRITICAL: cannot create any user after upgrade from v1.2)

Critical bugfix. On servers upgraded from **v1.2**, creating *any* new user failed
with a raw `SqliteError: UNIQUE constraint failed: users.email` dumped straight
into the "add user" modal — existing keys/cascade worked, but no new user could be
added at all. Update with one command:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

### Fixed

- **BUG-149 (CRITICAL — cannot create any user after upgrade from v1.2).**
  v1.2 stored email-less users with an **empty string** `''` under a `UNIQUE`
  column. SQLite treats `''` as a real, distinct value, so the *second* empty
  email already collides — and every new-user INSERT then failed on
  `users.email`. The existing email→nullable migration only ran when the column
  was still `NOT NULL`; on v1.2 the column was already nullable (`notnull=0`), so
  the migration was **skipped** and the `''` rows survived.
  - **Migration:** added an *unconditional* startup step
    `UPDATE users SET email = NULL WHERE email = ''` (NULL is exempt from
    SQLite's UNIQUE, so any number of users may have no email). Logs how many
    rows were normalised. Runs on every boot, so `--update`/restart fixes
    existing installs automatically.
  - **`upsertUser`:** now coerces any empty/whitespace email to `NULL` before
    writing, so `''` can never be re-introduced (also guards the traffic-snapshot
    upsert path).
  - **Create/Update user routes:** pre-check for a duplicate non-empty email and
    return a clean **409 "Email already in use"** (and 409 for duplicate
    username) *before* hitting the constraint; the `upsertUser` call is wrapped
    in try/catch that maps known constraint errors to friendly 4xx.
  - **Global Express error handler:** last-resort safety net so a raw
    `SqliteError`/HTML stacktrace exposing internal paths
    (`/opt/panel-naive-mieru/server/index.js:NNN`) can never reach the UI —
    unexpected errors return clean JSON instead.
  - **Test:** added `tests/migration-bug149.test.js` (and `npm test`) — builds a
    realistic v1.2 DB with `''` emails, applies the migration, and asserts legacy
    users survive, empty emails become NULL, new users (with/without email) are
    created, multiple email-less users coexist, and duplicate emails return a
    clean 409 with no leaked path. 13/13 assertions pass.

### Notes

- No DB schema changes beyond normalising data (`'' → NULL`). Existing users,
  keys and cascades are preserved. VERSION 1.4.2 → 1.4.3.

---

## [v1.4.2] — Audit 2026-06-09 (CRITICAL: dead NaiveProxy keys after Bug 98 + no-IPv6 black hole)

Critical bugfix release. After Bug 98 (fake-site switched from `file_server` to
`reverse_proxy`) **every NaiveProxy key stopped egressing** while the panel still
looked "green". Update with one command — no manual edits:

```
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

### Fixed

- **BUG-102 (CRITICAL — all naive keys dead): wrong global `order`.** The Caddyfile
  global block still emitted `order forward_proxy before file_server`, but Bug 98 made
  the masquerade block a `reverse_proxy` (mirror mode). `before file_server` did **not**
  place `forward_proxy` ahead of `reverse_proxy`, so the fake-site `reverse_proxy`
  intercepted even authenticated `CONNECT` requests and forwarded them to `fakeSiteUrl`
  → client got `400 Bad Request` from the nginx fake-site → no traffic egressed. TLS and
  `basic_auth` still passed, so the panel showed everything healthy while keys were dead.
  - Fixed to the canonical **`order forward_proxy first`** (per caddy-forwardproxy-naive),
    which places `forward_proxy` ahead of **both** `file_server` (local mode) and
    `reverse_proxy` (mirror mode) — robust against future masquerade-mode changes.
  - Applied to **all four Caddyfile generators** so a regenerate (key create/delete,
    `--repair`, `--update`, panel restart) can never re-break it:
    `panel/server/caddyTemplate.js` (canonical), `panel/server/index.js` `buildCaddyfile()`
    inline fallback, `install.sh` inline fallback, `update.sh rebuild_caddyfile_direct`
    inline fallback. Verified: render emits `order forward_proxy first` in both local and
    mirror modes; no `before file_server` directive remains anywhere.
  - Existing installs are fixed automatically on update because `do_update` calls
    `rebuild_caddyfile_direct`, which renders from the fixed on-disk `caddyTemplate.js`.
- **BUG-103 (CRITICAL — no egress on IPv6-less VPS): NetworkUnreachable black hole.**
  On servers with no working outbound IPv6 route (`ip -6 route` shows only `fe80`),
  mieru/mita routed AAAA-site traffic over IPv6 into a black hole, piling up hundreds of
  `NetworkUnreachableError`s and breaking google/youtube.
  - `install.sh` and `update.sh` now detect a missing working IPv6 route
    (`has_working_ipv6`) and force IPv4 preference (`ensure_ipv4_preference`):
    `precedence ::ffff:0:0/96 100` in `/etc/gai.conf` (getaddrinfo) **and**
    `net.ipv6.conf.all.disable_ipv6=1` in `/etc/sysctl.d/99-rixxx-disable-ipv6.conf`
    (survives reboot). Applied in `install.sh main()`, `do_update`, and `do_repair`.
  - Smoke tests now include real egress checks: `curl -4` always, `curl -6` only when a
    working IPv6 route is present; auto-fixes (enables IPv4 preference) if IPv6 is
    unreachable. `mita` is restarted so it re-resolves over IPv4 and drains the backlog.
- **BUG-104 (medium): stale version after `--repair`.** `--repair` restarted the panel
  without bumping `config.json`'s `version`, so PM2/UI kept showing an old version
  (e.g. 1.2.6 while 1.4.x was installed). Extracted the config.json version-sync logic
  into a shared `sync_config_version()` helper now called by **both** `do_update` and
  `do_repair`, syncing before the panel restart so the live process reports the real
  version.

### Notes

- **BUG (case syntax at update.sh:1578)** reported from the field was in the *old
  deployed* `update.sh`. The current repo `update.sh` passes `bash -n`; because the
  one-command update is a curl-pipe, it runs the freshly-fetched fixed script directly,
  so the old case error never executes.
- No DB schema changes. Working keys and cascades are preserved.

---

## [v1.4.1] — Audit 2026-06-09 (External access fixes: webBasePath base-path proxy, stub editor, version sync)

Bugfix release for the v1.4.0 external-access feature, addressing field-test findings.

### Fixed

- **BUG-140 (blocker): webBasePath was not propagated to assets/API.** With external
  access enabled, the panel rendered the login page but `locales/*.json`, `/api/me`,
  `/api/login`, etc. returned 404 — login was impossible. Root cause: Caddy
  `handle_path /<webBasePath>/*` strips the prefix, but the SPA built absolute paths
  from the root (`/api/...`, `/locales/...`) and never re-added the prefix.
  - Frontend now derives `BASE_PATH` from the running `app.js` script URL and prepends
    it to every `fetch`/`api` call, the locale loader, and the WebSocket URL (`/ws`).
  - Caddy now emits `redir /<webBasePath> /<webBasePath>/ 301` so the bare prefix
    normalizes to a trailing slash and relative assets (`style.css`, `app.js`) resolve.
  - Works identically with and without a prefix (SSH-tunnel mode unaffected).
- **BUG-141 (high): custom panel-stub HTML could not be set.** Added a stub editor to
  the External Access settings card with `GET`/`POST /api/panel/stub` (atomic write to
  `panelStubPage`, no Caddy restart needed). A stray leading `Copy` clipboard artifact
  is stripped automatically.
- **BUG-143 (medium): UI showed stale 1.3.x version.** Hardcoded `v1.3.3` fallbacks in
  `index.html`/server defaults are bumped; with BUG-140 fixed, `/api/status` now reaches
  the panel so `cfg.version` (synced from VERSION on update) displays correctly.
- **BUG-144 (low): basic-auth password label/validation mismatch.** The label/placeholder
  and validation now depend on `panelBasicAuthSet`: password is **required on first
  enable**, and **optional (blank = keep)** when a hash already exists.

### Notes

- No DB schema changes. Existing keys/cascades untouched.

---

## [v1.4.0] — Audit 2026-06-09 (External panel access — domain + TLS + basic auth + webBasePath; removes bare port 8080)

Major feature: secure **external access to the admin panel** via a dedicated
TLS subdomain, plus a new **webBasePath** secret path segment. The bare HTTP
port 8080 is **removed entirely** — the panel is never exposed directly.

### Architecture

```
https://panel.<domain>/<webBasePath>/   → Caddy (TLS + basic_auth)
                                          → handle_path strips prefix
                                          → reverse_proxy 127.0.0.1:3000
panel.<domain>/  and any path outside webBasePath
                                          → static stub (file_server, local HTML)
```

* The panel **always** listens on `127.0.0.1:3000` (loopback). External reach is
  served **only** by Caddy via reverse_proxy — there is no bare panel port.
* `handle_path /<webBasePath>/*` strips the prefix, so the panel never needs to
  know about it (most robust approach; a webBasePath change requires no app change).
* `basic_auth` is a layer **over** the panel login, not a replacement.
* The panel-stub (`/var/www/panel-stub/index.html`, the dark animated
  “CONNECTION” page) is shown at the subdomain root and any non-webBasePath path —
  **not** a redirect to login. It is a separate entity from the naive `fakeSiteUrl`.

### Server (install.sh / update.sh)

* `install.sh`: `--expose panel.<domain>` (+ `--panel-ba-user/--panel-ba-pass/--web-base-path`);
  interactive prompt for external access (default = SSH-only); `setup_panel_stub`;
  `caddy hash-password` for basic-auth; final credentials banner shows the panel URL,
  webBasePath, basic-auth login (+ password only when auto-generated).
* `update.sh --expose <panel-domain>` / `--ssh-only` rewritten for the subdomain
  architecture (idempotent; atomic rebuild + restart + is-active check, Bug 91 style).
* Interactive update on SSH-only asks **once** “Перевести панель в открытый доступ
  по домену? [y/N]” (default N keeps local); `-y` keeps the current mode silently;
  an already-exposed install regenerates the block from template without asking.
* **8080 migration**: on update, any legacy `0.0.0.0:8080` binding / UFW rule is
  detected, closed, and the panel is forced back to the safe loopback default —
  without losing access.
* UFW keeps only 80 (ACME + redirect), 443 (TLS), and the proxy ports; 8080 is
  removed and a removal step is added.

### config.json (backward-compatible)

New fields: `panelDomain`, `panelBasicAuthUser`, `panelBasicAuthHash`,
`webBasePath`, `panelStubPage`. `migrate_config()` adds safe defaults to old
installs (SSH-only, loopback) and never silently exposes them.

### Panel (backend + UI)

* New endpoints: `POST /api/panel/external-access` (validate → persist →
  regenerate Caddyfile → restart caddy-naive → verify is-active → **roll back**
  config + Caddyfile on failure so the panel never stays broken) and
  `GET /api/panel/webbasepath/generate` (random 16-hex).
* `/api/config` masks the basic-auth bcrypt hash (exposes a boolean `panelBasicAuthSet`).
* Session cookie `Path` is explicitly `/` so a webBasePath change does not force re-login.
* New Settings card: enable/disable toggle, subdomain, webBasePath + “Generate new”,
  basic-auth login/password; on save it shows the new full URL and warns when the
  old path stops working (it now serves the stub) — no hard logout.

### Caddyfile generators (all 4 in sync)

`caddyTemplate.js` gains `renderPanelBlock()` (single source of truth); the inline
fallbacks in `index.js`, `install.sh`, and `update.sh rebuild_caddyfile_direct`
mirror it. All emit the panel block only when external access is enabled.

---

## [v1.3.3] — Audit 2026-06-09 (REAL UTF-8 fix — install crash on config.json, Bug 101; reopens #34)

**Reopens #34 — the previous "locale" fix (Bug 34) was the wrong diagnosis.**

### Bug 101 — install crashed writing config.json: `SyntaxError: Non-UTF-8 code starting with '\xd1' … no encoding declared`

On a clean Ubuntu 22.04 / 24.04 (Yandex Cloud) the installer failed at
**“Запись /etc/rixxx-panel/config.json”** with:

```
SyntaxError: Non-UTF-8 code starting with '\xd1' in file ... on line N,
but no encoding declared; see https://peps.python.org/pep-0263/
```

Decisive clue: **the error line number changed with the interface language**
(RU → line 6, EN → line 14). That proves localized/user-supplied **Cyrillic
strings were interpolated into the python source** of the heredoc that wrote
config.json — and Python (PEP 263) refuses non-ASCII source bytes without a
`# coding: utf-8` declaration. So it was **never a locale problem**:
`LANG=C.UTF-8` / `PYTHONUTF8` (Bug 34) couldn’t fix it because the offending
bytes were in the generated *code*, not the environment. The literal
`"exposePanel": …("Y","Д")` comparison (a Cyrillic **Д** baked into the python
source) was the EN “line 14”; a Cyrillic domain/email hit the RU “line 6”.

**Fix — eliminate python from the install path; generate all JSON with Node:**
- `write_config_json()` now writes config.json with **`node`** (UTF-8-native,
  no source-encoding rules), and **every value is passed as an environment
  variable (data), never interpolated into the script source**. Cyrillic
  domains/emails, quotes, backslashes, etc. now produce valid JSON.
- `write_mita_state()` likewise rewritten with Node + env-passed ports.
- The Caddyfile render (`node -e`) and the inline `auth_lines` fallback now pass
  the user list / domain / email / fake-site URL via **env vars**, not
  interpolated source.
- **All** remaining `python3 -c` calls in the installer (mita user count,
  smoke-test JSON parsing/asserts, password URL-encoding, banner serverIp read)
  were converted to **Node** — the installer no longer invokes python at all.
- Locale exports kept as belt-and-braces; comment corrected to explain the real
  root cause.

**Verification:** config.json generation tested with a Cyrillic domain
(`кириллица.рф`), Cyrillic email, a Cyrillic fake-site URL with an embedded
`'` quote, and a bcrypt hash containing `\` — all yield valid, parseable JSON.
**No DB schema change**, keys and cascades untouched.

### Server update (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

> Note: this bug only affected **fresh installs** (`install.sh`); existing
> servers that already have a valid config.json are unaffected by the crash, but
> should still update to get the hardened installer for any future reinstall.

---

## [v1.3.2] — Audit 2026-06-08 (post-deploy hotfix #2: version display fully fixed in the UI)

After v1.3.1 the password crash was gone, but the panel **still** showed the old
version in the header — the sidebar label (left) and the topbar badge (right)
kept reading `v1.2.6`.

**Root cause:** the version is rendered in **three** places in `index.html`
(sidebar label, topbar badge, settings → about), but only `#about-version` was
ever updated from the API. The sidebar label and topbar badge were plain
hardcoded `v1.2.6` text, so the backend `config.json` sync from v1.3.1 never
reached them.

**Fixes (frontend):**
- Gave the sidebar label and topbar badge stable ids (`#sidebar-version`,
  `#topbar-version`) and bumped their hardcoded defaults to the current version.
- Added `syncVersionDisplay()` called from `enterApp()` right after login: it
  fetches `/api/status` once and writes the real version to **all three** spots,
  so the version is correct even if the user never opens the Dashboard tab.
- `loadConfig()`, `loadDashboard()` and the settings loader now also update all
  three (kept in sync).

Combined with the v1.3.1 backend fix (`do_update()` syncs `config.json`'s
`version`), the displayed version is now correct everywhere after an update.

**No DB schema change**, existing keys and cascades keep working.
Server update command is at the bottom of this entry.

### Server update (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

---

## [v1.3.1] — Audit 2026-06-08 (post-deploy hotfix: random password crash + stale version display)

Two regressions surfaced after the first server update to v1.3.0. Both are
fixed here. **No DB schema change**, existing keys and cascades keep working.
Server update command is at the bottom of this entry.

### Bug 100 — "🎲 Случайный пароль" crashed: `crypto.randomInt is not a function`

Clicking **Random password** in the Add-User form threw on the server:

```
TypeError: crypto.randomInt is not a function
    at generateSafePassword (/opt/panel-naive-mieru/server/index.js:979:36)
```

**Root cause:** `crypto.randomInt()` only exists in Node ≥ v14.10.0. The
production box runs an older Node, and there was no module-level
`require('crypto')` — so the bare `crypto` reference resolved to the global
Web-Crypto object, which has no `randomInt`.

**Fixes:**
- Added a **module-level `const crypto = require('crypto')`** so the real Node
  `crypto` is always in scope (and removed the now-redundant local require in
  `buildCaddyfile`).
- Rewrote `generateSafePassword()` to use **`crypto.randomBytes()` + rejection
  sampling** instead of `crypto.randomInt()`. This is unbiased (bytes ≥ 248 are
  rejected before `% 62`) and works on **every** Node version that ships
  `crypto` — i.e. all of them. Output is still pure-alphanumeric `[A-Za-z0-9]`,
  length floored at 8 / defaulted to 16 / capped at 64.

### Bug A — panel kept displaying the old version (e.g. 1.2.6) after an update

After `update.sh` ran, the UI still showed the previous version.

**Root cause:** the panel UI reads its version from **`config.json`**
(`/api/status` → `panel.version` = `cfg.version`), but `do_update()` only wrote
`/etc/rixxx-panel/version` (`panel_version=`). `config.json`'s `version` field
was never touched, so the API kept returning the stale value.

**Fix:** `do_update()` now also syncs `config.json`'s `version` field to
`TARGET_VERSION` (via `jq`, with a `sed` fallback), preserving the original file
content/permissions. The displayed version now matches after every update.

### Server update (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

---

## [v1.3.0] — Audit 2026-06-08 (Priority 1 bugs + fake-site + update/version mechanism)

Safe, backwards-compatible fixes. **No DB schema change**, existing keys and
cascades keep working. Server update commands are at the bottom of this entry.

### Bug 99 — update/version/deploy mechanism was broken (could not update at all)

The previous update flow could not run on a real server:

- **No scripts on prod.** `install_panel()` copied only `panel/*` to
  `/opt/panel-naive-mieru` — never `install.sh`, `update.sh`, or `.git`. So
  `cd /opt/... && git fetch` and `bash update.sh` both failed (`not a git
  repository` / `No such file or directory`).
- **Version never moved.** `update.sh` hardcoded `TARGET_VERSION` and the server
  reported the same version, so `version_gt` said "already latest" and (without
  `--force`) did nothing — even when `main` had new code.

**Fixes:**
- **Single source of truth `VERSION`** at the repo root. Both `install.sh` and
  `update.sh` read it (with a safe fallback when run standalone). A release now
  needs only a `VERSION` bump committed to `main`.
- **Remote-version-aware update.** `update.sh` fetches `VERSION` from `main`
  (`resolve_target_version()`); the update gate triggers whenever `main` is
  ahead of the installed version — no hardcoded constant to edit.
- **Scripts deployed to prod.** `install_panel()` and `update_panel()` now copy
  `install.sh`, `update.sh`, `uninstall.sh`, `VERSION`, `CHANGELOG.md` into
  `/opt/panel-naive-mieru`, so the box can self-update.
- **One-command bootstrap (no git on prod):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
  ```
- **Tarball fetch fallback** in `update_panel()` (works even if `git clone`
  fails/rate-limits) in addition to git clone and a local-checkout fallback.
- **DB backup.** `auto_backup()` now also backs up `db.sqlite` (online
  `.backup` when `sqlite3` is present). The update never touches the live DB or
  `config.json` (both live outside `/opt`), so issued keys survive.
- **Version-agnostic update sentinel** (checks the new
  `/api/password/generate` endpoint instead of a hardcoded v1.2.6 marker).

### Bug 96 (`index.js`) — mita stuck `failed` / "no user found" after first user or manual restart

`applyMitaConfig()` and `restartMieru()` never cleared a lingering systemd
`failed` state, so after the **first** user (or a manual `systemctl restart
mita`) the unit could stay `failed`/`auto-restart` and `start`/`restart` became
a no-op → the proxy stayed down with "no user found". **Fix:**
- New `resetMitaFailed()` runs `systemctl reset-failed mita` before every
  (re)start, including the manual `/api/service/mita/{start,restart}` path.
- New `clearMitaPersistedState()` removes a stale
  `~/.config/mita/server.conf.pb` on the **cold-start** path only, then
  re-applies config so mita rebuilds clean state.
- `applyMitaConfig()` now verifies `systemctl is-active mita` and forces one
  clean restart if it did not come up.

### Bug 34 (`install.sh`, `update.sh`) — install fails with Non-UTF-8

A POSIX/C or broken inherited locale on clean VMs (e.g. Yandex Cloud) made
bash/read/jq/python choke on the script's Cyrillic content. **Fix:** pin
`LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `LANGUAGE=C.UTF-8`, `PYTHONUTF8=1`,
`PYTHONIOENCODING=utf-8` at the very top of both scripts, and pass
`LANG/LC_ALL=C.UTF-8` into the PM2-managed panel process so its own
spawned helpers stay UTF-8 after a reboot/`pm2 resurrect`.

### Bug 35 + feature — special characters in password break Karing

NaiveProxy clients (Karing/NekoBox) can mishandle URL-encoded special
characters in the password. **Fix:** a backend safe-password generator
(`GET /api/password/generate?length=16`) producing `[a-zA-Z0-9]` only
(unbiased `crypto.randomInt`, default 16, floor 8, cap 64). A **"🎲 Random
password"** button + **"📋 Copy"** button were added to the key-issuance form
(auto-reveals + copies to clipboard). An alphanumeric password is byte-identical
whether parsed from the naive link or from JSON, so it works everywhere with no
encoding ambiguity. The backend user-creation flow is **unchanged** — admins may
still type their own password; the generator only suggests a safe one.

### Bug 97 (`index.js`) — Naive user traffic showed 0.0

Traffic was accounted only from `mita get users` (Mieru); NaiveProxy traffic
was never counted, so naive-only users always showed 0.0. **Fix:** new
`parseCaddyTraffic()` reads the Caddy JSON access log
(`/var/log/caddy-naive/access.log`), summing `bytes_read` (upload) +
`size`/`bytes_written` (download) per `request.user_id` (best-effort, capped at
a 32 MiB tail). `/api/stats/users` and the 60s snapshot cron now **sum** Mieru +
Naive figures and expose `naiveMB`/`mieruMB` breakdowns and a combined
`lastSeen`.

### Bug 98 (`caddyTemplate.js`, `index.js`, `install.sh`, `update.sh`) — fake site `fakeSiteUrl` never applied

`fakeSiteUrl` was collected/stored but ignored — all generators served a static
`file_server`. **Fix:** when `fakeSiteUrl` is a real absolute http(s) URL (and
not the `www.example.com` placeholder), the masquerade now uses `reverse_proxy`
to that site (with `header_up Host` + TLS-SNI for https upstreams). The static
`file_server` remains the default, so existing installs are unaffected. Applied
consistently across all four Caddyfile generators.

### Server update command (for installs already on `c1955dd` — no git/scripts on prod)

ONE command. Downloads the latest `update.sh` from `main` and runs it; backs up
DB+config first, never overwrites issued keys:

```bash
curl -fsSL https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main/update.sh | sudo bash -s -- -y
```

From v1.3.0 onward the scripts are deployed to `/opt/panel-naive-mieru`, so
later you can also just run:
```bash
sudo bash /opt/panel-naive-mieru/update.sh -y
```

After updating, verify:
```bash
systemctl is-active caddy-naive mita        # both: active
mita status                                  # RUNNING
grep -m1 panel_version /etc/rixxx-panel/version   # → 1.3.0
```

---

## [v1.2.6] — 2026-06-02

### Bug 94 (`cascade_mieru.sh`) — systemd restart-loop deadlock (mieru ↔ redsocks)

`redsocks.service.d/cascade.conf` had `Requires=mieru.service` while
`mieru.service` had `ExecStartPost=systemctl restart redsocks`. That is a
**circular start dependency**: starting mieru triggers a redsocks (re)start, but
redsocks hard-requires mieru to be fully up → `ExecStartPost` times out and both
units flap in a restart loop, so the relay never reaches a stable state and the
client handshake never completes. (Operators worked around it by deleting
`cascade.conf`.)

Fix:
- drop-in now uses a **soft** ordering: `After=mieru.service` + `Wants=mieru.service`
  (no hard `Requires=`).
- `ExecStartPost=-/bin/systemctl --no-block restart redsocks` — `-` makes a
  non-zero exit non-fatal and `--no-block` returns immediately, so the post-start
  hook can never time out or deadlock.

### Bug 95 (`cascade_mieru.sh`, `panel`) — Mieru cascade handshake failed (config parity)

**Symptom (RIXXX, 2-node stand DE entry → FI exit, both 3.33.0):** Mieru *direct*
works and Naive *cascade* works, but the **Mieru cascade** times out (curl
EXIT=97). On the exit (mita) `NewSession=0` / `NewSessionDecrypted=0` — bytes
arrive but no session is recognised. Crucially, a **localhost self-test on the
exit itself** (mieru-client → 127.0.0.1 → its own mita) *also* failed, which
rules out network/firewall/routing and pins the fault to the client↔server
config/handshake.

Diagnosis (checked against the official mieru 3.33 docs):
- The mieru session key is derived from **username + password + system time**
  (`docs/server-install.md`: *"The server can decrypt and respond only if the
  client and server have the same key… the system time of the client and the
  server must be in sync."*). A username/password mismatch **or** a clock skew →
  the server can't decrypt → `NewSession`/`NewSessionDecrypted` stay 0 and traffic
  is silently dropped. This matches the symptom exactly.
- The cascade client-config generator (`write_mieru_client_config`) carried a
  **wrong** comment ("client config MUST NOT contain mtu") and omitted `mtu` and
  `multiplexing`. Per `docs/client-install.md`, `mtu`, `multiplexing` and
  `handshakeMode` are valid fields that live **inside each `profile`**, and `mtu`
  *"must be the same as proxy server"* (default 1400, valid 1280–1400).
- Two of RIXXX's three hypotheses were **refuted by the docs** (recorded so we
  don't chase them again):
  - **Traffic pattern need NOT match.** `docs/traffic-pattern.md`: *"Traffic
    patterns can be configured independently on the client and server. The client
    and server do not need to use the same traffic pattern settings."* The
    `NONCE_TYPE_PRINTABLE_SUBSET 12/12` the exit reported is just the server's
    *implicit* pattern; the client does not need to replicate it. (So we do **not**
    inject a traffic pattern into the client config.)
  - **MTU is a UDP-only payload bound** (`docs/server-install.md` point 5); the
    cascade is TCP-only, and both ends already defaulted to 1400 — so MTU alone
    was not the breaker. We still emit `mtu` explicitly for guaranteed parity.
  - **Password/hash:** `mita reload` *does* pick up `users`/password changes
    (one of the two reload-safe fields), so a hash that "didn't change" just means
    the password was already correct — not a bug.

Fix (make the cascade correct + diagnosable out of the box):
- `write_mieru_client_config` now emits `mtu`, `multiplexing.level` and
  `handshakeMode` **inside the profile** (schema-correct), with `mtu` matching the
  exit (new `--exit-mtu`, panel passes `cascadeMieru.mtu` / `cfg.mtu`, clamped
  1280–1400) and `multiplexing` defaulting to `MULTIPLEXING_LOW` (`--exit-mux`).
- `do_setup` enables NTP (`timedatectl set-ntp true`) and warns if the entry clock
  isn't synced; it no longer swallows `mieru apply config` errors (an invalid/
  unknown field is now printed, passwords redacted).
- `do_status` gained **handshake diagnostics**: `mieru test`, a client-profile
  sanity line (user/host/ports/mtu/mux, no secrets), and an entry-clock / NTP
  check with remediation hint.
- Panel: `cascadeMieru.mtu` added to the config schema, the `GET`/`POST`
  `/api/settings/cascade` payloads, and the `runCascadeMieru('setup')` argv.

### Bug 88 (`install.sh`) — install aborted with `line 665: port: No such file or directory`

Many testers hit this on the final stage of a fresh install. The inline
Caddyfile fallback assigns a multi-line **double-quoted** shell string
(`caddyfile_content="…"`), and one comment line inside it contained an
**unescaped** double quote plus angle brackets:
```
# Bug 83: match the known-good reference server (":<port>, <domain>" listener +
```
Inside a `"…"` assignment the stray `"` *closed* the string, so bash then parsed
`:<port>` as a redirection from a file named `port` →
`line 665: port: No such file or directory`, and the generated Caddyfile was
truncated. (The users' workaround — deleting the `# Bug 83` line and removing the
comma — worked only because it deleted the poisoned comment, not because of the
comma.)

Fix: rewrite the comment with no double-quote / `<` / `>` characters. The
site-address line `:${NAIVE_PORT}, ${DOMAIN} {` (the catch-all `:443` **plus** the
domain, Bug 83 layout) is kept intact — it is valid Caddy and not the cause.

### Bug 90 (`panel`, `install.sh`) — Caddyfile written `root:root` is unreadable by `User=caddy`

`caddy-naive.service` runs as `User=caddy/Group=caddy`, but the panel wrote
`/etc/caddy-naive/Caddyfile` as `root:root 640`. The caddy user cannot read it →
`open …/Caddyfile: permission denied` → crash loop → systemd blocks it with
*"Start request repeated too quickly"*.

Fix: every Caddyfile write now hands ownership to **root:caddy** and keeps the
config dir traversable by the group:
- `panel/server/index.js` `writeCaddyfileAtomic()` calls a new `fixCaddyPerms()`
  (dir `root:caddy 750`, Caddyfile + `probe_secret` `root:caddy 640`).
- `install.sh` `write_caddyfile()` adds `chown root:caddy` after the `chmod 640`
  (in addition to `start_services()`'s existing Bug 79 dir fixup).

### Bug 91 (`panel`, `update.sh`) — `reload` silently kept the OLD config and masked failures

The panel applied config via `systemctl reload` (kill -USR1). A graceful reload
**silently keeps the in-memory config loaded at start** when the new config can't
be read (e.g. Bug 90). Everything *looked* healthy — `caddy validate` Valid,
`systemctl status` active, logs *"Reloaded"*, even a direct
`curl -x https://u:p@exit:443` returned the exit IP — yet the running process
never loaded the new `upstream`, so the client egressed from the **Entry** node.
It only surfaced on a full `restart` (which then failed with the Bug 90 perms
error).

Fix: after writing the Caddyfile, always do a **full `systemctl restart`**, then
verify `systemctl is-active`; on failure surface the real `journalctl` error.
- `panel/server/index.js`: new `applyCaddyConfig()` (restart + is-active +
  `collectCaddyError()`); `reloadCaddy()`/`restartCaddy()` now delegate to it.
  `applyAllConfigs()` and the cascade POST return `caddyError` to the UI.
- `update.sh`: the `reload || restart` block replaced with `reset-failed` +
  `restart` + `is-active` check.

### Bug 89 (`panel`) — new naive key didn't activate until `update.sh --force`

Creating a naive key in the panel didn't work in Karing until the operator ran
`sudo bash update.sh --force -y`. Root cause was the combination of Bug 90
(file written `root:root`) and Bug 91 (`reload` silently failing); `update.sh`
"fixed" it only because it ran `fix_caddy_perms` (root:caddy) + restart. With the
Bug 90 chown and the Bug 91 restart+verify now in the per-CRUD `applyAllConfigs()`
path, a new key activates immediately — no `--force` needed.

### Bug 92 (`panel`) — `upstream naive+https://…` rejected by `forward_proxy`

Users paste the subscription-format exit key as-is
(`naive+https://user:pass@host:443`). The panel wrote it verbatim, and
`caddy validate` failed:
> forward_proxy: insecure schemes are only allowed to localhost upstreams

`forward_proxy upstream` only accepts a clean `https://` URL. Fix: a shared
`normalizeUpstream()` strips a leading `naive+` (any `<scheme>+` wrapper), upgrades
`http://`→`https://`, and assumes `https://` when no scheme is given. Applied in
`panel/server/index.js` (store + both build paths) and in
`panel/server/caddyTemplate.js` `render()` (single source of truth, so
install.sh/update.sh inherit it).

### Bug 93 (`panel`, UX) — "Проверить статус" didn't diagnose the Naive cascade

The status button only ran the Mieru (Variant B) diagnostics, so a Naive-only
cascade always showed `configured: 0 / inactive` — misleading. Fix: a new
`naiveCascadeStatusText()` block reports, with credentials redacted:
`upstream` present in the live Caddyfile, `caddy-naive validate`,
`systemctl is-active caddy-naive`, and the **egress IP measured through the naive
upstream** (`curl -x https://u:p@exit:443 https://api.ipify.org`). The
`/api/settings/cascade/status` response now contains both the **NAIVE CASCADE**
and **MIERU CASCADE** sections (no UI change needed — it renders the text).

### Bug 87 (`panel`) — subscription JSON used `type:"http"` for naive (should be `type:"naive"`)

Live testing: from the universal subscription the **mieru** outbound worked but
the **naive** one did not, while the manual `naive+https://…` key worked fine.
The user also noticed Karing labelled the subscription's outbound `naive-out`
but the manual key `jazz.magniysovetuy.site:443` — a tell that the two were
*different outbound types*.

Root cause: `/api/users/:id/config/universal` emitted the naive outbound as
```json
{ "type": "http", "tag": "naive-out", … }
```
A plain `type:http` is an ordinary HTTP-CONNECT proxy. It performs TLS + CONNECT
but lacks NaiveProxy's Cronet/Chromium traffic shaping (HTTP/2 framing, padding,
header order) that the `caddy-forwardproxy-naive` server expects — so the server
never tunnels its traffic. The manual key parses to `type:naive` (Cronet), which
is why it worked.

Fix: emit the sing-box NaiveProxy outbound per the official spec
(<https://sing-box.sagernet.org/configuration/outbound/naive/>):
```json
{ "type": "naive", "tag": "naive-out",
  "server": "<domain>", "server_port": <port>,
  "username": "<u>", "password": "<p>",
  "quic": false,
  "tls": { "enabled": true, "server_name": "<domain>" } }
```
`quic:false` matches the server's `servers { protocols h1 h2 }` (Bug 80 — HTTP/3
disabled); `tls` carries only `server_name` (the naive outbound ignores other TLS
fields). Karing ships the `with_naive_outbound` build (libcronet), so
`type:naive` works there exactly like the manual key.

### Bug 86 (`update.sh`) — `rebuild_caddyfile_direct` silently wrote nothing (inline `node -e` bash-quoting)

Even after Bug 84/85 let `--repair` reach the rebuild, the live
`/etc/caddy-naive/Caddyfile` stayed OLD (mtime never changed) while the run
reported `Caddyfile rebuilt ✓`. Decisive evidence: the `[Caddyfile] rebuilt with
N user(s)` line that the node script prints **never appeared** in `--repair`
output (the mita equivalent `[mita-state] wrote N user(s)` did), and running the
*exact same logic* from a standalone `.js` file wrote the correct Bug 83
Caddyfile instantly (`WROTE 1540 bytes … NOW NEW ✅`).

Root cause: the rebuild ran as a giant **inline `node -e "<script>"`** embedded in
a **double-quoted bash string**. Bash pre-processed the whole blob —
`$DB_PATH`/`$PANEL_CONFIG`/`$CADDY_FILE` were string-substituted and any stray
`$`, backtick or `\` was subject to bash quoting. On the live server this
produced a node program that exited 0 **without writing the file**, after which
`caddy validate` validated the STALE Caddyfile → false "rebuilt ✓".

Fix: write the rebuild script with a **quoted heredoc** (`<<'NODE_EOF'`, zero bash
expansion), pass every path via `process.env` (`RB_DB_PATH`, `RB_PANEL_CONFIG`,
`RB_CADDY_FILE`, `RB_CADDY_CFGDIR`, `RB_TEMPLATE_JS`, `RB_FAKE_SITE`), and run
`node "$rebuild_js"`. A real failure now exits non-zero and is caught
(`log_warn` + `return 1`) instead of silently no-op'ing.

* **Bug 86b:** the temp `.js` is written **inside `$PANEL_DIR`** (not `/tmp`),
  because node resolves `require('better-sqlite3')` relative to the *script
  file's* directory, not the cwd — a `/tmp/*.js` would look in
  `/tmp/node_modules` and fail (re-triggering the Bug 82 "Cannot find module").

Verified end-to-end with a throwaway SQLite DB + config: the script writes the
exact reference layout (`:443, <domain> { tls <email>; forward_proxy {…}; …}`,
no `route{}`, both users, `protocols h1 h2`, bare `probe_resistance`).

### Bug 85 (`update.sh`) — `--repair` (and `--status`/`--expose`/`--ssh-only`) exited 1 SILENTLY before doing anything

Live testing: `sudo bash update.sh --repair -y` returned `EXIT=1` with **zero
output** and the Caddyfile was never rebuilt (still the old Bug 83-era layout),
so Bug 84's direct rebuild never even ran.

Root cause — the classic Bug 77 `set -e` trap: the **last** statement of
`parse_args` was
```bash
[[ -z "$MODE" ]] && MODE="update"
```
When a mode flag was supplied (e.g. `--repair` → `MODE="repair"`), the test
`[[ -z "repair" ]]` is FALSE, so `parse_args` **returned 1**. In `main()`,
`parse_args "$@"` is a plain command → `set -euo pipefail` aborted the whole
script immediately, and because the failure was a function *return* the `ERR`
trap was skipped → no message at all. This only hit mode flags; a bare update
left `MODE` empty, so the test was TRUE → return 0 → it worked (which is why
`--force -y` always ran but `--repair` never did).

Fix: replace the trailing one-liner with an explicit `if` block and a trailing
`return 0`:
```bash
if [[ -z "$MODE" ]]; then MODE="update"; fi
return 0
```
Now `--repair`/`--status`/`--expose`/`--ssh-only` reach their handlers, and with
Bug 84 `--repair` rebuilds the Caddyfile directly from the on-disk template.

### Bug 84 (`update.sh`) — `--repair` regenerated a STALE Caddyfile via the panel API

After Bug 83 was merged and deployed (the on-disk `caddyTemplate.js` in
`$PANEL_DIR` was confirmed to be the new format, 7346 bytes), the live
`/etc/caddy-naive/Caddyfile` was *still* the old layout (`route {}` wrapper,
domain-only listener) even though the rebuild reported success.

Root cause: `do_repair` POSTed to `/api/services/rebuild-all` **first**, which is
rendered by the **running PM2 panel process** using its *in-memory* `buildCaddyfile()`
from `index.js`. If that process hadn't reloaded the new `index.js` yet, the API
regenerated the OLD Caddyfile format — and the `rebuild_caddyfile_direct` fallback
(which uses the on-disk template, the single source of truth) **never ran** because
the API call "succeeded". So the new template on disk was ignored.

Fix: `do_repair` now **always** calls `rebuild_caddyfile_direct` /
`rebuild_mita_state_direct` directly, dropping the API-first path. The rebuilt
Caddyfile therefore always reflects `$PANEL_DIR/server/caddyTemplate.js` regardless
of whatever code the panel happens to have loaded in memory. (`do_update` already
used the direct rebuild and restarts PM2 with `--update-env`, so it was unaffected.)

### Bug 83 (`panel` + `install.sh` + `update.sh`) — Caddyfile site block to match reference exactly

Live testing: even after Bug 80/81 the naive key still wouldn't connect, while the
user's reference server worked. Side-by-side of both Caddyfiles showed the site
block differed structurally:

* Reference: `:443, poppuri.site { tls <email>; forward_proxy {...}; file_server {...} }`
* Ours:      `jazz.magniysovetuy.site:443 { route { forward_proxy {...} file_server {...} } }`

Three differences fixed so ours is byte-for-byte equivalent to the working server:
1. **Listener** `:<port>, <domain>` (catch-all `:443` **plus** the domain) instead of
   the domain-only `<domain>:<port>`. The catch-all ensures the CONNECT request
   matches this site regardless of how the client sets SNI/Host (the likely cause of
   the key not connecting).
2. **Explicit `tls <email>`** inside the site block (instead of relying solely on the
   global `email` + automatic HTTPS).
3. **Removed the `route { }` wrapper** — `forward_proxy` and `file_server` now sit
   directly in the site block; ordering still comes from the global
   `order forward_proxy before file_server`.

Applied to all four generators: `caddyTemplate.js`, `index.js` inline fallback,
`install.sh`, `update.sh`.

### Bug 82 (`update.sh` + `install.sh`) — `node -e` couldn't find `better-sqlite3`

Live update showed the Caddyfile rebuild crashing with
`Error: Cannot find module 'better-sqlite3'`, so the config was **not** regenerated
(stale Caddyfile kept the old secret + missing protocols block). Cause: the inline
`node -e "…"` scripts run with cwd = the git checkout (`~/Panel-Naive-Mieru-by-RIXXX`),
which has no `node_modules`; the modules live under `$PANEL_DIR`
(`/opt/panel-naive-mieru`). Fix: wrap the DB-reading `node -e` blocks in
`( cd "$PANEL_DIR" && node -e "…" )` so Node resolves `better-sqlite3` and the
template correctly.
- `update.sh`: `rebuild_caddyfile_direct()` and `rebuild_mita_state_direct()`.
- `install.sh`: the `naive_users_json` reader (its silent `try/catch` previously
  meant a `--force` reinstall could quietly drop all naive users).

### Bug 81b (`update.sh`) — migrate existing installs to bare + regenerate on update

Follow-up after live testing: `--force` update did **not** regenerate the Caddyfile
(it only restarted caddy), and existing `config.json` had a `probeSecret` but no
`probeMode`, so back-compat kept the old `probe_resistance <secret>` line and the
`servers { protocols h1 h2 }` block never appeared. Two fixes:

1. **`migrate_config()`** — on `update`/`repair`, when `probeMode` is missing it is
   set to `'bare'` (matching the reference server). The stored `probeSecret` is kept
   so the user can switch back to `secret` from the panel later.
2. **`do_update` now regenerates the Caddyfile** via `rebuild_caddyfile_direct()`
   (caddyTemplate.js) after migration, so the protocols block and bare
   `probe_resistance` take effect on a plain `update.sh --force` without needing
   a separate `--repair`.

### Bug 81 (`panel` + `install.sh` + `update.sh`) — probe_resistance mode (bare/secret/off)

**Naive config parity with a known-good reference server.** The user compared our
generated Caddyfile against a working reference (`poppuri.site`) and found we always
emitted `probe_resistance <secret>`, whereas the reference uses a **bare**
`probe_resistance` (no secret). With a secret, the masquerade site is only reachable
via a special secret domain — bare is simpler and matches the working server.

- New **`probeMode`** config field: `'off' | 'bare' | 'secret'`.
  - `off`    → no `probe_resistance` line at all.
  - `bare`   → bare `probe_resistance` (no secret) — **new default**, matches reference.
  - `secret` → `probe_resistance <secret>` (legacy behaviour; requires a secret domain).
- Back-compat: when `probeMode` is unset it is derived from `probeSecret`
  (non-empty → `secret`, empty → `bare`), so existing installs keep their behaviour.
- `caddyTemplate.js`, `index.js` inline fallback, `install.sh` + `update.sh` inline
  fallbacks all honour `probeMode`.
- Panel UI: Settings → Probe Resistance card now has a **mode selector**; the secret
  input is shown only in `secret` mode. New `POST /api/settings/probe-mode` endpoint;
  `POST /api/settings/probe-secret` now also sets `probeMode='secret'`.
- Status endpoint now returns `probeMode`. Locales (ru/en) updated.

### Bug 80 (`panel` + `install.sh` + `update.sh`) — disable HTTP/3/QUIC (`protocols h1 h2`)

The working reference server pins Caddy to HTTP/1.1 + HTTP/2 via a global
`servers { protocols h1 h2 }` block; our generated config left HTTP/3/QUIC enabled.
NaiveProxy tunnels over HTTP/2 `CONNECT`, and HTTP/3 can break some clients. Added the
block to all four Caddyfile generators (`caddyTemplate.js`, `index.js` inline fallback,
`install.sh`, `update.sh`) so naive matches the known-good reference.

### Bug 79b (`install.sh` + `update.sh`) — caddy-naive perms follow-up

Live-server diagnostics after Bug 79 showed the config **directory** was actually
fine (`drwxr-xr-x root caddy`), but the **Caddyfile itself was owned `root:root`**
(`-rw-r----- root root`) — so the caddy group's read bit was useless and the
service still failed with `permission denied`. Two follow-ups:

1. The real fix is the `chown -R root:caddy` already in `fix_caddy_perms()`; the
   earlier update simply hadn't shipped it yet (stale local clone).
2. **Failure-storm + ordering:** `update_caddy_naive` reinstalled the binary and
   immediately `systemctl start`ed it *before* perms were fixed, tripping the
   5-in-5-min restart limit (`Start request repeated too quickly`), so the later
   `fix_caddy_perms` couldn't recover the service. Fixes:
   - `update_caddy_naive` now calls `fix_caddy_perms` + `systemctl reset-failed`
     **before** starting caddy after a binary reinstall (also re-applies setcap,
     which `install` strips).
   - `do_update` and `install.sh start_services` add `systemctl reset-failed`
     before the (re)start.

### Bug 79 (`install.sh` + `update.sh`) — caddy-naive "Caddyfile: permission denied"

**P1 — Naive shown as disabled in the panel.** On the live server `caddy-naive`
was in a `failed` state, restart-looping with:
```
Error: reading config from file: open /etc/caddy-naive/Caddyfile: permission denied
```

Root cause — a directory-traversal permission bug. The service runs as
`User=caddy`, but the installer set up `/etc/caddy-naive` with
`chgrp caddy + chmod -R g+r + chmod 640 Caddyfile`. That gives the **group** read
on the files, but a **640 directory** (`drw-r-----`) has **no execute (x) bit for
the group**, so the `caddy` user cannot *traverse* the directory to open the file
inside it — hence "permission denied", even though the file's own perms looked OK.

**Fix** (both scripts):
- Own the whole config dir as `root:caddy`.
- Directory → **750** (`rwxr-x---`, group can traverse + list).
- Files → **640** (`rw-r-----`, group can read).
- Order matters: chmod the top dir to 750 **first**, then `find` the contents
  (a 640 dir can't be descended into by `find`). Verified in a sandbox.
- `update.sh` gains a `fix_caddy_perms()` helper, called from
  `rebuild_caddyfile_direct`, `do_repair`, and `do_update` (which now also
  restarts caddy-naive), so existing broken installs self-heal on update.

### Bug 78 (panel) — Monitoring traffic always 0 + selectable Mieru port

**P2 — traffic never updated.** Both `/api/stats/users` and the 60-second traffic
snapshot cron called `mita describe users` — a command that **does not exist** in
mita. It always returned empty output, so `parseMitaUsers` produced `[]` and every
key showed 0 MB regardless of real usage.

Root cause confirmed against the upstream mieru docs (`docs/operation.md`): the
real command is **`mita get users`**, which prints a table:
```
User  LastActive            1DayDownload  1DayUpload  30DaysDownload  30DaysUpload
abcd  2025-04-23T01:02:03Z  938.1MiB      12.9MiB     4.0GiB          31.8MiB
```
(There is also `mita get quotas` for quota progress.)

**Fix**:
- Replaced `mita describe users` → `mita get users` in both call sites.
- Rewrote `parseMitaUsers` to parse the real table: per-user `usedMB` = 30-day
  download + 30-day upload, `lastSeen` from the `LastActive` column.
- Rewrote `toMB` to understand IEC units (`B`/`KiB`/`MiB`/`GiB`/`TiB`) as well as
  the decimal spellings. Covered by a unit test against the documented output.

**P3 — selectable Mieru port in generated configs.** The config generators always
wrote the **range start** (e.g. 2012) into `server_port`. mita listens on the whole
configured range, so any port inside it is valid to dial.

**Fix**:
- `/api/users/:id/config/mieru` and `/config/universal` now accept an optional
  `?port=<n>` query param, validated against `[mieruPortStart, mieruPortEnd]` via
  the new `pickMieruPort()` helper (falls back to the range start when omitted or
  out of range — fully backward compatible).
- Added a "Mieru port" selector to the config-download modal (prefilled with the
  range, empty = range start) plus `config.mieruPort*` locale keys (ru/en).

### Bug 77 (`update.sh`) — **the actual** silent-exit cause: `check_root`/`check_install`

Even after Bug 76's ERR trap, `sudo bash update.sh --force -y` still printed
**nothing** and returned to the prompt (exit 1). A `bash -x` trace pinned it down:
the script died immediately after `check_root` at `[[ 0 -ne 0 ]]`.

Root cause — a classic `set -e` footgun. The one-liner functions were:
```sh
check_root()    { [[ $EUID -ne 0 ]] && die "Run as root"; }
check_install() { [[ ! -f "$PANEL_CONFIG" ]] && die "..."; }
```
On the **happy path** (running as root / panel installed), the `[[ ]]` test is
**false**, the `&&` short-circuits, and the test's exit status `1` becomes the
**function's** return value. When `main` then calls `check_root` as a plain
command, that non-zero return trips `set -e` → the whole script aborts before
any `log_*` runs (and the function-return doesn't reliably fire the ERR trap).

**Fix**: rewrote both as explicit `if` blocks ending in `return 0`. Verified with
`bash -x`: the script now runs end-to-end, copies the panel files, and reports
`Panel updated ✓ (v1.2.6 markers present)`.

### Bug 76 (`update.sh`) — update silently did nothing / skipped panel files

After a clean update, the live panel in `/opt/panel-naive-mieru` still ran the
old code (P3 password prompt present, no `downloadNote`/Bug-75 markers), and
`sudo bash update.sh -y` printed **nothing** and returned to the prompt.

Two root causes:
1. **Silent abort** — `set -euo pipefail` with no ERR trap: any un-handled
   non-zero command (e.g. a hiccup in `npm install --production`, or a `jq`
   parse under command substitution) aborted the whole script with zero output.
2. **"Already up-to-date" lie** — the version file had already been bumped to
   `1.2.6` by an earlier *partial* run that never copied the panel files, so the
   next `-y` run treated it as current and skipped the file sync.

**Fixes**:
- Added an `ERR` trap that prints the failing line + a hint to re-run with
  `--force -y` — no more silent exits.
- `update_panel()` now: falls back to the local `./panel` checkout if `git clone`
  fails, copies **all** files with `cp -a "$src/."`, runs `npm install` as
  **non-fatal**, restarts PM2 with `--update-env`, and **verifies** a v1.2.6
  sentinel (`downloadNote`) actually landed.
- In non-interactive mode (`-y`), an "up-to-date" version no longer skips the
  panel re-sync (the copy is idempotent and cheap).

### Bug 75 (P1, mieru server) — mita stayed IDLE, so the proxy never listened

Server logs showed `mita` running but reporting `app status IDLE`, and
`/var/lib/rixxx-panel/mita-state.json` held the correct port bindings + user — yet
mieru clients couldn't connect. Root cause: when a user is added via the panel,
`applyMitaConfig()` ran `mita apply config` followed by `mita reload`. Per the
upstream docs, **`mita reload` only re-reads the config of an already-RUNNING
server — it does NOT lift the service from IDLE → RUNNING.** Since the installer
intentionally does not start mita while `users[]` is empty (Bug 4), the first
panel-driven config update reloaded an IDLE server that never bound its ports.

**Fix**: `applyMitaConfig()` now checks `mita status`; if RUNNING it `reload`s,
otherwise it `mita start`s (falling back to `systemctl restart mita`). `install.sh`
likewise now issues `mita start` (not just a daemon restart) once the first user
exists, so the proxy actually enters RUNNING and binds 2012–2022.

Verified on the live server: after `mita start`, `mita status` → `RUNNING` and
`mita describe config` showed the user with `hashedPassword`
`2af72f0fee0af51523d57bca1e436aca52b85dd644e2f5e6c76d1bdc1c1129bf`. Confirmed via
the upstream protocol spec (`hashedPassword = SHA256(password || 0x00 ||
username)`) that this hash matches the expected plaintext password — i.e. the
panel stores and applies the correct mieru credential. (The empty `password` field
in `describe config` is expected: mita only keeps the hash.)

### Bug 74 (P1, mieru client config) — generated Mieru config did not connect

Field-tested against a **known-working** Karing/sing-box mieru config from another
server, the panel's generated mieru outbound differed in two ways that break the
client's mieru parser:

- We emitted `multiplex: { enabled: false }` (an object). The working client uses
  the string enum **`multiplexing: "MULTIPLEXING_HIGH"`**. The object form is for
  other protocols' stream-multiplexing and is silently rejected by the mieru
  outbound → no connection. **Fixed** in both `/config/mieru` and the mieru
  outbound of `/config/universal`.
- We sent both a single `server_port` **and** a `server_ports` array. The working
  config sends only a single `server_port`. Dropped the array to match.
- Mieru `server` now prefers the raw server IP (mieru is IP-based, no SNI/TLS),
  and the standalone mieru config now includes the same minimal `dns` block as
  the reference config.

Server-side diagnosis confirmed the VPS itself is healthy: Caddy holds a valid
Let's Encrypt cert (`curl -vI` → HTTP/2 200, verify ok), DNS A-record matches the
server IP, firewall opens 80/443/2012-2022 — so the no-connection issue was the
client config format, not the server.

### UX fixes (`genspark_ai_developer_audit`)

- **P2 — Email is now optional when adding a user.** The TLS certificate is
  obtained at install time via Caddy's ACME (the global `email` directive), not
  per-user, so a per-user email served no purpose. Removed the `required`
  attribute and the `*` from the form, relaxed `validateUserInput()` (an email is
  still format-checked *if* provided), and store `NULL` (not `''`) for empty
  emails. Added a one-time DB migration that rebuilds `users.email` from
  `TEXT NOT NULL UNIQUE` → `TEXT UNIQUE`, so multiple email-less users no longer
  collide on the UNIQUE constraint. Existing emails are preserved.

- **P3 — Removed the password prompt when downloading a client config.** The
  config-download modal previously asked for the user's password even though the
  admin is already authenticated and the server stores the plaintext password.
  The naive link / QR now auto-load on open and all three downloads (naive,
  mieru, universal) use the server's stored-password fallback — no extra input
  required. Removed the `cfg-password` input + note from the modal.

### Audit & cascade hardening (`genspark_ai_developer_audit`)

- **Bug 73 (P0, `install.sh`)** — **install aborted at `write_config_json`** on a
  clean Ubuntu 24.04: the admin password was passed to `node -e` as
  `process.argv[2]`, but `node -e` has no script-path arg so the value lands at
  `argv[1]`. `argv[2]` was `undefined` → `bcrypt.hashSync` threw → the
  `htpasswd` fallback failed too (apache2-utils not installed) → `die`, so
  `config.json` was never written and the panel/PM2 never started (`:3000` dead).
  **Fix**: pass the password via the `RIXXX_ADMIN_PASS` env var and read it from
  `process.env` (also avoids shell-quoting issues with special chars); the
  fallback now installs `apache2-utils` first. Added `install_panel` fallback to
  `$PWD/panel` and wrapped `npm install` in a subshell so the main shell's cwd is
  preserved. Regression checks added to `tests/e2e.sh`.


Pre-test tech-lead audit. The Mieru cascade was re-architected from native `egress`
(Variant A) to the field-tested **Variant B** (redsocks + iptables + mieru-client),
because the Exit node is a full Mieru server (`mita`), not a raw SOCKS5 endpoint.

- **P0 fix** — Mieru native egress SOCKS5 auth field corrected `username` → `user`
  (`app.js`), matching the official `socks5Authentication.{user,password}` schema.
- **P0 fix** — version sync to `1.2.6` across `uninstall.sh`, `tests/e2e.sh`,
  and `install.sh` ARM messages (previously `1.2.5`, would fail the e2e version step).
- **Added `panel/scripts/cascade_mieru.sh`** — orchestrator for Variant B with
  `setup` / `teardown` / `status`. Encapsulates the proven manual guide while
  avoiding its pitfalls: `profiles` (plural), no `mtu` in client config,
  `Type=forking` + `mieru start`, redsocks restarted with mieru via
  `ExecStartPost`, anti-loop `RETURN` for the resolved Exit IP, watchdog that
  restarts only after 3 consecutive failures, **lazy install** of
  `redsocks` + `mieru-client` on first enable, and the **full Exit port range**.
- **Server (`index.js`)** — `POST /api/settings/cascade` now runs
  `cascade_mieru.sh setup/teardown` for the Mieru leg (Naive leg still via
  Caddyfile `upstream`); `buildMitaStateFile()` no longer injects native egress
  when a Variant B exit host is set (legacy egress kept as explicit fallback);
  new `cfg.cascadeMieru { host, portStart, portEnd, user, pass }`; new
  `GET /api/settings/cascade/status`; `/api/config` masks the exit password
  (returns a boolean) so secrets never reach the browser; `runCascadeMieru()`
  uses `execFileSync` (no shell) so credentials are argv-safe.
- **UI** — exit **port range** (start/end) inputs, host/IP + username/password
  relabelled, blank-password-keeps-existing, a **Check status** button and a
  status panel; ru/en i18n keys added.
- **`install.sh`** — new `tune_network()` step finally invokes
  `scripts/sysctl_tune.sh` (BBR + UDP buffers).
- **`uninstall.sh`** — full cascade cleanup (iptables `REDSOCKS` chain,
  `mieru.service`, redsocks + drop-in, `/etc/redsocks.conf`, watchdog + cron,
  shred of client config + state) and an optional redsocks apt-purge prompt.

### Added

- **Cascade / Relay architecture (NaiveProxy + Mieru)** — Settings UI now supports chaining traffic through an intermediate "Exit" node:
  - **NaiveProxy**: `upstream` directive in `caddy-forwardproxy-naive` (`upstream https://user:pass@host:port`) for `client → Entry (RU) → Exit (EU) → internet`.
  - **Mieru**: `egress` property with SOCKS5 outbound proxies in `mita` config (`SOCKS5_PROXY_PROTOCOL` + `socks5Authentication`).
  - New REST API endpoints: `GET /api/settings/cascade`, `POST /api/settings/cascade` (requires auth).
  - New UI card in Settings page (`index.html` + `app.js`): checkbox "Enable cascade", Naive upstream URL input, Mieru exit host/port/user/pass inputs.
  - `caddyTemplate.js` `render(cfg, naiveUsers)` now accepts `upstream` parameter and emits `upstream <url>` inside the `forward_proxy` block.
  - `buildMitaStateFile()` in `index.js` injects `egress` JSON when `cascadeEnabled === true`.
  - Atomic config writes via `.new` + `fs.renameSync()` preserved for both Caddyfile and mita-state.

### Fixed

- **Bug 70 (P0, `install.sh`)**: Removed phantom `log_info "caddy-naive запущен ✓"` in `start_services()` that fired unconditionally even when `caddy-naive` failed to start, masking real startup failures.
- **Bug 71 (P0, `update.sh`)**: `smoke_test()` contained corrupted/garbage bytes and a duplicate function definition, causing syntax errors or unpredictable behaviour during update. Cleaned and deduplicated the function.
- **Bug 72 (P1, `update.sh`)**: `rebuild_caddyfile_direct()` did not pass `upstream` into `tpl.render()`, so cascade changes made via UI were lost on `--repair`. Fixed by threading `cfg.cascadeNaiveUpstream` through the Node one-liner.

### Changed

- `install.sh` version → `1.2.6`; `CURRENT_VERSION="1.2.6"`.
- `update.sh` version → `1.2.6`; `TARGET_VERSION="1.2.6"`.
- `panel/server/caddyTemplate.js` version comment → `v1.2.6`.
- `panel/server/index.js` version comment → `v1.2.6`; `DEFAULT_CONFIG.version` → `1.2.6`; added `cascadeEnabled`, `cascadeNaiveUpstream`, `cascadeMieruEgress` fields.
- `panel/public/index.html` version labels → `v1.2.6` (title, sidebar, topbar, about).
- `panel/public/app.js` version comment → `v1.2.6`; added `changeCascade()` handler, cascade field loading in `loadSettings()`, delegated click mapping for `change-cascade`.
- `panel/public/locales/ru.json` + `en.json` — added cascade translation keys under `settings.*` and `toast.*`.
- `README.md` / `README.en.md` — version badge bumped to `v1.2.6`; added Cascade/Relay architecture section with ASCII diagram and UI instructions.

---

## [v1.2.5] — 2026-05-07 (rev.2 — post-release audit)

### Fixed (P0 — release blockers)

- **Bug 41 (P0, `install.sh`)**: `write_config_json()` ran before `install_panel()`, so `bcryptjs` (from `panel/node_modules`) was not yet available when the admin-password hash was generated via `node -e "require('bcryptjs')"`. **Fix**: `install_panel` is called before `write_config_json` in `main()`.

- **Bug 42 (P0, `install.sh`)**: `/var/log/caddy-naive` was created by `write_caddyfile()` (running as root) before the `caddy` system user existed, leaving it owned by `root`. When Caddy later ran as `caddy`, it could not write the access log. **Fix**: `write_caddyfile()` no longer creates that directory; `start_services()` creates `/var/log/caddy-naive` and `/var/lib/caddy` **after** the `caddy` system user is created, setting `caddy:caddy 755/700` ownership.

- **Bug 43 (P0, `install.sh`)**: Caddy could not store ACME certificates because `/var/lib/caddy` did not exist and `XDG_DATA_HOME` was not set in the systemd unit. **Fix**: `start_services()` creates and chowns `/var/lib/caddy`; `write_caddy_service()` adds `Environment=XDG_DATA_HOME=/var/lib/caddy`, `Environment=XDG_CONFIG_HOME=/var/lib/caddy`, and `ReadWritePaths=/var/log/caddy-naive /etc/caddy-naive /var/lib/caddy` to the unit.

- **Bug 44 (P0, `panel/server/index.js`)**: `buildCaddyfile()` fell back to `passHash` (a bcrypt hash) when `password` was absent, and fed the bcrypt string directly to the Caddyfile. `caddy-forwardproxy-naive` hashes passwords internally and cannot accept a pre-hashed value, causing auth failures. **Fix**: users without a non-empty `password` field are silently skipped with a `console.warn` log line. A placeholder credential is still emitted when the filtered list is empty (Bug 34 behaviour preserved).

### Fixed (P1 — correctness)

- **Bug 45 (P1, `README.md` + `README.en.md`)**: No documentation warned operators about the plaintext-password storage model. `caddy-forwardproxy-naive` requires plaintext passwords at startup (it hashes them internally), so the panel must store them in SQLite. **Fix**: a `🔐 Security Warning` block added to both README files explaining the model, advising `600 root:root` permissions, and recommending against password reuse.

- **Bug 50 (P1, `panel/server/index.js`)**: `reloadCaddy()` used `systemctl reload … || kill -USR1 $(pgrep -x caddy-naive …)` — the `pgrep -x` fallback matched on the exact comm-name which may differ from the binary name, sending SIGUSR1 to the wrong PID or failing silently. **Fix**: `reloadCaddy()` now calls only `systemctl reload caddy-naive`; the broken fallback is removed.

- **Bug 51 (P1, `panel/server/index.js`)**: `buildMitaStateFile()` iterated `cfg.mieruPortStart … cfg.mieruPortEnd` without guarding against `undefined`/`NaN`, causing an infinite loop if the config file was missing or corrupt. **Fix**: `parseInt(...) || 2000` / `|| 2010` safe defaults applied before the loop.

- **Bug 52 (P1, `panel/server/index.js`)**: `POST /api/settings/naive-port` called `restartCaddy()` and returned `{ ok }` based on the function's return value, but `restartCaddy()` returns `false` only on a Node `execSync` exception — not when `systemctl restart` exits 0 but Caddy then dies. **Fix**: after `restartCaddy()`, `systemctl is-active caddy-naive` is checked; on failure the endpoint returns HTTP 500 with an actionable error message.

- **Bug 53 (P1, `panel/server/index.js`)**: `saveConfig()` called `fs.writeFileSync()` directly on the live `config.json` — a process kill mid-write left a truncated/corrupt file. **Fix**: `saveConfig()` writes to `config.json.new` first, then atomically renames to `config.json`.

### Fixed (P2 — lower priority)

- **Bug 55 (P2, `install.sh`)**: `caddy-naive` binary was `chmod 750`, preventing non-root users from running `caddy validate`. **Fix**: `start_services()` uses `chmod 755` (already applied in v1.2.4 code, now formally documented here).

- **Bug 60 (P2, `install.sh`)**: `write_caddyfile()` did not run `caddy fmt`, leaving the Caddyfile with mixed indentation that generated fmt warnings on every service start. **Fix**: `caddy fmt --overwrite "$CADDY_FILE"` is called immediately after the atomic write; errors are logged (non-fatal) to `$INSTALL_LOG`.

- **Bug 62 (P2, `install.sh`)**: `caddy-naive.service` lacked restart-storm protection; repeated ACME failures could hammer Let's Encrypt rate limits. **Fix**: `StartLimitBurst=5`, `StartLimitIntervalSec=300`, `RestartSec=10` added to the unit (already applied in v1.2.4 code; now formally documented).

- **Bug 63 (P2, `panel/server/caddyTemplate.js`)**: `roll_size` value used extra trailing spaces (`roll_size     50mb`) that `caddy fmt` normalised on every reload, producing noisy diffs. **Fix**: aligned spacing reduced to single space (`roll_size 50mb`).

- **Bug 64 (P2, `install.sh`)**: `mita.service` was enabled in `start_services()` but not verified with `systemctl enable`. **Fix**: `systemctl enable mita 2>/dev/null || true` is already present and correct; now explicitly tested in `e2e.sh`.

### Added / Changed

- `panel/server/caddyTemplate.js` version comment → `v1.2.5`.
- `panel/server/index.js` version comment → `v1.2.5`; `DEFAULT_CONFIG.version` → `1.2.5`.
- `panel/package.json` version → `1.2.5`.
- `panel/public/index.html` version labels → `v1.2.5`.
- `panel/public/app.js` version comment → `v1.2.5`.
- `install.sh` header → `v1.2.5`; `CURRENT_VERSION="1.2.5"`.
- `update.sh` header → `v1.2.5`; `TARGET_VERSION="1.2.5"`.
- `README.md` / `README.en.md` version badges → `v1.2.5`.
- `tests/e2e.sh` version checks updated to `1.2.5`; added check for `mita.service` enabled (Bug 64).

### Fixed (rev.2 — post-release code audit, same version)

- **Bug 65 (P1, `install.sh` + `update.sh`)**: `ProtectSystem=full` was used in both `write_caddy_service()` (install.sh) and `ensure_caddy_service()` (update.sh), but `ProtectSystem=full` makes `/etc` read-only **system-wide**, overriding `ReadWritePaths=/etc/caddy-naive` on some kernel versions. The correct pairing is `ProtectSystem=strict`. **Fix**: both service-writing functions changed to `ProtectSystem=strict`.

- **Bug 66 (P2, `update.sh`)**: `rebuild_caddyfile_direct()` created `/var/log/caddy-naive` (and the new `/var/lib/caddy`) without `chown caddy:caddy`, so `--repair` would recreate directories owned by root after a full reinstall. **Fix**: `mkdir -p … /var/lib/caddy` followed immediately by `chown caddy:caddy /var/log/caddy-naive /var/lib/caddy` (guarded by `id caddy &>/dev/null`).

- **Bug 67 (P1, `update.sh`)**: In the Node inline block of `rebuild_caddyfile_direct()`, the `.map()` that built naive user objects passed empty string through (`password: u.password || ''`), producing `basic_auth username ` (trailing space) which Caddy rejects. The `.filter(u => u.password.trim() !== '')` guard from Bug 44 was missing here. **Fix**: `.filter(u => u.password.trim() !== '')` added after `.map()`.

- **Bug 68 (P1, `update.sh`)**: In the same inline Caddyfile fallback array, the closing brace sequence for the `log {}` sub-block was wrong — `'    }'` / `'}'` / `'}'` instead of `'    }'` / `'  }'` / `'}'`. This left the global block syntactically unclosed, producing an invalid Caddyfile that failed `caddy validate`. **Fix**: corrected to `'    }'` (closes `output {}`), `'  }'` (closes `log {}`), `'}'` (closes global `{}`).

- **Bug 69 (P1, `update.sh`)**: `rebuild_mita_state_direct()` iterated `cfg.mieruPortStart … cfg.mieruPortEnd` without `parseInt` guards, same problem as Bug 51 in index.js. **Fix**: `parseInt(..., 10) || 2000/2010` applied before the loop.

- **Bug 70 (P1, `panel/server/index.js`)**: `/api/users/:id/config/mieru` and `/api/users/:id/config/universal` iterated `cfg.mieruPortStart … cfg.mieruPortEnd` in `for` loops without `parseInt` guards (same class as Bug 51 in `buildMitaStateFile`). On a config with string values or missing keys, both loops would silently produce empty `server_ports` arrays or loop forever. **Fix**: `parseInt(..., 10) || 2000/2010` guards added in both routes.

- **ARM error messages (`install.sh`)**: `detect_arch()` error strings for ARM64 and ARMv7 still referenced `v1.2.4`. **Fix**: updated to `v1.2.5`.

- **`uninstall.sh` version** bumped `v1.2.3 → v1.2.5`; also removes `/var/lib/caddy` (ACME cert storage added in Bug 43).

- **`update.sh` `ensure_caddy_service()`**: Also applies `RestartSec=10` (from Bug 62), `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `/var/lib/caddy` in `ReadWritePaths` so repaired services match the units written by `install.sh`.

---

## [v1.2.4] — 2026-05-07

### Fixed (release-blockers — regression from v1.2.3 on Ubuntu 24.04 amd64)

- **Bug 23 (P0, `panel/server/index.js` + `update.sh`)**: Caddyfile validation failed on every fresh install with:
  ```
  wrong argument count or unexpected line ending after 'basic_auth'
  ```
  Root cause 1: `buildCaddyfile()` in `index.js` emitted a standalone `basic_auth` token with no arguments as a *block opener* — this is invalid in `caddy-forwardproxy-naive`; the directive is not a block, it is a flat per-user line.
  Root cause 2: per-user credential lines used the wrong spelling `basicauth` (no underscore); the correct directive is `basic_auth <username> <password>`.
  **Fix**: `buildCaddyfile()` in `panel/server/index.js` now delegates to `panel/server/caddyTemplate.js` (single source of truth, Bug 26). The standalone bare `basic_auth` token is completely removed; each user produces exactly one `basic_auth <user> <pass>` line. The inline fallback (used before `install_panel()` has run) applies the same rules. Diagnostic counter regex in `/api/diagnostics` and `do_status` in `update.sh` updated from `basicauth` → `basic_auth`.

- **Bug 24 (P0, `install.sh`)**: `write_caddyfile()` called `log_warn` on `caddy validate` failure — install continued with an invalid Caddyfile, causing `caddy-naive` to fail silently later. **Fix**: validation failure now calls `die` (fatal), prints the full validator output, and aborts the install immediately.

- **Bug 25 (P0, `install.sh`)**: `start_services()` did not check whether `caddy-naive` became active after `systemctl restart`. **Fix**: added `systemctl is-active --quiet caddy-naive` check after a 2-second wait; on failure, dumps `journalctl -u caddy-naive -n 40` and calls `die`.

### Fixed (P1 — correctness)

- **Bug 26 (P1, `panel/server/index.js`)**: `buildCaddyfile()` and `rebuild_caddyfile_direct()` in `update.sh` each had an independent inline template that could drift from `install.sh`'s template. **Fix**: `panel/server/index.js` now `require()`s `panel/server/caddyTemplate.js` and calls `tpl.render(cfg, naiveUsers)`; `update.sh` already used the template. The inline fallback in each file mirrors the template exactly and is clearly marked as a fallback.

- **Bug 27 (P1, `install.sh`)**: `write_caddyfile()` silently overwrote any existing Caddyfile on `--force` reinstall, discarding DB users. **Fix**: existing Caddyfile is backed up to `${CADDY_FILE}.bak.YYYYMMDD-HHMMSS` before overwrite; DB users are read from SQLite (via Node) and imported into the new Caddyfile.

- **Bug 28 (P1, `panel/server/index.js` + `caddyTemplate.js`)**: site block contained a redundant `tls <email>` directive — Caddy's automatic HTTPS handles TLS entirely from the global `email` directive; the redundant line caused a warning. **Fix**: `tls` directive removed from site block in both `index.js` inline fallback and `caddyTemplate.js`.

- **Bug 29 (P1, `panel/server/index.js` + `caddyTemplate.js`)**: directive order inside `forward_proxy` was `basic_auth → (bare keyword) → hide_ip → hide_via → probe_resistance` — the wrong ordering can cause parse errors in strict Caddy versions. **Fix**: enforced order is `basic_auth <user> <pass>` lines → `hide_ip` → `hide_via` → `probe_resistance <secret>` (only when secret is set).

- **Bug 30 (P1, `panel/server/index.js` + `caddyTemplate.js`)**: `order forward_proxy before file_server` was missing from the global block in `index.js` inline template. **Fix**: added to both `caddyTemplate.js` and the `index.js` inline fallback.

- **Bug 33 (P1, `install.sh`)**: no DNS pre-flight check; installer could succeed while Caddy immediately failed ACME because the domain did not resolve to the server. **Fix**: `write_caddyfile()` now resolves `$DOMAIN` via `getent hosts` and compares against `api.ipify.org` server IP, logging a warning if they differ or if DNS has no record.

### Fixed (P2 — lower priority)

- **Bug 34 (P2, `panel/server/index.js` + `caddyTemplate.js`)**: placeholder credential line was emitted even when real users existed in some edge cases. **Fix**: placeholder is emitted only when `naiveUsers.length === 0`; as soon as the first real user is created the panel rebuilds the Caddyfile and the placeholder is replaced.

- **Bug 36 (P2, `install.sh`)**: UFW `--force reset` silently wiped all existing rules without warning. **Fix**: current UFW rules are backed up to `/etc/rixxx-panel/backups/ufw-before-install-*.rules` before reset; interactive mode prompts the user for confirmation before proceeding.

- **Bug 37 (P2, `install.sh`)**: `caddy-naive.service` ran as `root`. **Fix**: `write_caddy_service()` now sets `User=caddy Group=caddy` with `AmbientCapabilities=CAP_NET_BIND_SERVICE`; `start_services()` creates the `caddy` system user if absent and sets correct ownership/permissions on the binary, config dir, and log dir.

- **Bug 38 (P2, `panel/server/index.js` + `caddyTemplate.js`)**: log rotation used `roll_keep 5` (fixed file count). **Fix**: changed to `roll_keep_for 720h` (30-day age-based retention) in both `caddyTemplate.js` and the `index.js` inline fallback.

### Added

- **`panel/server/caddyTemplate.js`** (Bug 26): canonical Caddyfile renderer shared by `install.sh` (via `node -e "require('./caddyTemplate').render(cfg, [])"`) and `panel/server/index.js`. All template-level bugs (23, 28, 29, 30, 34, 38) are fixed in exactly one place. See module JSDoc for parameter spec.

- **`tests/e2e.sh`**: comprehensive end-to-end regression suite covering all v1.2.4 acceptance criteria:
  1. Non-interactive install → `caddy validate` → service health (Bugs 23–25).
  2. Caddyfile structure checks: no bare `basic_auth`, no `tls` in site block, `order` directive present, `roll_keep_for` present, single log block (Bugs 21, 23, 28–30, 38).
  3. Service state: `caddy-naive` active, runs as `caddy` user not root (Bug 37); `mita` enabled but inactive before first user (Bug 4).
  4. HTTP → 308 redirect; HTTPS → 200 with fake-site HTML (Bug 20).
  5. API login → create user → Caddyfile re-validate → `basic_auth <user> <pass>` line present → placeholder removed → mita starts (Bugs 23, 34).
  6. Naive config link uses `naive+https://`; Mieru sing-box config has `transport: TCP`, `server_ports` array.
  7. `update.sh --repair` → Caddyfile re-validate.
  8. Idempotent `--force` reinstall → Caddyfile valid.
  9. `uninstall.sh` → assert all files/services/UFW rules removed.
  10. Version consistency across all files (install.sh, update.sh, index.js, index.html, app.js, package.json, CHANGELOG.md).

  Run: `sudo bash tests/e2e.sh --domain vpn.example.com --email admin@example.com`

### Changed

- `panel/server/index.js` version comment → `v1.2.4`; `DEFAULT_CONFIG.version` → `1.2.4`.
- `panel/package.json` version → `1.2.4`.
- `panel/public/index.html` version labels → `v1.2.4`.
- `panel/public/app.js` version comment → `v1.2.4`.
- `install.sh` header → `v1.2.4`; `CURRENT_VERSION="1.2.4"`.
- `update.sh` header → `v1.2.4`; `TARGET_VERSION="1.2.4"`.

---

## [v1.2.3] — 2026-05-07

### Breaking Changes
- **Architecture**: `caddy-forwardproxy-naive` is **amd64 (x86_64) only**. ARM64 and ARMv7 are explicitly rejected by the installer with a clear error message.
- **NaiveProxy binary replaced**: standalone `naive` binary removed; replaced by `caddy-forwardproxy-naive` (Caddy with embedded forward-proxy module).
  - Binary path: `/usr/local/bin/caddy-naive`
  - Config: `/etc/caddy-naive/Caddyfile` (replaces `/etc/naive/config.json` + `/etc/naive/htpasswd`)
  - Systemd unit: `caddy-naive.service` (replaces `naive.service`)
  - TLS managed automatically by Caddy via TLS-ALPN-01 (no certbot, no port 80 needed)
- **htpasswd removed**: user authentication now lives directly in the Caddyfile as `basicauth` lines; rebuilt atomically after every user CRUD operation via `applyAllConfigs()`.
- **certbot / apache2-utils removed** from installer dependencies — Caddy handles its own TLS.
- **UFW**: port 80/tcp rule removed (Caddy TLS-ALPN-01 does not need HTTP-01); port 443 comment changed from `NaiveProxy HTTPS` → `CaddyNaive HTTPS`.

### Added
- **Fake site** (`/var/www/fake-site/index.html`): Caddy's `file_server` serves this page to unrecognised clients — provides a plausible "normal website" cover.
- **Probe resistance** (`probe_resistance <secret>`): clients must present the probe-secret token in the `Proxy-Authorization` header; unauthenticated scanners see the fake site instead of an error.
- **`--fake-site-url`** and **`--probe-secret`** CLI arguments added to `install.sh`.
- **`install_caddy_naive()`** function in `install.sh`: fetches latest `caddy-forwardproxy-naive.tar.xz` from `klzgrad/forwardproxy` GitHub releases; falls back to pinned `v2.10.0-naive` URL if GitHub API is unreachable; uses `setcap cap_net_bind_service` so caddy-naive can bind port 443 without running as root.
- **`write_caddyfile()`** in `install.sh`: generates Caddyfile with `forward_proxy { basic_auth … hide_ip hide_via probe_resistance <secret> }` + `file_server { root /var/www/fake-site }`.
- **`setup_fake_site()`** in `install.sh`: writes a minimal HTML landing page.
- **`buildCaddyfile(cfg, users)`** in `panel/server/index.js`: server-side Caddyfile builder called on every user change; writes atomically via `.new` + `rename`.
- **`writeCaddyfileAtomic()`**, **`reloadCaddy()`**, **`restartCaddy()`** in `panel/server/index.js`.
- **`applyAllConfigs()`** in `panel/server/index.js`: unified pipeline — build Caddyfile → reload Caddy → rebuild mita state → apply mita config.
- **`/api/services/rebuild-all`** POST endpoint (requires auth): rebuilds Caddyfile + mita-state from DB; used by `update.sh --repair`.
- **`/api/settings/probe-secret`** POST endpoint: updates `probeSecret` in config, rewrites `probe_secret` file, reloads Caddy.
- **`update_caddy_naive()`** in `update.sh`: replaces `update_naiveproxy()`; checks GitHub API for latest release; falls back to pinned v2.10.0 URL.
- **`rebuild_caddyfile_direct()`** and **`rebuild_mita_state_direct()`** in `update.sh` (`--repair`): Node.js one-liners that reconstruct configs from SQLite without needing the panel to be running.
- **`ensure_caddy_service()`** in `update.sh`: creates `caddy-naive.service` if missing, removes legacy `naive.service`.
- **Probe Secret setting card** in Settings page (`index.html` + `app.js`): masked input + "Apply Secret" button.
- **i18n keys** added to `en.json` and `ru.json`: `settings.probeSecretTitle/Desc/Label/Placeholder/Updated/TooShort/applyProbeSecret`.
- **Diagnostics page** (`app.js`): replaced `htpasswd users: N` counter with `Caddyfile users: N | probe_secret: ✓/✗` display.
- **Smoke tests** in `install.sh`: check `caddy-naive.service` active, Caddyfile present, fake-site `index.html` present, `probe_secret` file present.
- **`uninstall.sh` v1.2.3**: removes `caddy-naive.service`, `caddy-naive` binary, `/etc/caddy-naive/`, `/var/www/fake-site`, legacy `naive.service`/`/etc/naive/`, Certbot renewal hook; UFW rules updated for new comment strings.
- **`panel/package.json`** version bumped to `1.2.3`.

### Changed
- `install.sh` version → `1.2.3`; `update.sh` TARGET_VERSION → `1.2.3`; `panel/server/index.js` → `v1.2.3`; `panel/public/app.js` → `v1.2.3`; `panel/public/index.html` title/sidebar → `v1.2.3`.
- `config.json` now stores `caddyBin`, `caddyFile`, `caddyConfigDir`, `fakeSiteDir`, `fakeSiteUrl`, `probeSecret` fields.
- `/api/status` still returns `services.naive` key (front-end compat) but now reflects `caddy-naive.service` state and caddy binary version.
- `/api/logs/naive` and `/api/logs/caddy` now tail `journalctl -u caddy-naive` (back-compat aliases preserved).
- `/api/service/naive/…` maps to `caddy-naive` via `svcMap` (back-compat).
- `update.sh --status`: shows `caddy-naive` version, Caddyfile user count, fake-site presence, probe-resistance config.
- `update.sh --repair`: calls `/api/services/rebuild-all` first; falls back to direct Node.js DB rebuild.
- Final install banner shows `Probe secret` and `Fake site` values.

### Removed
- `install_naiveproxy()` function (replaced by `install_caddy_naive()`).
- `update_naiveproxy()` function in `update.sh` (replaced by `update_caddy_naive()`).
- `rebuild_htpasswd_from_db()`, `rebuild_naive_config()` functions in `update.sh`.
- `ensure_naive_service()` function (replaced by `ensure_caddy_service()`).
- `certbot`, `apache2-utils` from installer dependencies.
- `naive.service` systemd unit (replaced by `caddy-naive.service`).
- `/usr/local/bin/naive` binary (replaced by `/usr/local/bin/caddy-naive`).
- `/etc/naive/config.json` and `/etc/naive/htpasswd` (replaced by `/etc/caddy-naive/Caddyfile`).
- Certbot renewal hook `/etc/letsencrypt/renewal-hooks/deploy/restart-naive.sh` (no longer needed; Caddy auto-renews).
- Duplicate site-level `log { }` block from Caddyfile template (Bug 21 — kept global block only).

### Fixed (post-release patches)
- **Bug 18 (P0, install.sh + panel/server/index.js)**: Caddyfile generated with an empty `basic_auth` block when no users exist in the DB yet — Caddy rejects this and the install aborts. Fixed in both places:
  - `write_caddyfile()` (`install.sh`): generates a random `_placeholder_install` sentinel `basicauth` line before the heredoc; uses real DB users if any exist. Calls `caddy validate` after writing and logs warnings if validation fails.
  - `buildCaddyfile()` (`panel/server/index.js`): when `naiveUsers` array is empty emits a `_placeholder_<random-hex>` basicauth line using `crypto.randomBytes`; real users replace it on next rebuild.
- **Bug 19 (P0, install.sh)**: No rollback guidance on failure — installer silently exited, leaving system in partial state. Added `on_error()` function and `trap 'on_error $? $LINENO' ERR` immediately after the install-log redirect. The handler prints: exit code, line number, log path, and three recovery options (`--force` re-run, clean `uninstall.sh`, `tail -30` log).
- **Bug 20 (P1, install.sh)**: UFW did not open port 80, breaking ACME HTTP-01 TLS challenge (Caddy uses HTTP-01 as fallback when TLS-ALPN-01 is unavailable, and also needs port 80 for the HTTP→HTTPS redirect). Added `ufw allow 80/tcp comment "ACME HTTP-01 + redir HTTPS"` in `setup_ufw()`.
- **Bug 21 (P1, install.sh + panel/server/index.js)**: Caddyfile contained both a global `log { }` block and a duplicate site-level `log { output file … }` block writing to the same file — Caddy warns and only one block takes effect. Removed the site-level block; global block covers all requests.
- **Bug 22 (P1, install.sh)**: `caddy-naive.service` unit file was written *inside* `start_services()`, after `systemctl daemon-reload` had already been called — so the new unit was never picked up by systemd on the first run. Moved `write_caddy_service()` call to `main()` (between `write_caddyfile()` and `write_config_json()`); `start_services()` now runs `daemon-reload` with the unit already on disk.

---

## [v1.2.2] — 2026-05-07

### Fixed
- **Bug 1 (P0, frontend)**: Confirmed no inline handlers remain in `index.html`; CSP in `server/index.js` already has `'unsafe-inline'` in `scriptSrc` so dynamically rendered buttons work. Log tab renamed from "Caddy" → "Naive"; `logs.naive` key added to both locale files.
- **Bug 2 (P0, install.sh)**: `certbot certonly` does **not** accept `--cert-path` / `--key-path` flags — they are invalid and cause a non-zero exit even on success. Removed those flags; certs now land in the standard LE path `/etc/letsencrypt/live/<domain>/` which is read directly.
- **Bug 3 (P1, install.sh + index.js)**: UFW rejects `N:N/proto` range syntax when start port equals end port (e.g. `--mieru-start 2015 --mieru-end 2015`), crashing the installer. Added `_ufw_mieru_rule()` helper in `install.sh` that emits a single-port rule (`N/proto`) when start==end, or a range rule otherwise. Same fix applied in `panel/server/index.js` (`ufwMieruRule()` helper used in `/api/settings/mieru-ports` and `/api/settings/udp-toggle`).
- **Bug 4 (P1, install.sh)**: `mita` crashes on start when `users[]` is empty (fresh install has no users). `start_services()` now applies the config (so mita knows the port range) but only actually starts the `mita.service` when at least one user is present in `mita-state.json`. The panel's `rebuildServices()` starts mita automatically after the first user is created.
- **Bug 5 (P2, install.sh)**: TLS cert/key paths now point directly to `/etc/letsencrypt/live/<domain>/fullchain.pem` and `privkey.pem`. Added `chmod o+x` on `/etc/letsencrypt`, `live/`, and `archive/<domain>/` so the naive process (running as root) can traverse the symlink chain. Added `chmod o+r` on `*.pem` files. Renewal hook re-applies these permissions after every `certbot renew`.
- **i18n**: Added `logs.naive`, `diagnostics.naiveValid`, `diagnostics.naiveInvalid`, `login.sessionExpired` keys to `en.json` and `ru.json`.

---

## [v1.2.1] — 2026-05-07

### Fixed
- **Critical #1**: `detect_arch()` x86_64 mapping corrected — `NAIVE_ARCH` now set to `linux-x64` (was `linux-amd64`) in both `install.sh` and `update.sh`, matching the actual NaiveProxy release asset suffix
- **Minor #6**: jq asset-selection loop now tries fallback aliases `linux-amd64` → `linux-x86_64` after primary `linux-x64` for x86_64 hosts, protecting against future upstream asset-name changes (both scripts)
- **Blocker #3**: `do_status` in `update.sh` no longer fails when `naive --version` returns empty — wrapped with `|| echo 'installed'` fallback
- **Minor #7**: `naive --version` smoke-test wrapped with `timeout 5` in both `install.sh` and `update.sh` to avoid hanging if the binary stalls at startup
- **Minor #4**: Admin password generation replaced `tr -dc` (may produce shell-special chars) with `openssl rand -base64 18 | tr -d '/+='` — 20-char alphanumeric output, no shell quoting issues
- **Blocker #2**: Confirmed `rebuild_mita_state()` reads the `password` column (plaintext) — not `passHash` (bcrypt) — when constructing the JSON passed to `mita apply config`; no regression
- **Minor #5**: README.md / README.en.md — ARM64 and ARMv7 architectures marked *experimental, not tested in production*

---

## [v1.2.0] — 2026-05-07

### Breaking Changes
- **NaiveProxy binary** changed from `caddy-naive` to standalone `naive` binary
  - Binary path: `/usr/local/bin/naive` (was `/usr/local/bin/caddy-naive`)
  - Config: `/etc/naive/config.json` + `/etc/naive/htpasswd` (was Caddyfile)
  - Systemd unit: `naive.service` (was `caddy-naive.service`)
  - Run `bash update.sh --repair` to migrate an existing v1.1.x install

### Added
- **Blocker 1**: Strict architecture asset matching — `endswith("-" + arch + ".tar.xz")` with no Linux fallback
- **Blocker 2**: `NAIVE_BIN=/usr/local/bin/naive`, `NAIVE_CONFIG_DIR=/etc/naive`; searches for `naive`/`naiveproxy` binary in archive
- **Blocker 3**: `/etc/naive/config.json` with `listen`, `name`, `auth` (htpasswd path), `padding`, `log`
- **Blocker 4**: `naive.service` systemd unit; old `caddy-naive.service` removed on install/repair
- **Blocker 5**: Smoke tests — `naive --version`, `systemctl is-active naive`, port-listen check
- **Blocker 6**: `update.sh --repair` rebuilds htpasswd + naive config + mita-state from SQLite; `--status` shows naive version, config, htpasswd user count
- **Blocker 7**: `buildHtpasswd(users)` + `buildNaiveConfig()` in `server/index.js`; all user CRUD rebuilds htpasswd + reloads naive
- **Blocker 8**: Post-start Mieru port-listen check in smoke tests and `/api/diagnostics`
- **Blocker 9**: Installer output captured to `/var/log/rixxx-panel-install.log`
- **Blocker 10**: `--non-interactive`/`--force` flags; `--domain`, `--email`, `--admin-pass` etc. CLI args
- **Blocker 11**: Version file at `/etc/rixxx-panel/version` with key=value format (`panel_version`, `naive_version`, `mieru_version`, `installed_at`)
- **Blocker 12**: Generic listen `"https://:PORT"` in naive config; `"name": "${DOMAIN}"` for logging
- **Blocker 13**: Certbot step in `install.sh`; `cert`/`key` paths in config.json; renewal hook
- **Blocker 14**: `fmtLastSeen(iso)` in `app.js` — shows "X min ago / Xh ago / Xd ago" in tables
- **Blocker 15**: GitHub Actions CI matrix in `.github/workflows/ci.yml` — Ubuntu 24.04, 22.04, Debian 12
- `apache2-utils` and `certbot` added to `install_deps()`
- UFW opens port 80/tcp for Certbot HTTP-01 challenges
- `uninstall.sh` removes naive paths, legacy caddy-naive artifacts, Certbot hook

### Changed
- `install.sh` version bumped to `1.2.0`
- `update.sh` TARGET_VERSION bumped to `1.2.0`
- `panel/package.json` version bumped to `1.2.0`
- `panel/server/index.js` bumped to `v1.2.0`
- `panel/public/app.js` bumped to `v1.2.0`
- `/api/logs/caddy` aliased to `naive` logs for back-compat
- `/api/service/caddy-naive/…` aliased to `naive` for back-compat

### Fixed
- `update.sh --status` shows naive binary version
- `update.sh --repair` rebuilds from live DB without requiring a backup
- `uninstall.sh` cleans all v1.2.0 paths and legacy caddy-naive artifacts

---

## [v1.1.0] — 2026-05-06

### Added
- **Bilingual UI** — Russian (default) and English, language selector in header, stored in `localStorage`
- **Locale files** `panel/public/locales/ru.json` and `panel/public/locales/en.json`
- **Dark / Light theme toggle** — dark mode default, sun/moon switch persisted in `localStorage`
- **Redesigned CSS palette** — dark gradient `#1a1a1d → #2c2c30`, bronze accent `#c08552`, glassmorphism cards
- **QR-code generation** for Naive links (iOS/Android import via QR)
- **Karing client** added to recommended client lists (iOS / Android / Windows / macOS / Linux)
- **README.ru.md** — primary Russian documentation with architecture diagram, troubleshooting, client tables
- **README.en.md** — English documentation
- Language-switch links at top of both READMEs
- **CHANGELOG.md** — this file
- **LICENSE** — MIT license
- Corrected `/etc/mita/` documentation: internal protobuf store, not edited manually
- `mita-state.json` correctly documented at `/var/lib/rixxx-panel/mita-state.json`
- Troubleshooting section (top-5 fixes) in both READMEs
- Uninstall documentation with `--keep-configs` flag
- Donation / Telegram links prominently placed in READMEs

### Fixed
- Removed incorrect `/etc/mita/server.json` and `/etc/mita/users.json` references from docs
- `buildMitaStateFile()` now correctly uses `/var/lib/rixxx-panel/mita-state.json`
- `reloadMieru()` / `restartMieru()` verified to use correct state file path

### Changed
- `README.md` is now the primary Russian README (language switch link at top)
- CSS accent color changed from blue `#6c8ef5` to bronze `#c08552` per product identity

---

## [v1.0.0] — 2026-05-05

### Added
- **Sprint 1 — Installer** (`install.sh`)
  - Automatic OS detection (Ubuntu 20.04/22.04/24.04, Debian 11/12)
  - Architecture detection (x86_64, aarch64, armv7l)
  - NaiveProxy binary download from GitHub releases API
  - Mieru `.deb` install from enfein/mieru GitHub releases
  - NTP sync enforcement via `timedatectl`
  - Bilingual prompts (Russian default, English option)
  - Interactive setup wizard: domain, TLS email, Naive port (443), Mieru port range (2012-2022)
  - Optional UFW setup
  - Config stored at `/etc/rixxx-panel/config.json`
  - `mita-state.json` built and applied via `mita apply config`
  - Smoke tests (caddy-naive, mita, panel HTTP, time sync)
  - Idempotent reinstall support with backup

- **Sprint 2 — User CRUD**
  - SQLite model: id, email, username, password-hash, plain password (for mita), expiry, protocols, quota, timestamps
  - On create/update: rebuild Caddyfile + reload caddy-naive, rebuild Mieru JSON + `mita apply config` + `mita reload`
  - Expiry cron every 5 minutes
  - UI table with Edit / Config / Delete actions

- **Sprint 3 — Server Settings**
  - NaiveProxy port change: Caddy reload only (no restart)
  - Mieru port range change: UFW update + full `mita stop && mita start`
  - Traffic pattern presets: NOOP, RANDOM_PADDING, RANDOM_PADDING_AGGRESSIVE
  - MTU setting (1280–1400)
  - UI warning after port changes

- **Sprint 4 — Client Configs**
  - Naive link: `naive+https://username:password@domain:443`
  - Mieru sing-box JSON template
  - Universal config: NaiveProxy + Mieru + `urltest` auto-fallback selector
  - Download buttons in UI

- **Sprint 5 — Monitoring Dashboard**
  - Per-user traffic snapshots every 60 s
  - Live WebSocket metrics every 5 s (CPU, RAM, service status)
  - System metrics: CPU, RAM, Disk, uptime, OS, arch, service versions
  - Quota alerts (>80% warn, >95% danger)
  - `mita describe users` parser (handles version differences)

- **Sprint 6 — update.sh**
  - Flags: `--dry-run`, `--force`, `--expose <domain>`, `--ssh-only`, `--status`, `--repair`, `--help`
  - Backups in `/etc/rixxx-panel/backups/YYYY-MM-DD-HHMMSS/` (keeps last 10)
  - Version file at `/etc/rixxx-panel/version`
  - GitHub API version comparison for NaiveProxy and Mieru
  - Health-check commands after install/update
  - `--repair` rebuilds JSON from SQLite

- **uninstall.sh** — full cleanup with `shred`, `--keep-configs` flag
- **panel/server/index.js** — Express backend, REST API, WebSocket, SQLite, cron jobs
- **panel/public/** — SPA HTML + CSS + JS (login, dashboard, users, settings, monitoring, logs, diagnostics)
- **panel/package.json** — Node.js dependencies (Express, better-sqlite3, bcryptjs, ws, node-cron, systeminformation, etc.)
- **panel/scripts/** — standalone `install_naiveproxy.sh`, `install_mieru.sh`, `sysctl_tune.sh`

---

[v1.1.0]: https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/compare/v1.0.0...v1.1.0
[v1.0.0]: https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/releases/tag/v1.0.0
