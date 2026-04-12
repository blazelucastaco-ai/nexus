// ─── Element refs ─────────────────────────────────────────────────────────────

const statusPill      = document.getElementById('status-pill');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');
const statusSub       = document.getElementById('status-sub');
const uptimeBadge     = document.getElementById('uptime-badge');
const statCmds        = document.getElementById('stat-cmds');
const statTabs        = document.getElementById('stat-tabs');
const tabCard         = document.getElementById('tab-card');
const tabFavicon      = document.getElementById('tab-favicon');
const tabTitle        = document.getElementById('tab-title');
const tabUrl          = document.getElementById('tab-url');
const tabCount        = document.getElementById('tab-count');
const activityList    = document.getElementById('activity-list');
const connectedContent = document.getElementById('connected-content');
const offlineContent  = document.getElementById('offline-content');
const footerDot       = document.getElementById('footer-dot');
const footerStatus    = document.getElementById('footer-status');

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatUptime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ${h % 24}h`;
  if (h > 0)  return `${h}h ${m % 60}m`;
  if (m > 0)  return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  if (s < 3)  return 'just now';
  return `${s}s ago`;
}

function truncateUrl(url) {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 28) + (u.pathname.length > 28 ? '…' : '') : '');
  } catch {
    return url.slice(0, 40);
  }
}

// ─── Active tab ───────────────────────────────────────────────────────────────

async function updateActiveTab() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const allTabs  = await chrome.tabs.query({});

    if (active) {
      tabTitle.textContent = active.title || '(untitled)';
      tabUrl.textContent   = truncateUrl(active.url);

      // Favicon
      if (active.favIconUrl) {
        tabFavicon.innerHTML = `<img src="${active.favIconUrl}" onerror="this.style.display='none'">`;
      } else {
        tabFavicon.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <circle cx="5" cy="5" r="4" stroke="#475569" stroke-width="1.2"/>
          </svg>`;
      }
    }

    const count = allTabs.length;
    statTabs.textContent = count;
    tabCount.textContent = `${count} tab${count !== 1 ? 's' : ''}`;
  } catch {
    tabTitle.textContent = 'No active tab';
    tabUrl.textContent   = '—';
    statTabs.textContent = '—';
  }
}

// ─── Activity feed ────────────────────────────────────────────────────────────

function renderActivity(commands) {
  if (!commands || commands.length === 0) {
    activityList.innerHTML = '<div class="empty-state">No commands yet this session</div>';
    return;
  }

  const recent = [...commands].reverse().slice(0, 6);
  activityList.innerHTML = recent.map(cmd => `
    <div class="activity-item">
      <div class="activity-dot ${cmd.success ? 'ok' : 'fail'}"></div>
      <div class="activity-action">${cmd.action}</div>
      <div class="activity-time">${formatAgo(cmd.ts)}</div>
    </div>
  `).join('');
}

// ─── Uptime ticker ────────────────────────────────────────────────────────────

let uptimeInterval = null;

function startUptimeTick(connectedAt) {
  stopUptimeTick();
  uptimeInterval = setInterval(() => {
    const t = formatUptime(connectedAt);
    if (t) uptimeBadge.textContent = t;
  }, 1000);
}

function stopUptimeTick() {
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
}

// ─── Main render ──────────────────────────────────────────────────────────────

function render({ connected, connectedAt, commandCount, recentCommands }) {
  if (connected) {
    // Status pill
    statusPill.className = 'status-pill connected';
    statusDot.className  = 'status-dot connected';
    statusLabel.textContent = 'Connected to NEXUS';
    statusSub.textContent   = 'Bridge is active — all tools available';

    // Uptime badge
    const uptime = formatUptime(connectedAt);
    if (uptime) {
      uptimeBadge.textContent = uptime;
      uptimeBadge.style.display = '';
      startUptimeTick(connectedAt);
    }

    // Stats
    statCmds.textContent = commandCount ?? 0;

    // Content sections
    connectedContent.style.display = '';
    offlineContent.style.display   = 'none';

    // Footer
    footerDot.className    = 'footer-dot live';
    footerStatus.textContent = 'live';

    // Active tab + activity
    updateActiveTab();
    renderActivity(recentCommands);

  } else {
    stopUptimeTick();

    statusPill.className = 'status-pill disconnected';
    statusDot.className  = 'status-dot disconnected';
    statusLabel.textContent = 'Disconnected';
    statusSub.textContent   = 'NEXUS is not running';

    uptimeBadge.style.display = 'none';
    statCmds.textContent = '—';
    statTabs.textContent = '—';

    connectedContent.style.display = 'none';
    offlineContent.style.display   = '';

    footerDot.className      = 'footer-dot';
    footerStatus.textContent = 'offline';
  }
}

// ─── Init & live updates ──────────────────────────────────────────────────────

chrome.storage.local.get(['connected', 'connectedAt', 'commandCount', 'recentCommands'], render);

chrome.storage.onChanged.addListener(() => {
  chrome.storage.local.get(['connected', 'connectedAt', 'commandCount', 'recentCommands'], render);
});

// Refresh active tab display every 3s while popup is open
setInterval(() => {
  chrome.storage.local.get(['connected'], ({ connected }) => {
    if (connected) updateActiveTab();
  });
}, 3000);
