const dot        = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const infoBlock  = document.getElementById('info-block');
const sinceVal   = document.getElementById('since-val');
const hint       = document.getElementById('hint');

function formatSince(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  if (h > 0)      return `${h}h ${m % 60}m ago`;
  if (m > 0)      return `${m}m ago`;
  return 'just now';
}

function render({ connected, connectedAt }) {
  if (connected) {
    dot.className        = 'dot connected';
    statusText.innerHTML = '<strong>Connected</strong> to NEXUS';
    infoBlock.style.display = 'flex';
    hint.style.display      = 'none';
    sinceVal.textContent    = formatSince(connectedAt);
  } else {
    dot.className        = 'dot disconnected';
    statusText.innerHTML = '<strong>Disconnected</strong>';
    infoBlock.style.display = 'none';
    hint.style.display      = 'block';
  }
}

chrome.storage.local.get(['connected', 'connectedAt'], (data) => {
  render({ connected: !!data.connected, connectedAt: data.connectedAt });
});

// Live updates while popup is open
chrome.storage.onChanged.addListener((changes) => {
  chrome.storage.local.get(['connected', 'connectedAt'], (data) => {
    render({ connected: !!data.connected, connectedAt: data.connectedAt });
  });
});
