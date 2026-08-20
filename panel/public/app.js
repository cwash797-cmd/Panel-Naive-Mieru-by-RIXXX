/**
 * Panel Naive + Mieru — Frontend Application v1.5.0
 * Bug 1 fix: ALL inline event handlers removed; wired via delegated addEventListener
 * Bug 10 fix: 401 auto-redirect to login; toast on every API error
 * v1.2.5: probe-secret setting, disabled-button+spinner on all submit handlers,
 *         dashboard shows caddy-naive version label, config version bump
 * v1.2.6: cascade/relay settings (Naive upstream + Mieru egress SOCKS5)
 */
'use strict';

// ══════════════════════════════════════════════════════════════
// BASE PATH (v1.4.0, BUG-140)
// ══════════════════════════════════════════════════════════════
// When external access is enabled the panel is served behind a secret
// webBasePath:  https://panel.<domain>/<webBasePath>/ . Caddy's
// `handle_path /<webBasePath>/*` STRIPS the prefix before reverse-proxying,
// so the Express app itself is unaware of the prefix — but the BROWSER is.
// Therefore every request the browser makes ( /api/*, /locales/* ) MUST carry
// the prefix back, otherwise Caddy can't match it and serves the stub → 404.
//
// We derive the prefix from THIS script's own URL. `app.js` is loaded with a
// relative <script src="app.js">, so its resolved URL is
//   https://panel.<domain>/<webBasePath>/app.js
// and the directory part ("/<webBasePath>/") is exactly the base we need.
// This is robust for deep links and page refreshes (location.pathname can be
// any sub-route, but the script URL is always the panel root).
const BASE_PATH = (function () {
  try {
    const self = (document.currentScript && document.currentScript.src) || '';
    if (self) {
      const p = new URL(self).pathname;          // /<webBasePath>/app.js  (or /app.js)
      const dir = p.replace(/[^/]*$/, '');        // /<webBasePath>/        (or /)
      return dir.replace(/\/+$/, '');             // /<webBasePath>         (or '')
    }
  } catch (_) {}
  return '';
})();

// Prefix an absolute server path ("/api/...", "/locales/...") with BASE_PATH.
// Leaves already-absolute http(s) URLs and non-rooted paths untouched.
function apiUrl(p) {
  if (typeof p !== 'string') return p;
  if (/^https?:\/\//i.test(p)) return p;
  if (p[0] !== '/') return p;
  return BASE_PATH + p;
}

// ══════════════════════════════════════════════════════════════
// I18N SYSTEM
// ══════════════════════════════════════════════════════════════

const SUPPORTED_LANGS = ['ru', 'en'];
let locale = {};

async function loadLocale(lang) {
  try {
    const res = await fetch(apiUrl(`/locales/${lang}.json`));
    if (!res.ok) throw new Error('locale not found');
    locale = await res.json();
  } catch {
    locale = {};
  }
}

function t(key, vars) {
  const parts = key.split('.');
  let val = locale;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return key;
  }
  if (typeof val !== 'string') return key;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      val = val.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
  }
  return val;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== key) el.textContent = translated;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    const translated = t(key);
    if (translated !== key) el.placeholder = translated;
  });
  document.documentElement.lang = currentLang;
  const label = currentLang.toUpperCase();
  ['login-lang-btn', 'topbar-lang-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = label;
  });
}

// ══════════════════════════════════════════════════════════════
// THEME SYSTEM
// ══════════════════════════════════════════════════════════════

const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;
const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="12" cy="12" r="5"/>
  <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
  <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
</svg>`;

let currentTheme = 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  const iconHtml = isDark ? SUN_SVG : MOON_SVG;
  ['login-theme-btn', 'topbar-theme-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.innerHTML = iconHtml;
  });
  localStorage.setItem('rixxx-theme', theme);
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// ══════════════════════════════════════════════════════════════
// LANGUAGE SWITCHING
// ══════════════════════════════════════════════════════════════

let currentLang = 'ru';

async function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'ru';
  currentLang = lang;
  await loadLocale(lang);
  applyI18n();
  if (state.authenticated) {
    const titles = buildTitles();
    const titleEl = document.getElementById('topbar-title');
    if (titleEl) titleEl.textContent = titles[state.currentPage] || state.currentPage;
    navigateTo(state.currentPage);
  }
  localStorage.setItem('rixxx-lang', lang);
}

async function cycleLang() {
  const idx = SUPPORTED_LANGS.indexOf(currentLang);
  const next = SUPPORTED_LANGS[(idx + 1) % SUPPORTED_LANGS.length];
  await setLang(next);
}

function buildTitles() {
  return {
    dashboard:   t('nav.dashboard'),
    users:       t('nav.users'),
    settings:    t('nav.settings'),
    federation:  t('nav.federation'),
    monitoring:  t('nav.monitoring'),
    logs:        t('nav.logs'),
    diagnostics: t('nav.diagnostics'),
  };
}

// ══════════════════════════════════════════════════════════════
// APP STATE
// ══════════════════════════════════════════════════════════════

const state = {
  authenticated: false,
  username: '',
  config: {},
  users: [],
  currentPage: 'dashboard',
  ws: null,
  wsReconnectTimer: null,
  selectedUserId: null,
};

let currentLogService = 'caddy';

// ══════════════════════════════════════════════════════════════
// INIT — wire ALL event listeners here (Bug 1: no inline handlers)
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Restore persisted preferences FIRST
  const savedTheme = localStorage.getItem('rixxx-theme') || 'dark';
  const savedLang  = localStorage.getItem('rixxx-lang')  || 'ru';

  applyTheme(savedTheme);
  await setLang(savedLang);

  // ── Delegated click handler (Bug 1) ──────────────────────────
  document.addEventListener('click', handleDelegatedClick);

  // ── Log-lines select change (Bug 1: was onchange inline) ─────
  document.getElementById('log-lines')?.addEventListener('change', () => {
    loadLogs(currentLogService);
  });

  // ── v1.6.0: hidden backup file input → import handler ─────────
  document.getElementById('backup-file-input')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) backupImportFile(f);
  });

  // ── Login form ────────────────────────────────────────────────
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // ── Sidebar navigation ────────────────────────────────────────
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.page);
    });
  });

  // ── Check existing session ────────────────────────────────────
  fetch(apiUrl('/api/me'))
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.authenticated) {
        state.authenticated = true;
        state.username = data.username;
        enterApp();
      }
    })
    .catch(() => {});
});

/**
 * Central delegated click dispatcher — handles ALL data-action buttons
 * This replaces every inline onclick="..." in the HTML (Bug 1 fix)
 */
function handleDelegatedClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  // Доработка 2: the delegated handler bypasses the native `disabled` attribute,
  // so honour it explicitly — a greyed-out (foolproof-gated) button must NOT act.
  if (btn.disabled || btn.classList.contains('is-disabled')) { e.preventDefault(); return; }
  const action = btn.dataset.action;

  switch (action) {
    // ── Global controls
    case 'toggle-pw':        togglePw(btn.dataset.target); break;
    case 'cycle-lang':       cycleLang(); break;
    case 'toggle-theme':     toggleTheme(); break;

    // ── Auth
    case 'logout':           logout(); break;

    // ── Sidebar toggle (mobile)
    case 'toggle-sidebar':   toggleSidebar(); break;

    // ── Users page
    case 'open-add-user':    openAddUser(); break;
    case 'close-user-modal': closeUserModal(); break;
    case 'save-user':        saveUser(); break;
    case 'gen-password':     generatePassword(); break;
    case 'copy-password':    copyPasswordField(); break;
    case 'edit-user':        openEditUser(btn.dataset.id); break;
    case 'delete-user':      deleteUser(btn.dataset.id, btn.dataset.username); break;
    case 'open-config':      openConfigDownload(btn.dataset.id); break;
    case 'deploy-user':      deployUser(btn.dataset.id, btn.dataset.username); break;
    case 'close-config-modal': closeConfigModal(); break;
    case 'dl-naive-link':    downloadNaiveLink(); break;
    case 'dl-mieru-link':    downloadMieruLink(); break;
    case 'dl-hy2-link':      downloadHy2Link(); break;
    case 'dl-mieru-config':  downloadMieruConfig(); break;
    case 'dl-universal-config': downloadUniversalConfig(); break;
    case 'dl-sub-link':      downloadSubLink(); break;

    // ── v1.9.0: personal bonus links
    case 'add-bonus-link':    addBonusLink(); break;
    case 'save-bonus-links':  saveBonusLinks(); break;
    case 'del-bonus-link':    removeBonusLink(parseInt(btn.dataset.idx, 10)); break;
    case 'toggle-bonus-link': toggleBonusLink(parseInt(btn.dataset.idx, 10)); break;

    // ── Dashboard service buttons
    case 'svc':              svcAction(btn.dataset.svc, btn.dataset.svcAction); break;

    // ── Settings page
    case 'change-naive-port':    changeNaivePort(); break;
    case 'change-mieru-ports':   changeMieruPorts(); break;
    case 'save-sub-base-url':    saveSubBaseUrl(); break;
    case 'save-fake-site-url':   saveFakeSiteUrl(); break;
    case 'save-server-flag':     saveServerFlag(); break;

    // ── Federation page
    case 'gen-federation-token':  genFederationToken(); break;
    case 'copy-federation-token': copyFederationToken(); break;
    case 'save-federation-token': saveFederationToken(); break;
    case 'add-federation-node':   addFederationNode(); break;
    case 'test-federation-nodes': testFederationNodes(); break;
    case 'toggle-federation-node': toggleFederationNode(btn.dataset.nodeId); break;
    case 'remove-federation-node': removeFederationNode(btn.dataset.nodeId); break;

    case 'install-hy2':          installHy2(false); break;
    case 'reinstall-hy2':        installHy2(true); break;
    case 'change-hy2-port':      changeHy2Port(); break;
    case 'change-traffic-pattern': changeTrafficPattern(); break;
    case 'change-udp-mode':      changeUdpMode(); break;
    case 'change-language':      changeLanguage(); break;
    case 'change-password':      changePassword(); break;
    case 'change-probe-secret':  changeProbeSecret(); break;
    case 'apply-probe-mode':     applyProbeMode(); break;
    case 'change-cascade':       changeCascade(); break;
    case 'cascade-status':       checkCascadeStatus(); break;
    case 'reset-cascade':        resetCascade(); break;
    case 'apply-warp':           applyWarp(); break;
    case 'warp-status':          checkWarpStatus(); break;
    case 'reset-warp':           resetWarp(); break;
    // ── v1.4.0: external panel access
    case 'gen-web-base-path':    generateWebBasePath(); break;
    case 'save-external-access': saveExternalAccess(); break;
    case 'toggle-external-fields': toggleExternalFields(); break;
    case 'load-panel-stub':      loadPanelStub(); break;
    case 'save-panel-stub':      savePanelStub(); break;
    // ── v1.6.0: backup / restore
    case 'backup-export':        backupExport(); break;
    case 'backup-import-pick':   el('backup-file-input').click(); break;

    // ── Monitoring
    case 'refresh-stats':    refreshStats(); break;

    // ── Logs
    case 'load-logs':        loadLogs(btn.dataset.logSvc); break;
    case 'refresh-logs':     loadLogs(currentLogService); break;

    // ── Diagnostics
    case 'run-diagnostics':  runDiagnostics(); break;

    // ── Login / topbar lang + theme (also wired via data-action on the buttons)
    case 'lang':             cycleLang(); break;
    case 'theme':            toggleTheme(); break;
  }
}

// Wire lang + theme buttons via data-action (added as fallback; buttons already
// have data-action so the delegated handler above covers them too)
document.addEventListener('DOMContentLoaded', () => {
  ['login-lang-btn', 'topbar-lang-btn'].forEach(id => {
    document.getElementById(id)?.setAttribute('data-action', 'cycle-lang');
  });
  ['login-theme-btn', 'topbar-theme-btn'].forEach(id => {
    document.getElementById(id)?.setAttribute('data-action', 'toggle-theme');
  });
  document.getElementById('btn-logout')    ?.setAttribute('data-action', 'logout');
  document.getElementById('menu-toggle')   ?.setAttribute('data-action', 'toggle-sidebar');
});

// ══════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;

  btn.disabled = true;
  btn.innerHTML = `<span>${t('login.signingIn') || '…'}</span>`;
  err.classList.add('hidden');

  try {
    const res = await api('POST', '/api/login', { username, password });
    state.authenticated = true;
    state.username = res.username;
    enterApp();
  } catch (ex) {
    err.textContent = ex.message || t('login.invalidCreds');
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>${t('login.signIn')}</span>`;
  }
}

function enterApp() {
  document.getElementById('page-login').classList.remove('active');
  document.getElementById('app').classList.remove('hidden');

  const uname = state.username || 'admin';
  document.getElementById('sidebar-uname').textContent = uname;
  document.getElementById('sidebar-avatar').textContent = uname[0].toUpperCase();

  // Bug A (v1.3.2): pull the real version once on login and write it to all
  // three displays (sidebar / topbar / settings), so it's correct even if the
  // user never opens the dashboard tab.
  syncVersionDisplay();

  loadConfig().then(() => {
    navigateTo('dashboard');
    connectWebSocket();
  });
}

// Bug A (v1.3.2): single helper that fetches the panel version and updates all
// three places where it is shown (sidebar label, topbar badge, settings about).
// Falls back silently on error (keeps the hardcoded default in index.html).
async function syncVersionDisplay() {
  try {
    const status = await api('GET', '/api/status');
    const verStr = `v${status?.panel?.version || '1.2.4'}`;
    ['about-version', 'sidebar-version', 'topbar-version'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = verStr;
    });
  } catch (_) { /* keep hardcoded fallback shown in index.html */ }
}

async function logout() {
  await fetch(apiUrl('/api/logout'), { method: 'POST' }).catch(() => {});
  state.authenticated = false;
  if (state.ws) state.ws.close();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('page-login').classList.add('active');
  document.getElementById('login-pass').value = '';
}

// ══════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════

function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.querySelectorAll('.content-page').forEach(el => {
    el.classList.toggle('active', el.id === `page-${page}`);
  });

  const titles = buildTitles();
  document.getElementById('topbar-title').textContent = titles[page] || page;

  switch (page) {
    case 'dashboard':   loadDashboard();   break;
    case 'users':       loadUsers();       break;
    case 'settings':    loadSettings();    break;
    case 'federation':  loadFederation();  break;
    case 'monitoring':  loadMonitoring();  break;
    case 'logs':        loadLogs(currentLogService); break;
    case 'diagnostics': runDiagnostics();  break;
  }

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('open');
  let overlay = document.getElementById('sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle('active', sidebar.classList.contains('open'));
}

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════

async function loadConfig() {
  try {
    state.config = await api('GET', '/api/config');
    // Bug A (v1.3.2): update all three version displays, not just the topbar.
    {
      const verStr = `v${state.config.version || '1.2.4'}`;
      ['about-version', 'sidebar-version', 'topbar-version'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = verStr;
      });
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const status = await api('GET', '/api/status');
    state.config = { ...state.config, domain: status.domain, serverIp: status.serverIp };

    el('d-naive-status').innerHTML = badge(status.services.naive.active,
      t('dashboard.active'), t('dashboard.inactive'));
    el('d-mieru-status').innerHTML = badge(status.services.mieru.active,
      t('dashboard.active'), t('dashboard.inactive'));
    // Hy2 card: only show when installed; reflect active/inactive.
    const hy2 = status.services.hy2 || {};
    state.hy2Installed = !!hy2.installed;
    const hy2Card = el('d-hy2-card');
    if (hy2Card) {
      if (hy2.installed) {
        hy2Card.classList.remove('hidden');
        el('d-hy2-status').innerHTML = badge(hy2.active,
          t('dashboard.active'), t('dashboard.inactive'));
      } else {
        hy2Card.classList.add('hidden');
      }
    }
    el('d-user-count').textContent = status.panel.userCount;
    el('d-domain').textContent     = status.domain || '—';

    const cpu = status.system.cpuPercent || 0;
    el('d-cpu').textContent = `${cpu}%`;
    setProgress('d-cpu-bar', cpu);

    const ramPct = status.system.ramTotalMB
      ? Math.round((status.system.ramUsedMB / status.system.ramTotalMB) * 100) : 0;
    el('d-ram').textContent = `${fmtMB(status.system.ramUsedMB)} / ${fmtMB(status.system.ramTotalMB)}`;
    setProgress('d-ram-bar', ramPct);

    const diskPct = status.system.diskTotalGB
      ? Math.round((status.system.diskUsedGB / status.system.diskTotalGB) * 100) : 0;
    el('d-disk').textContent = `${status.system.diskUsedGB} GB / ${status.system.diskTotalGB} GB`;
    setProgress('d-disk-bar', diskPct);

    el('d-sysinfo').innerHTML = infoList([
      [t('dashboard.domain'),       status.domain],
      [t('dashboard.serverIp'),     status.serverIp],
      [t('dashboard.os'),           status.system.os],
      [t('dashboard.architecture'), status.system.arch],
      [t('dashboard.uptime'),       fmtUptime(status.system.uptime)],
      [t('dashboard.naivePort'),    state.config.naivePort],
      [t('dashboard.mieruPorts'),   `${state.config.mieruPortStart}–${state.config.mieruPortEnd}`],
      [t('dashboard.naiveVersion'), status.services.naive.version || '—'],
      [t('dashboard.mieruVersion'), status.services.mieru.version || '—'],
    ]);

    // Bug A (v1.3.2): keep all three version displays in sync from the dashboard.
    {
      const verStr = `v${status.panel.version || '1.2.4'}`;
      ['about-version', 'sidebar-version', 'topbar-version'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = verStr;
      });
    }
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

// ══════════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════════

async function loadUsers(opts = {}) {
  // v1.9.7: opts.retry (>0) enables a SILENT, retrying GET — used by saveUser()
  // to survive the brief window where Caddy is reloading in the background after
  // a user CRUD (BUG-176). Without a retry we render the loading row up-front;
  // with one (a background refresh) we keep whatever is already on screen so the
  // table doesn't flash an empty "loading…" state during the retry window.
  const tbody = el('users-tbody');
  const apiOpts = { retry: opts.retry, silent: !!opts.retry };
  if (!opts.retry) {
    tbody.innerHTML = `<tr><td colspan="12" class="table-empty">${t('users.loading')}</td></tr>`;
  }
  try {
    // BUG-163/165: the Users table showed 0 in «Naive (МБ)»/«Mieru (МБ)» because
    //   /api/users carries NO traffic fields — the per-key figures live in
    //   /api/stats/users. Fetch both and merge the per-key numbers in.
    const [users, stats] = await Promise.all([
      api('GET', '/api/users', null, apiOpts),
      api('GET', '/api/stats/users', null, apiOpts).catch(() => ({ users: [] })),
    ]);
    // Support both the new {users,…} object and a legacy bare array.
    const statRows = Array.isArray(stats) ? stats : (stats.users || []);
    const byName = {};
    statRows.forEach(s => { byName[s.username] = s; });
    state.users = users.map(u => {
      const s = byName[u.username] || {};
      return Object.assign({}, u, {
        naiveMB: s.naiveMB != null ? s.naiveMB : 0,
        mieruMB: s.mieruMB != null ? s.mieruMB : 0,
        hy2MB:   s.hy2MB   != null ? s.hy2MB   : 0,
      });
    });
    removeNaiveServerBanner();   // BUG-165: drop any stale server-wide banner
    renderUsersTable(state.users);
    // Доработка 2: re-evaluate the foolproof gates whenever the key list changes.
    applyFoolproofGates(state.users.length);
  } catch (err) {
    // v1.9.7: a background refresh (opts.retry) is triggered right after a
    // successful save. If it still fails after all retries, DON'T paint a red
    // error over the (already-saved) table — re-throw so saveUser() can show a
    // gentle "refresh shortly" hint instead of a false "save failed".
    if (opts.retry) throw err;
    tbody.innerHTML = `<tr><td colspan="12" class="table-empty" style="color:var(--red)">${esc(err.message)}</td></tr>`;
  }
}

// BUG-165: the «Naive (сервер, суммарно)» banner was removed. In v1.5.2+ Naive
//   traffic is shown PER KEY in the Users table, so the server-wide banner was
//   both incorrect and confusing. We also remove any banner left in the DOM by a
//   previously-loaded (cached) build.
function removeNaiveServerBanner() {
  const host = el('naive-server-total');
  if (host && host.parentNode) host.parentNode.removeChild(host);
}

// Доработка 2 (защита от дурака): most service crashes happen because operators
// enable the cascade or restart mita BEFORE the first key exists (mita then
// FATALs "no user found"). While there are 0 keys we grey-out and disable the
// cascade-apply and service restart/start buttons with an explanatory tooltip.
//
// BUG-154: the gate must use the LIVE key count, not the cached `state.users`
// (which is initialised to [] and only filled by loadUsers() — so a direct
// entry into Settings saw length 0 and falsely blocked the buttons). When
// `count` is not passed we ask the backend; on any error we FAIL-OPEN (treat
// as having keys) so a flaky request never blocks a configured server.
//
// BUG-154: "Сбросить каскад" is deliberately NOT gated — it is a safe cleanup
// that must always work (otherwise a stuck cascade + a glitchy gate could
// leave the operator unable to reset it).
async function applyFoolproofGates(count) {
  let n = count;
  if (typeof n !== 'number') {
    // Always read the live count from the backend; do not trust the cache.
    try {
      const st = await api('GET', '/api/status');
      n = st && st.panel ? st.panel.userCount : undefined;
    } catch { n = undefined; }
    // Secondary best-effort from the cache, then FAIL-OPEN (assume keys exist).
    if (typeof n !== 'number') {
      n = Array.isArray(state.users) && state.users.length ? state.users.length : 1;
    }
  }
  const noKeys = (n || 0) === 0;
  const tip = t('settings.needKeyFirst') || 'Сначала создайте хотя бы один ключ';
  // Buttons blocked on an empty base. NOTE: reset-cascade is intentionally
  // excluded — it is a safe teardown that must always be available.
  const selectors = [
    '[data-action="change-cascade"]',
    '[data-action="svc"][data-svc="mita"][data-svc-action="restart"]',
    '[data-action="svc"][data-svc="mita"][data-svc-action="start"]'
  ];
  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(btn => {
      btn.disabled = noKeys;
      btn.classList.toggle('is-disabled', noKeys);
      if (noKeys) { btn.title = tip; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; }
      else        { btn.title = ''; btn.style.opacity = ''; btn.style.cursor = ''; }
    });
  });
  // BUG-154: actively un-gate "Сбросить каскад" in case an earlier build (or a
  // stale class) left it disabled — it must always be clickable.
  document.querySelectorAll('[data-action="reset-cascade"]').forEach(btn => {
    btn.disabled = false;
    btn.classList.remove('is-disabled');
    btn.title = ''; btn.style.opacity = ''; btn.style.cursor = '';
  });
}

function renderUsersTable(users) {
  const tbody = el('users-tbody');
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="table-empty">${t('users.noUsers')}</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    // Bug 7 fix: protocols is already an array from server (parsed in GET /api/users)
    const protocols = Array.isArray(u.protocols) ? u.protocols : safeParseJSON(u.protocols, []);
    const hasNaive  = protocols.includes('naive');
    const hasMieru  = protocols.includes('mieru');
    const hasHy2    = protocols.includes('hy2');
    const expBadge  = u.expiry
      ? (new Date(u.expiry) < new Date()
          ? `<span class="badge badge-red">${t('users.expired')}</span>`
          : `<span class="badge badge-yellow">${fmtDate(u.expiry)}</span>`)
      : `<span class="badge badge-gray">${t('users.never')}</span>`;

    const quotaPct = u.quotaMB > 0 ? Math.min(100, Math.round((u.usedMB / u.quotaMB) * 100)) : 0;
    const quotaStr = u.quotaMB > 0
      ? `<div class="quota-bar"><div class="quota-fill${quotaPct>80?' warn':''}" style="width:${quotaPct}%"></div></div> ${quotaPct}%`
      : `<span class="badge badge-gray">${t('users.unlimited')}</span>`;

    // v1.10.0 (PR-3b): "Deploy to all nodes" (довыпуск) is only meaningful when
    // this hub has at least one enabled federation node AND the user has an email
    // (email is the cross-server key). Otherwise the button is hidden — keeping
    // single-server installs byte-identical to before federation existed.
    const fedNodes    = Array.isArray(state.config?.federationNodes) ? state.config.federationNodes : [];
    const hasFedNodes = fedNodes.some(n => n && n.enabled !== false && n.url);
    const canDeploy   = hasFedNodes && !!(u.email && String(u.email).trim());
    const deployBtn   = canDeploy
      ? `<button class="btn btn-xs btn-ghost" data-action="deploy-user" data-id="${u.id}" data-username="${esc(u.username)}">${t('federation.deploy') || 'Deploy'}</button>`
      : '';

    // Bug 1 fix: use data-action + data-id instead of onclick="..."
    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${expBadge}</td>
      <td>${hasNaive ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${hasMieru ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${hasHy2 ? '<span class="badge badge-blue">✓</span>' : '<span class="badge badge-gray">—</span>'}</td>
      <td>${fmtNum(u.naiveMB != null ? u.naiveMB : 0)}</td>
      <td>${fmtNum(u.mieruMB != null ? u.mieruMB : 0)}</td>
      <td>${fmtNum(u.hy2MB != null ? u.hy2MB : 0)}</td>
      <td>${u.quotaMB > 0 ? fmtNum(u.quotaMB) : '∞'}</td>
      <td>${quotaStr}</td>
      <td>${fmtLastSeen(u.lastSeen)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-xs btn-secondary" data-action="edit-user"   data-id="${u.id}">${t('users.edit')}</button>
          <button class="btn btn-xs btn-ghost"     data-action="open-config" data-id="${u.id}">${t('users.config')}</button>
          ${deployBtn}
          <button class="btn btn-xs btn-danger"    data-action="delete-user" data-id="${u.id}" data-username="${esc(u.username)}">${t('users.delete')}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openAddUser() {
  state.selectedUserId = null;
  el('user-modal-title').textContent = t('users.addTitle');
  el('user-id').value      = '';
  el('u-username').value   = '';
  el('u-email').value      = '';
  el('u-password').value   = '';
  el('u-expiry').value     = '';
  el('u-quota').value      = '0';
  el('p-naive').checked    = true;
  el('p-mieru').checked    = true;
  if (el('p-hy2')) el('p-hy2').checked = false;
  applyHy2Gate();
  el('u-pass-hint').textContent = t('users.passwordHintNew');
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

// Gate the Hy2 protocol checkbox: enabled only when Hy2 is installed on the
// server. When not installed, disable it and show an inline hint. state.hy2Installed
// is refreshed by loadDashboard()/loadSettings() from /api/status /api/settings/hy2.
function applyHy2Gate() {
  const cb   = el('p-hy2');
  const hint = el('p-hy2-hint');
  if (!cb) return;
  const installed = !!state.hy2Installed;
  cb.disabled = !installed;
  if (!installed) cb.checked = false;
  if (hint) hint.classList.toggle('hidden', installed);
}

function openEditUser(id) {
  const user = state.users.find(u => u.id === id);
  if (!user) return;
  state.selectedUserId = id;
  // Bug 7 fix: protocols already an array from server
  const protocols = Array.isArray(user.protocols) ? user.protocols : safeParseJSON(user.protocols, []);

  el('user-modal-title').textContent = t('users.editTitle');
  el('user-id').value    = id;
  el('u-username').value = user.username;
  el('u-email').value    = user.email;
  el('u-password').value = '';
  el('u-expiry').value   = user.expiry ? user.expiry.slice(0, 16) : '';
  el('u-quota').value    = user.quotaMB || 0;
  el('p-naive').checked  = protocols.includes('naive');
  el('p-mieru').checked  = protocols.includes('mieru');
  applyHy2Gate();
  // After gating: reflect the saved hy2 state (a user may already have hy2 even
  // if the checkbox got disabled — keep it checked so an edit doesn't drop it).
  if (el('p-hy2')) {
    el('p-hy2').checked = protocols.includes('hy2');
    if (protocols.includes('hy2')) el('p-hy2').disabled = false;
  }
  el('u-pass-hint').textContent = t('users.passwordHintEdit');
  el('user-modal-error').classList.add('hidden');
  el('user-modal').classList.remove('hidden');
}

function closeUserModal() { el('user-modal').classList.add('hidden'); }

let _savingUser = false;   // Bug 149 (race): re-entrancy guard against double-submit
async function saveUser() {
  // Bug 149: if a save is already in flight (double-click, Enter+click, etc.),
  // ignore the extra invocation entirely so we never fire two POST /api/users.
  if (_savingUser) return;

  const id       = el('user-id').value;
  const username = el('u-username').value.trim();
  const email    = el('u-email').value.trim();
  const password = el('u-password').value;
  const expiry   = el('u-expiry').value ? new Date(el('u-expiry').value).toISOString() : null;
  const quotaMB  = parseInt(el('u-quota').value, 10) || 0;
  const protocols = [];
  if (el('p-naive').checked) protocols.push('naive');
  if (el('p-mieru').checked) protocols.push('mieru');
  if (el('p-hy2') && el('p-hy2').checked) protocols.push('hy2');

  if (!username)            return showUserError(t('users.usernameRequired'));
  if (!id && !password)     return showUserError(t('users.passwordRequired'));
  if (password && password.length < 8) return showUserError(t('users.passwordTooShort'));
  if (!protocols.length)    return showUserError(t('users.protocolRequired'));

  const body = { email, username, expiry, protocols, quotaMB };
  if (password) body.password = password;

  // v1.2.5: disabled-button + spinner pattern
  const saveBtn = el('btn-save-user');
  _savingUser = true;
  setBtnBusy(saveBtn, true);

  try {
    if (id) {
      const res = await api('PUT', `/api/users/${id}`, body);
      toast(t('users.updated'), 'success');
      pollApplyStatus(res);   // BUG-176: services reload in the background now
    } else {
      const res = await api('POST', '/api/users', body);
      toast(t('users.created'), 'success');
      pollApplyStatus(res);   // BUG-176
    }
    // v1.9.7: the WRITE succeeded above. The modal + list refresh below are
    // purely cosmetic — a failure there (typically a brief connection drop while
    // Caddy reloads in the background) must NOT be reported as a save error, or
    // the user sees "failed" on an edit that actually persisted. So close the
    // modal first, then refresh with a silent, retrying GET; if it still can't
    // reach the server, hint a manual refresh instead of showing a save error.
    closeUserModal();
    try {
      await loadUsers({ retry: 3 });   // Bug 149 + user-edit race: refresh w/ retry
    } catch (_) {
      toast(t('users.savedRefreshHint')
        || 'Saved. The list will update shortly — refresh if it looks stale.', 'info');
    }
  } catch (err) {
    showUserError(err.message);
  } finally {
    _savingUser = false;
    setBtnBusy(saveBtn, false);
  }
}

// BUG-176: after a CRUD, the server applies caddy/mita/hy2 in the background
// (servicesReloading:true) so the request returns instantly instead of dropping
// the connection ("Failed to fetch") during ~3×20s of restarts. Poll the
// outcome and only warn if a service genuinely failed to reload.
async function pollApplyStatus(res) {
  if (!res || res.servicesReloading !== true) {
    // Legacy synchronous shape (older server): honour it directly.
    if (res && res.servicesReloaded === false)
      toast(t('users.serviceReloadWarning') || 'Service reload failed — check logs', 'error');
    return;
  }
  for (let i = 0; i < 15; i++) {              // up to ~30s of polling
    await new Promise(r => setTimeout(r, 2000));
    let st;
    try { st = await api('GET', '/api/apply-status'); } catch { continue; }
    if (st && st.running === false) {
      if (st.servicesReloaded === false) {
        const why = st.hy2Error ? ('Hy2: ' + st.hy2Error)
                  : st.caddyError ? ('Caddy: ' + st.caddyError)
                  : (t('users.serviceReloadWarning') || 'Service reload failed — check logs');
        toast(why, 'error');
      }
      loadUsers();   // refresh traffic/last-active once services settled
      return;
    }
  }
}

function showUserError(msg) {
  const errEl = el('user-modal-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

async function deleteUser(id, username) {
  if (!confirm(t('users.deleteConfirm', { name: username }))) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    toast(t('users.deleted', { name: username }), 'success');
    // BUG-153: the server already regenerated Caddyfile + mita-state.json and
    // restarted services in the DELETE handler (applyAllConfigs). The UI must
    // now re-sync from the backend WITHOUT a manual F5: await the user list,
    // refresh the dashboard service/user-count state, and re-evaluate the
    // foolproof gates (cascade/restart get disabled again if this was the last
    // key). Awaited so any failure surfaces instead of leaving a stale list.
    await loadUsers();
    if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch {} }
    if (typeof applyFoolproofGates === 'function') { try { await applyFoolproofGates(); } catch {} }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// v1.10.0 (PR-3b): broadcast (довыпуск) this user to every enabled federation
// node. Idempotent create-or-update keyed by email — re-clicking is always safe.
// Shows a per-node summary so the admin sees exactly which nodes got the user.
async function deployUser(id, username) {
  if (!confirm(t('federation.deployConfirm', { name: username })
      || `Deploy "${username}" to all federation nodes?`)) return;
  const btns = document.querySelectorAll(`[data-action="deploy-user"][data-id="${id}"]`);
  btns.forEach(b => { b.disabled = true; });
  try {
    const res     = await api('POST', `/api/users/${id}/federation/deploy`);
    const results = Array.isArray(res.results) ? res.results : [];
    const okCount = results.filter(r => r && r.ok).length;
    const failed  = results.filter(r => r && !r.ok);

    if (!results.length) {
      toast(t('federation.deployNoNodes') || 'No federation nodes to deploy to.', 'info');
    } else if (!failed.length) {
      toast(t('federation.deployOk', { ok: okCount, total: results.length })
            || `Deployed to ${okCount}/${results.length} nodes.`, 'success');
    } else {
      // Partial success — name the failing nodes so the admin can act.
      const names = failed.map(r => `${r.name || r.url}: ${r.error || 'error'}`).join('; ');
      toast((t('federation.deployPartial', { ok: okCount, total: results.length })
            || `Deployed to ${okCount}/${results.length} nodes.`) + ' — ' + names,
            okCount ? 'info' : 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}

// ══════════════════════════════════════════════════════════════
// CLIENT CONFIGS + QR CODE
// ══════════════════════════════════════════════════════════════

function openConfigDownload(id) {
  state.selectedUserId = id;
  el('naive-link-box').classList.add('hidden');
  el('naive-link-box').textContent = '';
  el('qr-container').classList.add('hidden');
  el('config-modal').classList.remove('hidden');
  // P3 (selectable mieru port): prefill the port selector from server config.
  const start = parseInt(state.config?.mieruPortStart, 10) || 2012;
  const end   = parseInt(state.config?.mieruPortEnd,   10) || 2022;
  const portEl = el('cfg-mieru-port');
  if (portEl) {
    portEl.min = 1025; portEl.max = 65535;
    portEl.placeholder = String(start);
    portEl.value = '';                       // empty → server falls back to range start
    portEl.dataset.start = String(start);
    portEl.dataset.end   = String(end);
  }
  const rangeEl = el('cfg-mieru-port-range');
  if (rangeEl) rangeEl.textContent = ` (${start}–${end})`;
  // Show the Hy2 link button only when THIS user has hy2 enabled AND Hy2 is
  // installed on the server (state.hy2Installed refreshed elsewhere).
  const user = state.users.find(u => u.id === id);
  const uProtos = user ? (Array.isArray(user.protocols) ? user.protocols : safeParseJSON(user.protocols, [])) : [];
  const hy2Btn = el('btn-dl-hy2-link');
  if (hy2Btn) hy2Btn.classList.toggle('hidden', !(state.hy2Installed && uProtos.includes('hy2')));
  // P3: no password prompt — the server uses the user's stored password.
  // Auto-load the naive link + QR right away.
  loadNaiveLink();
  // v1.9.0: load THIS user's personal bonus links into the modal block.
  loadBonusLinks();
}

// ══════════════════════════════════════════════════════════════
// v1.9.0: PERSONAL BONUS LINKS (per-user, mixed into their sub)
// ══════════════════════════════════════════════════════════════
// In-memory working copy while the modal is open. Saved atomically on
// "Save bonus links". Shape: [{ url:string, enabled:boolean }].
let bonusLinksDraft = [];

async function loadBonusLinks() {
  bonusLinksDraft = [];
  const input = el('bonus-link-input');
  if (input) input.value = '';
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/bonus-links`);
    bonusLinksDraft = Array.isArray(data.links) ? data.links : [];
  } catch { /* leave empty; a fresh/mem user simply has none */ }
  renderBonusLinks();
}

function renderBonusLinks() {
  const box = el('bonus-links-list');
  if (!box) return;
  if (!bonusLinksDraft.length) {
    box.innerHTML =
      `<p style="color:var(--text-secondary);font-size:12px;margin:0">`
      + `${esc(t('bonus.empty') || 'No bonus links yet.')}</p>`;
    return;
  }
  box.innerHTML = bonusLinksDraft.map((b, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <input type="checkbox" data-action="toggle-bonus-link" data-idx="${i}"
             ${b.enabled ? 'checked' : ''}
             title="${esc(t('bonus.toggle') || 'Enabled')}" />
      <code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;${b.enabled ? '' : 'opacity:.5;text-decoration:line-through'}"
            title="${esc(b.url)}">${esc(b.url)}</code>
      <button class="btn btn-ghost btn-sm" type="button"
              data-action="del-bonus-link" data-idx="${i}"
              title="${esc(t('bonus.delete') || 'Delete')}">✕</button>
    </div>`).join('');
}

function addBonusLink() {
  const input = el('bonus-link-input');
  if (!input) return;
  const url = input.value.trim();
  if (!url) return;
  bonusLinksDraft.push({ url, enabled: true });
  input.value = '';
  renderBonusLinks();
}

function removeBonusLink(idx) {
  if (!Number.isInteger(idx)) return;
  bonusLinksDraft.splice(idx, 1);
  renderBonusLinks();
}

function toggleBonusLink(idx) {
  if (!Number.isInteger(idx) || !bonusLinksDraft[idx]) return;
  bonusLinksDraft[idx].enabled = !bonusLinksDraft[idx].enabled;
  renderBonusLinks();
}

async function saveBonusLinks() {
  try {
    const data = await api('PUT',
      `/api/users/${state.selectedUserId}/bonus-links`,
      { links: bonusLinksDraft });
    bonusLinksDraft = Array.isArray(data.links) ? data.links : [];
    renderBonusLinks();
    toast(t('bonus.saved') || 'Bonus links saved', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// P3: build a `?port=` query string from the modal's port selector, validating
//   the value against the configured mieru range. Returns '' when empty/invalid
//   so the server falls back to the range start.
function mieruPortQuery() {
  const portEl = el('cfg-mieru-port');
  if (!portEl) return '';
  const v = parseInt(portEl.value, 10);
  if (!Number.isInteger(v)) return '';
  const start = parseInt(portEl.dataset.start, 10) || 1025;
  const end   = parseInt(portEl.dataset.end,   10) || 65535;
  if (v < start || v > end) {
    toast(t('config.mieruPortOutOfRange') || `Port must be ${start}–${end}`, 'error');
    return null; // signal invalid → caller should abort
  }
  return `?port=${v}`;
}

function closeConfigModal() { el('config-modal').classList.add('hidden'); }

// Fetch + render the naive link/QR (no copy/toast) — used on modal open.
async function loadNaiveLink() {
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/config/naive`);
    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadNaiveLink() {
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/config/naive`);

    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast(t('config.naiveCopied'), 'success');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

// Mieru share-link (mierus://) — copy-paste form for routers (Keenetic/OpenWRT).
// Additive: reuses the shared link box + QR, exactly like the Naive link. The
// existing Mieru JSON download is untouched.
async function downloadMieruLink() {
  try {
    const q = mieruPortQuery();
    if (q === null) return;              // invalid port — abort (toast already shown)
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/config/mieru-link${q}`);

    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast(t('config.mieruLinkCopied'), 'success');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

// Hy2 share-link (hysteria2://) — copy-paste form for NekoBox/Karing/Shadowrocket.
// Additive: reuses the shared link box + QR, exactly like Naive/Mieru links.
async function downloadHy2Link() {
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/config/hy2`);

    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast(t('config.hy2LinkCopied') || 'Hy2 link copied', 'success');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

async function generateQR(text) {
  const container = el('qr-container');
  const canvas    = el('qr-canvas');
  if (!container || !canvas) return;

  if (typeof QRCode !== 'undefined') {
    try {
      await QRCode.toCanvas(canvas, text, {
        width: 200, margin: 2,
        color: {
          dark:  currentTheme === 'dark' ? '#e4e4e7' : '#18181b',
          light: currentTheme === 'dark' ? '#1a1a1d' : '#f5f5f7',
        }
      });
      container.classList.remove('hidden');
    } catch (err) {
      console.warn('QR generation failed:', err);
    }
  }
}

async function downloadMieruConfig() {
  try {
    const q = mieruPortQuery();
    if (q === null) return;              // invalid port — abort (toast already shown)
    const res = await fetch(
      apiUrl(`/api/users/${state.selectedUserId}/config/mieru${q}`),
      { credentials: 'include' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="(.+)"/)?.[1] || 'mieru-config.json';
    downloadBlob(blob, fn);
    toast(t('config.mieruDownloaded'), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function downloadUniversalConfig() {
  try {
    const q = mieruPortQuery();
    if (q === null) return;              // invalid port — abort (toast already shown)
    const res = await fetch(
      apiUrl(`/api/users/${state.selectedUserId}/config/universal${q}`),
      { credentials: 'include' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="(.+)"/)?.[1] || 'universal-config.json';
    downloadBlob(blob, fn);
    toast(t('config.universalDownloaded'), 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// v1.8.7: subscription link. ONE smart URL the client pastes into their app
// (Shadowrocket / Karing). The server auto-detects the client by User-Agent and
// returns the right format (base64 URI list vs sing-box JSON), auto-pulling
// every protocol the user has enabled. We copy it + show a QR, reusing the same
// link box + QR as the other buttons.
async function downloadSubLink() {
  try {
    const data = await api('GET',
      `/api/users/${state.selectedUserId}/sub-link`);

    el('naive-link-box').textContent = data.link;
    el('naive-link-box').classList.remove('hidden');
    copyToClipboard(data.link);
    toast(t('config.subLinkCopied') || 'Sub-ссылка скопирована', 'success');
    generateQR(data.link);
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
// SERVER SETTINGS
// ══════════════════════════════════════════════════════════════

async function loadSettings() {
  try {
    const cfg = await api('GET', '/api/config');
    state.config = cfg;
    el('s-naive-port').value  = cfg.naivePort     || 443;
    el('s-mieru-start').value = cfg.mieruPortStart || 2012;
    el('s-mieru-end').value   = cfg.mieruPortEnd   || 2022;
    el('s-mtu').value         = cfg.mtu || 1400;
    const subBaseEl = el('s-sub-base-url');
    if (subBaseEl) subBaseEl.value = cfg.subBaseUrl || '';
    const flagEl = el('s-server-flag');
    if (flagEl) flagEl.value = cfg.serverFlag || '';   // v1.9.4
    const fakeSiteEl = el('s-fake-site-url');
    if (fakeSiteEl) {
      // v1.9.3: show the configured fake site. The built-in placeholder
      // default (example.com) is treated as "empty" so the field reads blank
      // = "use the default fake site", matching the backend's semantics.
      const fu = cfg.fakeSiteUrl || '';
      fakeSiteEl.value = /^https?:\/\/(www\.)?example\.com\/?$/i.test(fu) ? '' : fu;
    }
    const pattern = cfg.trafficPattern || 'NOOP';
    const radio = document.querySelector(`input[name="traffic-pattern"][value="${pattern}"]`);
    if (radio) radio.checked = true;
    const udpBox = el('s-udp-enabled');
    if (udpBox) udpBox.checked = cfg.udpEnabled === true;
    const langSel = el('s-language-select');
    if (langSel) langSel.value = cfg.language || currentLang || 'ru';
    // v1.2.5: probe secret (masked)
    const probeEl = el('s-probe-secret');
    if (probeEl) probeEl.placeholder = cfg.probeSecret ? '••••••••' : (t('settings.probeSecretPlaceholder') || 'Enter probe secret');
    // Bug 81: probe_resistance mode selector + secret-input visibility
    const probeModeSel = el('s-probe-mode');
    if (probeModeSel) {
      const mode = cfg.probeMode || (cfg.probeSecret ? 'secret' : 'bare');
      probeModeSel.value = mode;
      probeModeSel.onchange = toggleProbeSecretVisibility;
      toggleProbeSecretVisibility();
    }
    // v1.2.6: cascade settings (Variant B — cfg.cascadeMieru)
    const casc = cfg.cascadeMieru || {};
    const cascadeEnabledEl = el('s-cascade-enabled');
    if (cascadeEnabledEl) cascadeEnabledEl.checked = cfg.cascadeEnabled === true;
    // WARP egress (mutually exclusive with cascade)
    const warpEl = el('s-warp-enabled');
    if (warpEl) warpEl.checked = cfg.warpEnabled === true;
    const warpPersistEl = el('s-warp-persist');
    if (warpPersistEl) warpPersistEl.checked = cfg.warpPersist === true;
    refreshWarpUiState(cfg.cascadeEnabled === true);
    try {
      const w = await api('GET', '/api/settings/warp');
      const lr = el('warp-lowram');
      if (lr) {
        if (w && w.lowRam && w.lowRamWarning) { lr.textContent = '⚠ ' + w.lowRamWarning; lr.classList.remove('hidden'); }
        else lr.classList.add('hidden');
      }
      // BUG-162: reflect the real persist (autostart) state from the server.
      if (warpPersistEl && w && typeof w.warpPersist === 'boolean') warpPersistEl.checked = w.warpPersist;
      refreshWarpUiState(!!(w && w.cascadeEnabled));
    } catch {}
    // Hy2 (Hysteria2) settings card
    try {
      const h = await api('GET', '/api/settings/hy2');
      state.hy2Installed = !!(h && h.installed);
      renderHy2Card(h || {});
    } catch {}
    const cascadeNaiveEl = el('s-cascade-naive-upstream');
    if (cascadeNaiveEl) cascadeNaiveEl.value = cfg.cascadeNaiveUpstream || '';
    const cascadeMieruHostEl = el('s-cascade-mieru-host');
    if (cascadeMieruHostEl) cascadeMieruHostEl.value = casc.host || '';
    const cascadePortStartEl = el('s-cascade-mieru-port-start');
    if (cascadePortStartEl) cascadePortStartEl.value = casc.portStart || 2012;
    const cascadePortEndEl = el('s-cascade-mieru-port-end');
    if (cascadePortEndEl) cascadePortEndEl.value = casc.portEnd || 2022;
    const cascadeMieruUserEl = el('s-cascade-mieru-user');
    if (cascadeMieruUserEl) cascadeMieruUserEl.value = casc.user || '';
    // Password is never sent back by the API; show a placeholder if one is set.
    const cascadeMieruPassEl = el('s-cascade-mieru-pass');
    if (cascadeMieruPassEl) {
      cascadeMieruPassEl.value = '';
      cascadeMieruPassEl.placeholder = casc.pass
        ? '••••••• (set — leave blank to keep)'
        : (cascadeMieruPassEl.placeholder || 'password');
    }
    // v1.4.0: external panel access fields
    const exposeBox = el('s-expose-enabled');
    if (exposeBox) exposeBox.checked = cfg.exposePanel === true;
    const pdEl = el('s-panel-domain');
    if (pdEl) pdEl.value = cfg.panelDomain || '';
    const wbpEl = el('s-web-base-path');
    if (wbpEl) wbpEl.value = cfg.webBasePath || '';
    const baUserEl = el('s-ba-user');
    if (baUserEl) baUserEl.value = cfg.panelBasicAuthUser || 'admin';
    // BUG-144: label + placeholder + validation depend on whether a basic-auth
    // hash already exists. First enable → password REQUIRED; existing → optional.
    state.panelBasicAuthSet = cfg.panelBasicAuthSet === true;
    const baPassEl = el('s-ba-pass');
    if (baPassEl) {
      baPassEl.value = '';
      baPassEl.placeholder = state.panelBasicAuthSet
        ? '••••••• (set — leave blank to keep)'
        : (t('settings.externalBaPassPlaceholder') || 'Set a basic-auth password');
    }
    const baLabel = el('s-ba-pass-label');
    if (baLabel) {
      baLabel.textContent = state.panelBasicAuthSet
        ? (t('settings.externalBaPassKeep') || 'Basic-auth password (leave blank to keep current)')
        : (t('settings.externalBaPassNew')  || 'Basic-auth password (required on first enable)');
    }
    toggleExternalFields();
    // BUG-141: prefill the stub editor with the current stub HTML (best-effort).
    loadPanelStub().catch(() => {});

    // Bug A (v1.3.2): keep all three version displays in sync.
    {
      const verStr = `v${cfg.version || '1.2.4'}`;
      ['about-version', 'sidebar-version', 'topbar-version'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = verStr;
      });
    }

    // Доработка 2: gate the cascade/restart buttons whenever the settings page
    // is opened (the user may land here before visiting the keys page).
    applyFoolproofGates();
  } catch {}
}

// ── v1.4.0: external panel access UI ──────────────────────────────────────────
function toggleExternalFields() {
  const on = el('s-expose-enabled') && el('s-expose-enabled').checked;
  const box = el('external-fields');
  if (box) box.style.opacity = on ? '1' : '0.5';
  ['s-panel-domain', 's-web-base-path', 's-ba-user', 's-ba-pass'].forEach(id => {
    const e = el(id); if (e) e.disabled = !on;
  });
}

async function generateWebBasePath() {
  try {
    const r = await api('GET', '/api/panel/webbasepath/generate');
    if (el('s-web-base-path')) el('s-web-base-path').value = r.webBasePath || '';
    toast(t('settings.externalGenerated') || 'New webBasePath generated — click Apply to save', 'info');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveExternalAccess() {
  const enabled = !!(el('s-expose-enabled') && el('s-expose-enabled').checked);
  const body = { enabled };
  if (enabled) {
    body.panelDomain   = (el('s-panel-domain') ? el('s-panel-domain').value : '').trim();
    body.webBasePath   = (el('s-web-base-path') ? el('s-web-base-path').value : '').trim();
    body.basicAuthUser = (el('s-ba-user') ? el('s-ba-user').value : '').trim();
    const pass = el('s-ba-pass') ? el('s-ba-pass').value : '';
    if (pass) body.basicAuthPass = pass;     // omit → keep existing hash
    if (!body.panelDomain) return showMsg('external-access-msg', t('settings.externalNeedDomain') || 'Panel subdomain is required', false);
    // BUG-144: on first enable (no stored hash) a password is mandatory.
    if (!state.panelBasicAuthSet && !pass)
      return showMsg('external-access-msg', t('settings.externalBaPassNew') || 'Basic-auth password is required on first enable', false);
  } else {
    if (!confirm(t('settings.externalDisableConfirm') || 'Disable external access? The panel will be reachable only via SSH tunnel.')) return;
  }
  const btn = document.querySelector('[data-action="save-external-access"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api('POST', '/api/panel/external-access', body);
    if (res.exposePanel && res.url) {
      showMsg('external-access-msg', t('settings.externalApplied') || 'External access applied ✓', true);
      const urlEl = el('external-access-url');
      if (urlEl) {
        urlEl.classList.remove('hidden');
        urlEl.innerHTML = `<strong>URL:</strong> <a href="${esc(res.url)}" target="_blank" rel="noopener">${esc(res.url)}</a>`
          + (res.webBasePathChanged ? `<br><span style="color:var(--yellow)">⚠ ${esc(res.warning || 'webBasePath changed — open the new URL; the old path now shows the stub.')}</span>` : '');
      }
      if (el('s-ba-pass')) el('s-ba-pass').value = '';
      toast(t('settings.externalApplied') || 'External access applied', 'success');
    } else {
      showMsg('external-access-msg', t('settings.externalDisabled') || 'External access disabled (SSH-only) ✓', true);
      const urlEl = el('external-access-url'); if (urlEl) urlEl.classList.add('hidden');
      toast(t('settings.externalDisabled') || 'External access disabled', 'info');
    }
    state.config = await api('GET', '/api/config');
  } catch (err) {
    showMsg('external-access-msg', err.message || 'Failed to apply', false);
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// BUG-141: load the current panel-stub HTML into the editor.
async function loadPanelStub() {
  try {
    const r = await api('GET', '/api/panel/stub');
    if (el('s-panel-stub')) el('s-panel-stub').value = r.html || '';
    showMsg('panel-stub-msg', (t('settings.externalStubLoaded') || 'Loaded current stub') + (r.path ? ` (${esc(r.path)})` : ''), true);
  } catch (err) { showMsg('panel-stub-msg', err.message, false); }
}

// BUG-141: save custom panel-stub HTML (atomic write server-side, no restart).
async function savePanelStub() {
  let html = el('s-panel-stub') ? el('s-panel-stub').value : '';
  // Strip a stray leading "Copy" clipboard artifact before sending.
  html = html.replace(/^\uFEFF/, '').replace(/^Copy(?=\s*<)/, '');
  if (!html.trim()) return showMsg('panel-stub-msg', t('settings.externalStubEmpty') || 'Stub HTML must not be empty', false);
  const btn = document.querySelector('[data-action="save-panel-stub"]');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/panel/stub', { html });
    showMsg('panel-stub-msg', (t('settings.externalStubSaved') || 'Stub saved ✓') + ` (${r.bytes} B)`, true);
    toast(t('settings.externalStubSaved') || 'Stub saved', 'success');
  } catch (err) {
    showMsg('panel-stub-msg', err.message, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── v1.6.0: Backup export / import ───────────────────────────────────────────
// Export: privileged download of the full backup JSON (users incl. passwords +
// full config). Uses fetch (not api()) so we can stream the blob download.
async function backupExport() {
  const btn = document.querySelector('[data-action="backup-export"]');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(apiUrl('/api/backup/export'), { credentials: 'include' });
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const fn   = cd.match(/filename="(.+)"/)?.[1] || 'rixxx-backup.json';
    downloadBlob(blob, fn);
    toast(t('settings.backupExported') || 'Backup downloaded', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Import: triggered when the hidden file input receives a file. Reads + parses
// the JSON locally, previews a summary, then asks for the domain mode + a final
// confirm before POSTing to the server (which restores + rebuilds + restarts).
async function backupImportFile(file) {
  if (!file) return;
  const statusEl = el('backup-import-msg');
  const show = (m, ok) => { if (statusEl) showMsg('backup-import-msg', m, ok); };
  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch {
    show(t('settings.backupBadFile') || 'Not a valid backup file (JSON parse failed)', false);
    return;
  }
  if (!backup || backup.format !== 'rixxx-panel-backup') {
    show(t('settings.backupBadFile') || 'Not a RIXXX panel backup file', false);
    return;
  }
  const nUsers = Array.isArray(backup.users) ? backup.users.length : 0;
  const bDomain = (backup.config && backup.config.domain) || '—';

  // Ask which domain to use. OK = keep backup domain (same-DNS move, clients
  // unaffected); Cancel = keep current server's domain (clients need new keys).
  const useBackupDomain = confirm(
    (t('settings.backupDomainPrompt') ||
      'Restore {n} user(s) from backup.\n\nKeep the DOMAIN/ports FROM THE BACKUP ("{d}")?\n\n• OK = keep backup domain (same DNS → existing client keys keep working)\n• Cancel = keep THIS server\'s current domain (clients must download new keys)')
      .replace('{n}', nUsers).replace('{d}', bDomain)
  );
  const domainMode = useBackupDomain ? 'backup' : 'current';

  if (!confirm(t('settings.backupImportConfirm') ||
      'This will OVERWRITE the current users and settings with the backup. Continue?')) return;

  const btn = document.querySelector('[data-action="backup-import-pick"]');
  if (btn) btn.disabled = true;
  show(t('settings.backupImporting') || 'Restoring…', true);
  try {
    const r = await api('POST', '/api/backup/import', { backup, domainMode });
    show((r.message || 'Restore complete') +
      (r.servicesReloaded ? '' : ' ⚠ services may need a manual restart'), true);
    toast((t('settings.backupImported') || 'Backup restored') + ` (${r.restoredUsers})`, 'success');
    // Reflect restored state everywhere.
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    show(err.message, false);
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    const input = el('backup-file-input');
    if (input) input.value = '';   // allow re-picking the same file
  }
}

async function changeNaivePort() {
  const port = parseInt(el('s-naive-port').value, 10);
  if (!port || port < 1 || port > 65535) {
    showMsg('naive-port-msg', t('settings.invalidPort') || 'Неверный порт (1–65535)', false); return;
  }
  const btn = document.querySelector('[data-action="change-naive-port"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/naive-port', { port });
    showMsg('naive-port-msg', res.message || 'Порт обновлён', true);
    state.config.naivePort = port;
    toast(t('toast.naivePortUpdated') || `Порт NaiveProxy → ${port}`, 'info');
  } catch (err) {
    showMsg('naive-port-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// v1.8.7: save the optional subscription base URL. Empty clears it (sub-links
// then use the panel domain). On change the server rebuilds the Caddyfile so
// Caddy provisions the sub-domain TLS cert + reverse_proxies /sub/* to the panel.
async function saveSubBaseUrl() {
  const raw = (el('s-sub-base-url').value || '').trim();
  // Light client-side validation: allow empty, else must look like a URL/host.
  if (raw && !/^([a-z]+:\/\/)?[a-z0-9.-]+(\.[a-z]{2,})(:\d+)?(\/.*)?$/i.test(raw)) {
    showMsg('sub-base-url-msg', t('settings.subDomainInvalid') || 'Неверный URL/домен', false);
    return;
  }
  const btn = document.querySelector('[data-action="save-sub-base-url"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/config', { subBaseUrl: raw });
    state.config = { ...state.config, subBaseUrl: raw };
    showMsg('sub-base-url-msg', t('settings.subDomainSaved') || 'Sub-домен сохранён', true);
    toast(t('settings.subDomainSaved') || 'Sub-домен сохранён', 'success');
    void res;
  } catch (err) {
    showMsg('sub-base-url-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// v1.9.3: change the fake (masquerade) site straight from the panel. Empty
// clears it → the server falls back to the built-in default fake site. A
// non-empty value must be a full http(s):// URL (the server reverse-proxies
// it). On change the server rebuilds the Caddyfile + reloads Caddy, so the new
// camouflage is live without touching the box over SSH.
async function saveFakeSiteUrl() {
  const raw = (el('s-fake-site-url').value || '').trim();
  // Light client-side validation: allow empty, else must be a full http(s) URL.
  if (raw && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(raw)) {
    showMsg('fake-site-url-msg', t('settings.fakeSiteInvalid') || 'Введите полный https:// URL или оставьте пустым', false);
    return;
  }
  const btn = document.querySelector('[data-action="save-fake-site-url"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/config', { fakeSiteUrl: raw });
    state.config = { ...state.config, fakeSiteUrl: raw };
    showMsg('fake-site-url-msg', t('settings.fakeSiteSaved') || 'Фейк-сайт сохранён', true);
    toast(t('settings.fakeSiteSaved') || 'Фейк-сайт сохранён', 'success');
    void res;
  } catch (err) {
    showMsg('fake-site-url-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// v1.9.4: save the per-server display flag/prefix. Purely cosmetic — applied
// live by the sub builders, no service restart. Empty clears it. Clients pick
// up the new label the next time they refresh their subscription.
async function saveServerFlag() {
  const raw = (el('s-server-flag').value || '').trim().slice(0, 32);
  const btn = document.querySelector('[data-action="save-server-flag"]');
  setBtnBusy(btn, true);
  try {
    await api('POST', '/api/config', { serverFlag: raw });
    state.config = { ...state.config, serverFlag: raw };
    showMsg('server-flag-msg', t('settings.serverFlagSaved') || 'Флаг сохранён', true);
    toast(t('settings.serverFlagSaved') || 'Флаг сохранён', 'success');
  } catch (err) {
    showMsg('server-flag-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// ══════════════════════════════════════════════════════════════
// FEDERATION (v1.9.5) — multi-panel link
// ══════════════════════════════════════════════════════════════

// Load the federation page: this server's node-token state + the peer node list.
// GET /api/config never returns raw tokens (only *Set booleans), so the token
// input starts blank and shows a hint whether a token is already configured.
async function loadFederation() {
  try {
    const cfg = await api('GET', '/api/config');
    state.config = cfg;
    const tokenEl = el('s-federation-token');
    if (tokenEl) {
      tokenEl.value = '';
      tokenEl.placeholder = cfg.federationTokenSet
        ? (t('federation.tokenSetPh') || '•••••••• (token is set — leave blank to keep)')
        : (t('federation.nodeTokenPlaceholder') || 'not set');
    }
    const hint = el('federation-token-hint');
    if (hint) {
      hint.textContent = cfg.federationTokenSet
        ? (t('federation.nodeTokenHintSet') || 'A token is set. Generate + Save to replace it (old peers stop working).')
        : (t('federation.nodeTokenHintUnset') || 'No token yet. Generate one and give it to your main panel.');
    }
    renderFederationNodes(Array.isArray(cfg.federationNodes) ? cfg.federationNodes : []);
  } catch (err) {
    showMsg('federation-nodes-msg', err.message, false);
  }
}

// Render the peer-node list (each row: name, url, tokenSet badge, enable toggle,
// remove). Tokens are never shown — GET only reports `tokenSet`.
function renderFederationNodes(nodes) {
  const box = el('federation-nodes-list');
  if (!box) return;
  if (!nodes.length) {
    box.innerHTML = `<p class="hint" data-i18n="federation.noNodes">${t('federation.noNodes') || 'No peer servers yet.'}</p>`;
    return;
  }
  box.innerHTML = nodes.map(n => {
    const enabled = n.enabled !== false;
    const tokenBadge = n.tokenSet
      ? `<span class="badge badge-blue">${t('federation.tokenOk') || 'token ✓'}</span>`
      : `<span class="badge badge-red">${t('federation.tokenMissing') || 'no token'}</span>`;
    const stateBadge = enabled
      ? `<span class="badge badge-blue">${t('federation.enabled') || 'enabled'}</span>`
      : `<span class="badge badge-gray">${t('federation.disabled') || 'disabled'}</span>`;
    const toggleLbl = enabled
      ? (t('federation.disable') || 'Disable')
      : (t('federation.enable')  || 'Enable');
    return `<div class="fed-node-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="flex:1;min-width:160px">
        <div><strong>${esc(n.name || '—')}</strong> ${stateBadge} ${tokenBadge}</div>
        <div class="hint" style="word-break:break-all">${esc(n.url || '')}</div>
      </div>
      <button class="btn btn-xs btn-secondary" data-action="toggle-federation-node" data-node-id="${esc(n.id)}">${toggleLbl}</button>
      <button class="btn btn-xs btn-danger" data-action="remove-federation-node" data-node-id="${esc(n.id)}">${t('federation.remove') || 'Remove'}</button>
    </div>`;
  }).join('');
}

// Fill the node-token input with a freshly generated token (not yet persisted).
async function genFederationToken() {
  const btn = document.querySelector('[data-action="gen-federation-token"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('GET', '/api/federation/token/generate');
    const inp = el('s-federation-token');
    if (inp && res.federationToken) inp.value = res.federationToken;
    showMsg('federation-token-msg', t('federation.tokenGenerated') || 'Token generated — click Save to apply.', true);
  } catch (err) {
    showMsg('federation-token-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// Copy the node-token input to clipboard (whatever is currently shown/typed).
function copyFederationToken() {
  const inp = el('s-federation-token');
  const val = (inp && inp.value || '').trim();
  if (!val) {
    showMsg('federation-token-msg', t('federation.nothingToCopy') || 'Nothing to copy — generate a token first.', false);
    return;
  }
  copyToClipboard(val);
  toast(t('federation.copied') || 'Copied to clipboard', 'success');
}

// Persist the node token. Empty input = keep the existing token (so re-saving
// the page never wipes it accidentally — matches the placeholder hint).
async function saveFederationToken() {
  const raw = (el('s-federation-token').value || '').trim();
  const btn = document.querySelector('[data-action="save-federation-token"]');
  if (!raw) {
    showMsg('federation-token-msg', t('federation.tokenKept') || 'No change — existing token kept.', true);
    return;
  }
  setBtnBusy(btn, true);
  try {
    await api('POST', '/api/config', { federationToken: raw });
    await loadFederation();
    showMsg('federation-token-msg', t('federation.tokenSaved') || 'Node token saved.', true);
    toast(t('federation.tokenSaved') || 'Node token saved.', 'success');
  } catch (err) {
    showMsg('federation-token-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// Add a peer node. We re-send the WHOLE list (existing nodes with blank tokens,
// which the backend preserves by id) plus the new one, then reload.
async function addFederationNode() {
  const name  = (el('fed-new-name').value  || '').trim();
  const url   = (el('fed-new-url').value   || '').trim();
  const token = (el('fed-new-token').value || '').trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    showMsg('federation-nodes-msg', t('federation.badUrl') || 'Enter a valid http(s):// URL.', false);
    return;
  }
  if (!token) {
    showMsg('federation-nodes-msg', t('federation.needToken') || "Enter that panel's node token.", false);
    return;
  }
  const btn = document.querySelector('[data-action="add-federation-node"]');
  setBtnBusy(btn, true);
  try {
    const existing = (state.config.federationNodes || []).map(n => ({
      id: n.id, name: n.name, url: n.url, enabled: n.enabled !== false, token: '' // '' = keep
    }));
    existing.push({ name, url, token, enabled: true });
    await api('POST', '/api/config', { federationNodes: existing });
    el('fed-new-name').value = '';
    el('fed-new-url').value = '';
    el('fed-new-token').value = '';
    await loadFederation();
    showMsg('federation-nodes-msg', t('federation.nodeAdded') || 'Peer server added.', true);
    toast(t('federation.nodeAdded') || 'Peer server added.', 'success');
  } catch (err) {
    showMsg('federation-nodes-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// v1.10.2: probe each peer node and show a per-node diagnostic (DNS / TLS /
// token / not-updated) so a "fetch failed" during «Довыпуск» is actionable.
// Read-only: the backend just POSTs a probe to each node's /fetch — nothing is
// created or changed.
async function testFederationNodes() {
  const btn = document.querySelector('[data-action="test-federation-nodes"]');
  const box = el('federation-test-results');
  setBtnBusy(btn, true);
  if (box) box.innerHTML = `<div class="msg-inline">${t('federation.testConnsRunning') || 'Testing…'}</div>`;
  try {
    const res     = await api('POST', '/api/federation/nodes/test');
    const results = Array.isArray(res.results) ? res.results : [];
    if (!results.length) {
      if (box) box.innerHTML = `<div class="msg-inline">${t('federation.noNodes') || 'No peer servers yet.'}</div>`;
      return;
    }
    if (box) {
      box.innerHTML = results.map(r => {
        // v1.10.3: three states — OK (green ✓), probe_resistance (blue ✓ = node
        // is up & hardened, self-test can't fully verify but federation works),
        // and error (red ✗).
        const good  = r.ok === true;
        const probe = r.probeResistance === true;
        const color = probe ? 'var(--info, #2563eb)'
                    : good  ? 'var(--ok, #16a34a)'
                            : 'var(--danger, #dc2626)';
        const icon  = good ? '✓' : '✗';
        const label = probe
          ? (t('federation.testProbeResistance') || 'node reachable — probe_resistance active (this is normal for a NaiveProxy node; real federation still works)')
          : good
          ? (t('federation.testOk') || 'reachable, token OK')
          : (r.error || 'error');
        const dis   = r.enabled === false ? ` <span class="badge badge-gray">${t('federation.disabled') || 'disabled'}</span>` : '';
        return `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="color:${color};font-weight:700">${icon}</span>
          <div><strong>${esc(r.name || r.url || '')}</strong>${dis}
            <div style="color:var(--muted);font-size:12px;word-break:break-all">${esc(r.url || '')}</div>
            <div style="color:${color};font-size:13px">${esc(label)}</div>
          </div>
        </div>`;
      }).join('');
    }
  } catch (err) {
    if (box) box.innerHTML = `<div class="msg-inline msg-error">${esc(err.message)}</div>`;
    toast(err.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

// Enable/disable a peer node in place (token preserved by id on the backend).
async function toggleFederationNode(id) {
  try {
    const nodes = (state.config.federationNodes || []).map(n => ({
      id: n.id, name: n.name, url: n.url, token: '',
      enabled: n.id === id ? !(n.enabled !== false) : (n.enabled !== false)
    }));
    await api('POST', '/api/config', { federationNodes: nodes });
    await loadFederation();
  } catch (err) {
    showMsg('federation-nodes-msg', err.message, false);
  }
}

// Remove a peer node (with confirmation).
async function removeFederationNode(id) {
  if (!confirm(t('federation.confirmRemove') || 'Remove this peer server?')) return;
  try {
    const nodes = (state.config.federationNodes || [])
      .filter(n => n.id !== id)
      .map(n => ({ id: n.id, name: n.name, url: n.url, token: '', enabled: n.enabled !== false }));
    await api('POST', '/api/config', { federationNodes: nodes });
    await loadFederation();
    toast(t('federation.nodeRemoved') || 'Peer server removed.', 'info');
  } catch (err) {
    showMsg('federation-nodes-msg', err.message, false);
  }
}

async function changeMieruPorts() {
  const portStart = parseInt(el('s-mieru-start').value, 10);
  const portEnd   = parseInt(el('s-mieru-end').value, 10);
  if (!confirm(t('settings.mieruPortConfirm') || 'Применить изменение портов Mieru?')) return;
  const btn = document.querySelector('[data-action="change-mieru-ports"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/mieru-ports', { portStart, portEnd });
    showMsg('mieru-port-msg', res.message || 'Порты обновлены', true);
    toast(t('toast.mieruPortsUpdated') || `Порты Mieru → ${portStart}–${portEnd}`, 'info');
  } catch (err) {
    showMsg('mieru-port-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// ── Hy2 (Hysteria2) ──────────────────────────────────────────────────────────

// Render the Hy2 settings card from GET /api/settings/hy2.
function renderHy2Card(h) {
  const notInstalled = el('hy2-not-installed');
  const installed    = el('hy2-installed');
  const port         = h.port || 443;
  if (h.installed) {
    if (notInstalled) notInstalled.classList.add('hidden');
    if (installed)    installed.classList.remove('hidden');
    const pInput = el('s-hy2-port-installed');
    if (pInput) pInput.value = port;
    const statusTxt = el('hy2-status-txt');
    if (statusTxt) {
      statusTxt.textContent = ` ${t('settings.hy2Port') || 'Порт'}: ${port}/udp · ` +
        (h.active ? (t('dashboard.active') || 'активен') : (t('dashboard.inactive') || 'остановлен')) +
        ` · ${h.hy2UserCount || 0} ${t('settings.hy2Users') || 'польз.'}`;
    }
  } else {
    if (notInstalled) notInstalled.classList.remove('hidden');
    if (installed)    installed.classList.add('hidden');
    const pInput = el('s-hy2-port');
    if (pInput) pInput.value = port;
  }
}

async function installHy2(reinstall) {
  const portEl = reinstall ? el('s-hy2-port-installed') : el('s-hy2-port');
  const port = parseInt(portEl?.value, 10) || 443;
  if (port < 1 || port > 65535) {
    showMsg('hy2-install-msg', t('settings.invalidPort') || 'Неверный порт (1–65535)', false); return;
  }
  const confirmMsg = reinstall
    ? (t('settings.hy2ReinstallConfirm') || 'Переустановить Hysteria2? Сервис будет перезапущен.')
    : (t('settings.hy2InstallConfirm')   || 'Установить Hysteria2 на этот сервер? Может занять до 1–2 минут.');
  if (!confirm(confirmMsg)) return;

  const btn = document.querySelector(reinstall ? '[data-action="reinstall-hy2"]' : '[data-action="install-hy2"]');
  const msgId = reinstall ? 'hy2-port-msg' : 'hy2-install-msg';
  setBtnBusy(btn, true);
  showMsg(msgId, t('settings.hy2Installing') || 'Установка Hy2… (до 2 минут)', true);
  try {
    const res = await api('POST', '/api/settings/hy2/install', { port });
    showMsg(msgId, res.message || 'Hy2 установлен', true);
    toast(t('settings.hy2Installed') || 'Hysteria2 установлен', 'success');
    state.hy2Installed = true;
    // Refresh the card + dashboard so the new service/state appears immediately.
    try { const h = await api('GET', '/api/settings/hy2'); renderHy2Card(h); } catch {}
    if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch {} }
    // Auto-enroll lit up Hy2 on existing keys — refresh the user list so the
    // Hy2 checkboxes/column reflect it without a manual F5.
    if (res.enrolled) {
      toast((t('settings.hy2Enrolled') || 'Hy2 включён на существующих ключах') + `: ${res.enrolled}`, 'info');
      if (typeof loadUsers === 'function') { try { await loadUsers(); } catch {} }
    }
  } catch (err) {
    showMsg(msgId, err.message, false);
    toast(err.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeHy2Port() {
  const port = parseInt(el('s-hy2-port-installed')?.value, 10);
  if (!port || port < 1 || port > 65535) {
    showMsg('hy2-port-msg', t('settings.invalidPort') || 'Неверный порт (1–65535)', false); return;
  }
  if (!confirm(t('settings.hy2PortConfirm') || 'Сменить порт Hy2? Сервис будет перезапущен, клиентам нужны новые ссылки.')) return;
  const btn = document.querySelector('[data-action="change-hy2-port"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/hy2-port', { port });
    showMsg('hy2-port-msg', res.message || `Порт Hy2 → ${port}`, true);
    toast(t('settings.hy2PortUpdated') || `Порт Hy2 → ${port}/udp`, 'info');
    try { const h = await api('GET', '/api/settings/hy2'); renderHy2Card(h); } catch {}
  } catch (err) {
    showMsg('hy2-port-msg', err.message, false);
    toast(err.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeUdpMode() {
  const enabled = el('s-udp-enabled')?.checked || false;
  const btn = document.querySelector('[data-action="change-udp-mode"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/udp-toggle', { enabled });
    showMsg('udp-msg', res.message || t('settings.udpUpdated'), true);
    state.config.udpEnabled = enabled;
    toast(t('settings.udpUpdated') || `UDP ${enabled ? 'включён' : 'выключен'}`, 'info');
  } catch (err) {
    showMsg('udp-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeTrafficPattern() {
  const pattern = document.querySelector('input[name="traffic-pattern"]:checked')?.value || 'NOOP';
  const mtu = parseInt(el('s-mtu').value, 10);
  const btn = document.querySelector('[data-action="change-traffic-pattern"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/traffic-pattern', { pattern, mtu });
    showMsg('traffic-msg', `${t('settings.trafficPatternLabel')}: ${res.pattern}, MTU: ${res.mtu}`, true);
    toast(t('toast.trafficPatternUpdated') || 'Паттерн трафика обновлён', 'success');
  } catch (err) {
    showMsg('traffic-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changePassword() {
  const current  = el('s-cur-pass').value;
  const newPass  = el('s-new-pass').value;
  const confirm2 = el('s-new-pass2').value;
  if (!current || !newPass || !confirm2)
    return showMsg('pw-msg', t('settings.allFieldsRequired'), false);
  if (newPass !== confirm2)
    return showMsg('pw-msg', t('settings.passwordMismatch'), false);
  if (newPass.length < 8)
    return showMsg('pw-msg', t('settings.passwordTooShort'), false);
  const btn = document.querySelector('[data-action="change-password"]');
  setBtnBusy(btn, true);
  try {
    await api('POST', '/api/config/password', { current, newPass });
    showMsg('pw-msg', t('settings.passwordChanged'), true);
    el('s-cur-pass').value  = '';
    el('s-new-pass').value  = '';
    el('s-new-pass2').value = '';
    toast(t('settings.passwordChanged'), 'success');
  } catch (err) {
    showMsg('pw-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// Bug 81: show/hide the secret input depending on the selected probe mode.
function toggleProbeSecretVisibility() {
  const sel = el('s-probe-mode');
  const grp = el('probe-secret-group');
  if (!sel || !grp) return;
  grp.style.display = (sel.value === 'secret') ? '' : 'none';
}

// v1.2.5 / Bug 81: legacy entry point — delegate to applyProbeMode.
async function changeProbeSecret() { return applyProbeMode(); }

// Bug 81: probe_resistance mode toggle ('off' | 'bare' | 'secret').
async function applyProbeMode() {
  const mode = el('s-probe-mode')?.value || 'bare';
  const secret = el('s-probe-secret')?.value?.trim() || '';

  // For 'secret' mode require a valid secret unless one is already stored.
  if (mode === 'secret' && !state.config?.probeSecret && (!secret || secret.length < 8)) {
    showMsg('probe-secret-msg', t('settings.probeSecretTooShort') || 'Probe secret должен быть не менее 8 символов', false);
    return;
  }

  const btn = document.querySelector('[data-action="apply-probe-mode"]');
  setBtnBusy(btn, true);
  try {
    const body = { probeMode: mode };
    if (mode === 'secret' && secret) body.probeSecret = secret;
    const res = await api('POST', '/api/settings/probe-mode', body);
    showMsg('probe-secret-msg', res.message || t('settings.probeModeUpdated') || 'Probe mode обновлён', true);
    state.config = state.config || {};
    state.config.probeMode = mode;
    if (mode === 'secret' && secret) {
      state.config.probeSecret = secret;
      el('s-probe-secret').value = '';
      el('s-probe-secret').placeholder = '••••••••';
    }
    toast(res.message || t('settings.probeModeUpdated') || 'Probe mode обновлён — Caddy перезагружен', 'success');
  } catch (err) {
    showMsg('probe-secret-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeCascade() {
  const enabled   = el('s-cascade-enabled')?.checked || false;
  const upstream  = el('s-cascade-naive-upstream')?.value?.trim() || '';
  const mieruHost = el('s-cascade-mieru-host')?.value?.trim() || '';
  const portStart = parseInt(el('s-cascade-mieru-port-start')?.value, 10) || 2012;
  const portEnd   = parseInt(el('s-cascade-mieru-port-end')?.value, 10) || 2022;
  const mieruUser = el('s-cascade-mieru-user')?.value?.trim() || '';
  const mieruPass = el('s-cascade-mieru-pass')?.value || '';   // blank = keep existing

  if (enabled) {
    // At least one leg (Naive upstream OR a Mieru exit host) must be configured.
    if (!upstream && !mieruHost) {
      showMsg('cascade-msg', t('settings.cascadeNeedOne')
        || 'Укажите Naive upstream URL и/или Mieru exit host', false);
      return;
    }
    // If a Mieru exit host is given, it needs port range + user.
    if (mieruHost) {
      if (portEnd < portStart) {
        showMsg('cascade-msg', t('settings.cascadePortRangeInvalid')
          || 'Конечный порт должен быть ≥ начального', false);
        return;
      }
      if (!mieruUser) {
        showMsg('cascade-msg', t('settings.cascadeMieruUserRequired')
          || 'Укажите Mieru exit username', false);
        return;
      }
      // Password required only when none is stored yet.
      const hasStoredPass = !!(state.config && state.config.cascadeMieru && state.config.cascadeMieru.pass);
      if (!mieruPass && !hasStoredPass) {
        showMsg('cascade-msg', t('settings.cascadeMieruPassRequired')
          || 'Укажите Mieru exit password', false);
        return;
      }
    }
  }

  const cascadeMieru = {
    host: mieruHost,
    portStart,
    portEnd,
    user: mieruUser,
    pass: mieruPass   // empty string → server keeps the existing password
  };

  const btn = document.querySelector('[data-action="change-cascade"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/cascade', {
      cascadeEnabled: enabled,
      cascadeNaiveUpstream: enabled ? upstream : '',
      cascadeMieru
    });
    showMsg('cascade-msg', res.message || t('settings.cascadeUpdated') || 'Каскад обновлён', true);
    // Reflect new state locally (mask password as boolean, mirroring the API).
    state.config.cascadeEnabled = enabled;
    state.config.cascadeNaiveUpstream = enabled ? upstream : '';
    state.config.cascadeMieru = {
      host: mieruHost, portStart, portEnd, user: mieruUser,
      pass: !!(mieruPass || (state.config.cascadeMieru && state.config.cascadeMieru.pass))
    };
    // Clear the password input and reflect "stored" placeholder.
    const passEl = el('s-cascade-mieru-pass');
    if (passEl) { passEl.value = ''; if (state.config.cascadeMieru.pass) passEl.placeholder = '••••••• (set — leave blank to keep)'; }
    toast(t('settings.cascadeUpdated') || 'Каскад обновлён', 'success');
    // Surface the cascade script output if present.
    if (res.cascadeOutput) cascadeShowStatus(res.cascadeOutput);
  } catch (err) {
    showMsg('cascade-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// Render text into the cascade status <pre> block.
function cascadeShowStatus(text) {
  const pre = el('cascade-status');
  if (!pre) return;
  pre.textContent = text || '';
  pre.classList.remove('hidden');
}

// "Проверить статус" button → GET /api/settings/cascade/status.
async function checkCascadeStatus() {
  const btn = document.querySelector('[data-action="cascade-status"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('GET', '/api/settings/cascade/status');
    cascadeShowStatus(res.output || (res.ok ? 'OK' : 'no status'));
  } catch (err) {
    showMsg('cascade-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// Доработка 1: explicit "Сбросить каскад" — full atomic teardown of every layer
// (config, Caddyfile/upstream, iptables/redsocks/mieru-client/watchdog, mita
// rebuilt with native users). Idempotent: pressing it twice is safe.
async function resetCascade() {
  if (!confirm(t('settings.resetCascadeConfirm')
      || 'Полностью сбросить каскад и вернуть сервер в исходное состояние? Egress станет родным IP.'))
    return;
  const btn = document.querySelector('[data-action="reset-cascade"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/cascade/reset', {});
    // Reflect the cleared state locally so the form + checkbox update at once.
    if (state.config) {
      state.config.cascadeEnabled = false;
      state.config.cascadeNaiveUpstream = '';
      state.config.cascadeMieru = { ...(state.config.cascadeMieru || {}), host: '', user: '', pass: false };
    }
    const enabledEl = el('s-cascade-enabled'); if (enabledEl) enabledEl.checked = false;
    const naiveEl   = el('s-cascade-naive-upstream'); if (naiveEl) naiveEl.value = '';
    const hostEl    = el('s-cascade-mieru-host'); if (hostEl) hostEl.value = '';
    const userEl    = el('s-cascade-mieru-user'); if (userEl) userEl.value = '';
    const passEl    = el('s-cascade-mieru-pass'); if (passEl) { passEl.value = ''; passEl.placeholder = 'password'; }
    const egress = res.nativeEgress ? ` (egress: ${res.nativeEgress})` : '';
    showMsg('cascade-msg', (res.message || t('settings.cascadeReset') || 'Каскад сброшен') + egress, true);
    toast(t('settings.cascadeReset') || 'Каскад сброшен', 'success');
    if (res.cascadeOutput) cascadeShowStatus(res.cascadeOutput);
    // Refresh dashboard service state so mita/naive status reflects the reset.
    if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch {} }
  } catch (err) {
    showMsg('cascade-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

// ── WARP egress (mutually exclusive with cascade) ────────────────────────────
function refreshWarpUiState(cascadeOn) {
  const lock = el('warp-cascade-lock');
  const warpEl = el('s-warp-enabled');
  const applyBtn = el('btn-apply-warp');
  if (cascadeOn) {
    if (lock) lock.classList.remove('hidden');
    if (warpEl) { warpEl.checked = false; warpEl.disabled = true; }
    if (applyBtn) applyBtn.disabled = true;
  } else {
    if (lock) lock.classList.add('hidden');
    if (warpEl) warpEl.disabled = false;
    if (applyBtn) applyBtn.disabled = false;
  }
}

async function applyWarp() {
  const enabled = el('s-warp-enabled')?.checked || false;
  const btn = el('btn-apply-warp');

  // BUG-162: autostart is opt-in. When enabling WARP, explicitly ask whether to
  //   persist across reboots — and warn that a bad tunnel could otherwise lock
  //   the box on every boot. Default answer = NO (do not persist).
  let persist = false;
  if (enabled) {
    const persistEl = el('s-warp-persist');
    if (persistEl) {
      persist = !!persistEl.checked;
    } else {
      persist = window.confirm(
        'Добавить WARP в автозагрузку (поднимать после перезагрузки)?\n\n' +
        'ОК — да, прописать в автозапуск.\n' +
        'Отмена — нет (безопаснее: после ребута WARP не поднимется автоматически, ' +
        'доступ к серверу гарантированно сохранится).'
      );
    }
  }

  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/warp', { warpEnabled: enabled, persist });
    if (state.config) {
      // BUG-168: trust the server's (possibly rolled-back) state, not the toggle.
      state.config.warpEnabled = res.warpEnabled === true;
      if (res.cascadeDisabled) state.config.cascadeEnabled = false;
    }
    // If WARP rolled back (provider block), reflect it in the toggle so the UI
    //   doesn't pretend WARP is on.
    if (res.rolledBack) {
      const we = el('s-warp-enabled'); if (we) we.checked = false;
    }
    if (res.cascadeDisabled) {
      const ce = el('s-cascade-enabled'); if (ce) ce.checked = false;
    }
    // BUG-168: prefer the classified result {severity, message}. severity maps
    //   to green (success) / yellow (warning — provider block, NOT a panel error).
    const wr = res.warpResult || {};
    const severity = wr.severity || (res.ok !== false ? 'success' : 'error');
    const message  = wr.message || res.message || 'WARP применён';
    showMsg('warp-msg', message, severity);
    // Toast: success = green; provider-block warnings are informational, not errors.
    if (severity === 'success') toast('WARP применён', 'success');
    else if (severity === 'warning') toast('WARP: ограничение хостинга (всё откачено, доступ сохранён)', 'info');
    else toast('WARP: ошибка', 'error');
    if (res.output) { const pre = el('warp-status'); if (pre) { pre.textContent = res.output; pre.classList.remove('hidden'); } }
    if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch {} }
  } catch (err) {
    showMsg('warp-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function checkWarpStatus() {
  const btn = document.querySelector('[data-action="warp-status"]');
  setBtnBusy(btn, true);
  try {
    const res = await api('GET', '/api/settings/warp/status');
    const pre = el('warp-status');
    if (pre) { pre.textContent = res.output || '(нет данных)'; pre.classList.remove('hidden'); }
  } catch (err) {
    showMsg('warp-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function resetWarp() {
  if (!confirm('Полностью снять WARP и вернуть родной IP сервера?')) return;
  const btn = el('btn-reset-warp');
  setBtnBusy(btn, true);
  try {
    const res = await api('POST', '/api/settings/warp/reset', {});
    if (state.config) state.config.warpEnabled = false;
    const warpEl = el('s-warp-enabled'); if (warpEl) warpEl.checked = false;
    const egress = res.nativeEgress ? ` (egress: ${res.nativeEgress})` : '';
    showMsg('warp-msg', (res.message || 'WARP снят') + egress, true);
    toast('WARP снят', 'success');
    if (res.output) { const pre = el('warp-status'); if (pre) { pre.textContent = res.output; pre.classList.remove('hidden'); } }
    if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch {} }
  } catch (err) {
    showMsg('warp-msg', err.message, false);
  } finally {
    setBtnBusy(btn, false);
  }
}

async function changeLanguage() {
  const sel = el('s-language-select');
  if (!sel) return;
  const lang = sel.value;
  try {
    await api('POST', '/api/settings/language', { language: lang });
    await setLang(lang);
    toast((t('settings.applyLanguage') || 'Language') + ': ' + lang.toUpperCase(), 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// MONITORING
// ══════════════════════════════════════════════════════════════

async function loadMonitoring() { refreshStats(); }

async function refreshStats() {
  try {
    const [status, stats] = await Promise.all([
      api('GET', '/api/status'),
      api('GET', '/api/stats/users'),
    ]);

    el('m-cpu').textContent    = `${status.system.cpuPercent}%`;
    el('m-ram').textContent    = `${fmtMB(status.system.ramUsedMB)}/${fmtMB(status.system.ramTotalMB)}`;
    el('m-naive').innerHTML    = badge(status.services.naive.active, t('monitoring.active'), t('monitoring.inactive'));
    el('m-mieru').innerHTML    = badge(status.services.mieru.active, t('monitoring.active'), t('monitoring.inactive'));
    el('m-uptime').textContent = fmtUptime(status.system.uptime);

    renderTrafficTable(stats);
  } catch (err) {
    console.error('Monitoring error:', err);
  }
}

function renderTrafficTable(stats) {
  const tbody = el('traffic-tbody');
  // BUG-163: /api/stats/users now returns { users, naiveServerTotalMB }. Accept
  //   both the new object shape and the legacy bare array.
  if (!Array.isArray(stats)) stats = (stats && stats.users) || [];
  if (!stats.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${t('monitoring.noUsers')}</td></tr>`;
    return;
  }
  tbody.innerHTML = stats.map(u => {
    const quotaMB = u.quotaMB || 0;
    const usedMB  = u.usedMB  || 0;
    const pct     = quotaMB > 0 ? Math.min(100, Math.round((usedMB / quotaMB) * 100)) : 0;
    const warn    = pct > 80;
    const danger  = pct > 95;
    const quotaCell = quotaMB > 0
      ? `<div style="display:flex;align-items:center;gap:8px">
          <div class="quota-bar"><div class="quota-fill${danger?' danger':warn?' warn':''}" style="width:${pct}%"></div></div>
          <span style="font-size:11px;color:${danger?'var(--red)':warn?'var(--yellow)':'var(--text-muted)'}">${pct}%</span>
         </div>`
      : `<span class="badge badge-gray">${t('monitoring.unlimited')}</span>`;

    return `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td>${fmtNum(u.uploadMB)}</td>
      <td>${fmtNum(u.downloadMB)}</td>
      <td>${fmtNum(usedMB)}</td>
      <td>${quotaMB > 0 ? fmtNum(quotaMB) : '∞'}</td>
      <td>${quotaCell}</td>
      <td>${u.expiry ? fmtDate(u.expiry) : '—'}</td>
      <td>${fmtLastSeen(u.lastSeen)}</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// LOGS
// ══════════════════════════════════════════════════════════════

async function loadLogs(service) {
  currentLogService = service || currentLogService;
  ['caddy', 'mieru', 'hy2', 'panel'].forEach(s => {
    el(`log-btn-${s}`)?.classList.toggle('active', s === currentLogService);
  });
  const lines = el('log-lines')?.value || 100;
  el('log-content').textContent = t('logs.loading') || 'Loading…';
  try {
    const data = await api('GET', `/api/logs/${currentLogService}?lines=${lines}`);
    el('log-content').textContent = data.logs || '(empty)';
    el('log-content').scrollTop = el('log-content').scrollHeight;
  } catch (err) {
    el('log-content').textContent = `Error: ${err.message}`;
  }
}

// ══════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ══════════════════════════════════════════════════════════════

async function runDiagnostics() {
  el('diag-ports').innerHTML  = `<p class="text-muted">${t('diagnostics.checking') || '…'}</p>`;
  el('diag-config').innerHTML = `<p class="text-muted">${t('diagnostics.checking') || '…'}</p>`;
  el('diag-mita-status').textContent = t('logs.loading') || '…';
  el('diag-mita-config').textContent = t('logs.loading') || '…';

  try {
    const data = await api('GET', '/api/diagnostics');

    el('diag-ports').innerHTML = `
      <div class="info-list">
        <div class="info-row">
          <span>${t('diagnostics.naivePort', { port: state.config.naivePort || 443 })}</span>
          <span>${data.ports?.naive
            ? `<span class="badge badge-green">${t('diagnostics.open')}</span>`
            : `<span class="badge badge-red">${t('diagnostics.closed')}</span>`}</span>
        </div>
        <div class="info-row">
          <span>${t('diagnostics.mieruPort', { port: state.config.mieruPortStart || 2012 })}</span>
          <span>${data.ports?.mieru
            ? `<span class="badge badge-green">${t('diagnostics.open')}</span>`
            : `<span class="badge badge-red">${t('diagnostics.closed')}</span>`}</span>
        </div>
      </div>`;

    // v1.2.5: caddy-forwardproxy-naive — show Caddyfile + probe_secret status
    const naiveOk = data.naiveVersionOk && data.naiveConfigExists;
    const caddyfileUsers = data.caddyfileUsers ?? data.htpasswdUsers ?? 0;
    const probeSet = data.probeSecretSet ? '✓ set' : '✗ not set';
    el('diag-config').innerHTML = naiveOk
      ? `<span class="badge badge-green">${t('diagnostics.caddyValid') || 'Caddyfile valid ✓'}</span>
         <small style="display:block;margin-top:4px;color:var(--text-muted)">${esc(data.naiveVersion || '')}</small>
         <small style="color:var(--text-muted)">Caddyfile users: ${caddyfileUsers} &nbsp;|&nbsp; probe_secret: ${probeSet}</small>`
      : `<span class="badge badge-red">${t('diagnostics.naiveInvalid') || 'caddy-naive WARN'}</span>
         <pre class="mini-log mt-2">${esc(data.naiveVersion || 'binary not found or version empty')}</pre>`;

    el('diag-mita-status').textContent = data.mitaStatus  || t('diagnostics.noOutput') || '—';
    el('diag-mita-config').textContent = data.mitaConfig  || t('diagnostics.noOutput') || '—';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// SERVICE CONTROL
// ══════════════════════════════════════════════════════════════

async function svcAction(service, action) {
  try {
    await api('POST', `/api/service/${service}/${action}`);
    toast(t('service.actionOk', { service, action }) || `${service} ${action} OK`, 'success');
    setTimeout(loadDashboard, 1500);
  } catch (err) {
    toast(t('service.actionFail', { service, action, msg: err.message }) || err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// WEBSOCKET — live metrics
// ══════════════════════════════════════════════════════════════

function connectWebSocket() {
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // BUG-140: carry webBasePath so Caddy's handle_path matches and strips it.
  const wsUrl = `${proto}//${location.host}${BASE_PATH}/ws`;

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      document.getElementById('ws-dot').className = 'status-dot connected';
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'metrics') {
          if (state.currentPage === 'monitoring') {
            el('m-cpu').textContent  = `${msg.cpu}%`;
            el('m-ram').textContent  = `${fmtMB(msg.ramUsedMB)}/${fmtMB(msg.ramTotalMB)}`;
            el('m-naive').innerHTML  = badge(msg.naive, t('monitoring.active'), t('monitoring.inactive'));
            el('m-mieru').innerHTML  = badge(msg.mieru, t('monitoring.active'), t('monitoring.inactive'));
          }
          if (state.currentPage === 'dashboard') {
            el('d-naive-status').innerHTML = badge(msg.naive, t('dashboard.active'), t('dashboard.inactive'));
            el('d-mieru-status').innerHTML = badge(msg.mieru, t('dashboard.active'), t('dashboard.inactive'));
            const cpuEl = el('d-cpu');
            if (cpuEl) { cpuEl.textContent = `${msg.cpu}%`; setProgress('d-cpu-bar', msg.cpu); }
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      document.getElementById('ws-dot').className = 'status-dot error';
      state.ws = null;
      state.wsReconnectTimer = setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = () => ws.close();
  } catch {
    state.wsReconnectTimer = setTimeout(connectWebSocket, 5000);
  }
}

// ══════════════════════════════════════════════════════════════
// HTTP HELPER (Bug 10: 401 auto-redirect; toast on all errors)
// ══════════════════════════════════════════════════════════════

async function api(method, path, body, apiOpts = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);

  // v1.9.7 (BUG user-edit race): after a user CRUD the server reloads Caddy in
  // the background (BUG-176). Caddy reverse-proxies the panel, so a follow-up
  // GET (e.g. loadUsers() refresh) can briefly hit a connection drop and fetch()
  // rejects with a TypeError ("Failed to fetch") — even though the write already
  // succeeded. That surfaced as a scary "failed" on an edit that actually saved.
  //
  // Fix: allow a SILENT retry for idempotent GETs on a *transport* error only
  // (never on an HTTP status — a real 4xx/5xx is still reported immediately, and
  // mutations are never retried so we can't double-write). Opt-in via
  // apiOpts.retry so normal calls are unchanged.
  const retries = (method === 'GET' && apiOpts.retry) ? apiOpts.retry : 0;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(apiUrl(path), opts);
      break;                                   // got an HTTP response (any status)
    } catch (netErr) {
      // Transport-level failure (server briefly unreachable during a reload).
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, apiOpts.retryDelay || 1200));
        continue;
      }
      throw netErr;                            // out of retries → let caller decide
    }
  }

  // Bug 10: auto-redirect on 401
  if (res.status === 401) {
    redirectToLogin();
    throw new Error(t('login.invalidCreds') || 'Session expired');
  }

  const ct   = res.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg = (typeof data === 'object' && data.error) ? data.error : String(data);
    const errMsg = msg || `HTTP ${res.status}`;
    if (!apiOpts.silent) toast(errMsg, 'error');   // Bug 10: always show toast on error
    throw new Error(errMsg);
  }
  return data;
}

// Redirect back to login screen (Bug 10)
function redirectToLogin() {
  if (!state.authenticated) return;
  state.authenticated = false;
  if (state.ws) { state.ws.close(); state.ws = null; }
  document.getElementById('app').classList.add('hidden');
  document.getElementById('page-login').classList.add('active');
  toast(t('login.sessionExpired') || 'Session expired — please log in again', 'error');
}

// ══════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════

function el(id) { return document.getElementById(id); }

/**
 * v1.2.5: disabled-button + spinner pattern for all submit handlers.
 * Prevents double-submit and gives visual feedback during async ops.
 */
function setBtnBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    btn.dataset.origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${btn.dataset.origText}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) {
      btn.innerHTML = btn.dataset.origText;
      delete btn.dataset.origText;
    }
  }
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Safe JSON.parse with fallback */
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function badge(active, trueLabel, falseLabel) {
  return active
    ? `<span class="badge badge-green">● ${trueLabel}</span>`
    : `<span class="badge badge-red">● ${falseLabel}</span>`;
}

function infoList(rows) {
  return rows.map(([k, v]) =>
    `<div class="info-row"><span>${esc(k)}</span><span>${esc(String(v ?? '—'))}</span></div>`
  ).join('');
}

function setProgress(id, pct) {
  const el2 = document.getElementById(id);
  if (!el2) return;
  const p = Math.max(0, Math.min(100, pct));
  el2.style.width = `${p}%`;
  el2.classList.toggle('warn',   p > 70 && p <= 85);
  el2.classList.toggle('danger', p > 85);
}

// BUG-168: `ok` may be a boolean (legacy ok/err) OR a severity string
//   ('success' | 'warning' | 'error'). A 'warning' renders yellow and stays
//   longer (the WARP provider-block explanation is long and important).
function showMsg(id, text, ok) {
  const el2 = document.getElementById(id);
  if (!el2) return;
  let cls, ttl = 6000;
  if (ok === 'warning' || ok === 'warn') { cls = 'warn'; ttl = 16000; }
  else if (ok === 'success' || ok === true) { cls = 'ok'; }
  else if (ok === 'error' || ok === false) { cls = 'err'; }
  else { cls = ok ? 'ok' : 'err'; }
  el2.textContent = text;
  el2.className = `msg-inline ${cls}`;
  el2.classList.remove('hidden');
  // Allow long, persistent warnings to be dismissed manually; auto-hide others.
  if (el2._hideTimer) clearTimeout(el2._hideTimer);
  el2._hideTimer = setTimeout(() => el2.classList.add('hidden'), ttl);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const opts = { day: '2-digit', month: 'short', year: 'numeric' };
    return new Date(iso).toLocaleDateString(currentLang === 'ru' ? 'ru-RU' : 'en-GB', opts);
  } catch { return iso; }
}

/** Blocker 14: "Last seen N min/h/d ago" */
function fmtLastSeen(iso) {
  if (!iso) return '—';
  try {
    const diffMs  = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return fmtDate(iso);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return currentLang === 'ru' ? 'только что' : 'just now';
    if (diffMin < 60) return currentLang === 'ru' ? `${diffMin} мин. назад` : `${diffMin} min ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)   return currentLang === 'ru' ? `${diffH} ч. назад`   : `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return currentLang === 'ru' ? `${diffD} д. назад` : `${diffD}d ago`;
  } catch { return iso; }
}

function fmtMB(mb) {
  if (!mb) return '0 MB';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtNum(n) {
  if (n === undefined || n === null) return '0';
  return parseFloat(n).toFixed(1);
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function togglePw(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

// Bug 35 / feature: fetch a safe random password and fill the user form field.
async function generatePassword() {
  const input = document.getElementById('u-password');
  if (!input) return;
  try {
    const data = await api('GET', '/api/password/generate?length=16');
    if (data && data.password) {
      input.value = data.password;
      input.type = 'text';            // reveal so the admin can see/copy it
      copyToClipboard(data.password); // also place it on the clipboard
      toast(t('users.passwordGenerated') || 'Random password generated & copied', 'success');
    }
  } catch (err) { toast(err.message, 'error'); }
}

// Copy the current value of the user-password field to the clipboard.
function copyPasswordField() {
  const input = document.getElementById('u-password');
  if (!input || !input.value) {
    toast(t('users.passwordEmpty') || 'Password field is empty', 'error');
    return;
  }
  copyToClipboard(input.value);
  toast(t('users.passwordCopied') || 'Password copied', 'success');
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t_el = document.createElement('div');
  t_el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  t_el.innerHTML = `<span style="font-weight:700;font-size:14px">${icons[type] || 'ℹ'}</span><span>${esc(message)}</span>`;
  container.appendChild(t_el);
  setTimeout(() => {
    t_el.style.opacity = '0';
    t_el.style.transform = 'translateX(20px)';
    t_el.style.transition = 'all 0.3s';
    setTimeout(() => t_el.remove(), 300);
  }, 4000);
}
