/**
 * NEXUS Bridge — Chrome Extension Background Service Worker
 * Connects to the local NEXUS WebSocket server and executes browser commands.
 */

const WS_URL = 'ws://127.0.0.1:9338';
const RECONNECT_DELAY_MS = 4000;
const PING_INTERVAL_MS = 20000;

let ws = null;
let connected = false;
let pingTimer = null;

// ─── Connection management ────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    connected = true;
    updateBadge(true);
    chrome.storage.local.set({ connected: true, connectedAt: Date.now() });
    startPing();
    console.log('[NEXUS] Connected to bridge');
  });

  ws.addEventListener('close', () => {
    connected = false;
    updateBadge(false);
    chrome.storage.local.set({ connected: false });
    stopPing();
    console.log('[NEXUS] Disconnected — reconnecting in', RECONNECT_DELAY_MS, 'ms');
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // close event will fire and handle reconnection
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'pong') return; // heartbeat response

    if (msg.type === 'command') {
      const result = await handleCommand(msg);
      ws.send(JSON.stringify({ id: msg.id, type: 'response', ...result }));
    }
  });
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function updateBadge(isConnected) {
  chrome.action.setBadgeText({ text: isConnected ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#34D399' : '#F87171' });
}

// ─── Command dispatcher ───────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { action, params } = msg;
  try {
    switch (action) {
      case 'navigate':    return await cmdNavigate(params);
      case 'click':       return await cmdClick(params);
      case 'type':        return await cmdType(params);
      case 'clear':       return await cmdClear(params);
      case 'select':      return await cmdSelect(params);
      case 'extract':     return await cmdExtract(params);
      case 'screenshot':  return await cmdScreenshot();
      case 'evaluate':    return await cmdEvaluate(params);
      case 'scroll':      return await cmdScroll(params);
      case 'wait_for':    return await cmdWaitFor(params);
      case 'fill_form':   return await cmdFillForm(params);
      case 'get_info':    return await cmdGetInfo();
      case 'get_tabs':    return await cmdGetTabs();
      case 'switch_tab':  return await cmdSwitchTab(params);
      case 'new_tab':     return await cmdNewTab(params);
      case 'close_tab':   return await cmdCloseTab(params);
      case 'back':        return await cmdHistory('back');
      case 'forward':     return await cmdHistory('forward');
      case 'reload':      return await cmdReload();
      default:            return fail(`Unknown action: ${action}`);
    }
  } catch (err) {
    return fail(err.message ?? String(err));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data) { return { success: true, data }; }
function fail(error) { return { success: false, error }; }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function waitForLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve(); // resolve anyway after timeout
    }, timeoutMs);
  });
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (result?.result instanceof Error) throw result.result;
  return result?.result;
}

// ─── Command implementations ──────────────────────────────────────────────────

async function cmdNavigate({ url }) {
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return ok({ url: updated.url, title: updated.title });
}

async function cmdClick({ selector = null, text = null, index = 0 }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel, txt, idx) => {
    let el;
    if (sel) {
      const els = document.querySelectorAll(sel);
      el = els[idx] ?? els[0];
    } else if (txt) {
      const candidates = document.querySelectorAll(
        'a, button, [role="button"], input[type="submit"], input[type="button"], label, [onclick]'
      );
      el = Array.from(candidates).find(e =>
        e.textContent?.trim().toLowerCase().includes(txt.toLowerCase())
      );
    }
    if (!el) return { ok: false, error: `Element not found: ${sel ?? txt}` };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: el.textContent?.trim().slice(0, 80) };
  }, [selector, text, index]);

  if (!result.ok) return fail(result.error);
  return ok(result);
}

async function cmdType({ selector = null, text, clear = false }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel, txt, clr) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { ok: false, error: `Element not found: ${sel}` };
    el.focus();
    if (clr) el.value = '';
    const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ??
                        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (nativeInput) {
      nativeInput.set.call(el, (el.value ?? '') + txt);
    } else {
      el.value = (el.value ?? '') + txt;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, [selector, text, clear]);

  if (!result.ok) return fail(result.error);
  return ok({ typed: text });
}

async function cmdClear({ selector }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { ok: false, error: `Element not found: ${sel}` };
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }, [selector]);

  if (!result.ok) return fail(result.error);
  return ok({});
}

async function cmdSelect({ selector, value }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: `Select element not found: ${sel}` };
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: el.value };
  }, [selector, value]);

  if (!result.ok) return fail(result.error);
  return ok(result);
}

async function cmdExtract({ selector = null, attribute = null, all = false }) {
  const tab = await getActiveTab();
  const data = await runInTab(tab.id, (sel, attr, getAllResults) => {
    if (!sel) {
      // Full-page extraction
      return {
        url:   location.href,
        title: document.title,
        text:  document.body?.innerText?.slice(0, 80000) ?? '',
        links: Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 200)
          .map(a => ({ text: a.textContent?.trim(), href: a.href })),
        headings: Array.from(document.querySelectorAll('h1,h2,h3'))
          .slice(0, 50)
          .map(h => ({ level: h.tagName, text: h.textContent?.trim() })),
      };
    }

    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) return null;

    const extract = (el) =>
      attr === 'html'       ? el.innerHTML
      : attr               ? (el.getAttribute(attr) ?? el.textContent?.trim())
      : el.textContent?.trim();

    return getAllResults ? els.map(extract) : extract(els[0]);
  }, [selector, attribute, all]);

  if (data === null) return fail(`No element matching: ${selector}`);
  return ok(data);
}

async function cmdScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  // Return base64 without the data:image/png;base64, prefix
  const base64 = dataUrl.split(',')[1] ?? dataUrl;
  return ok({ base64, mimeType: 'image/png' });
}

async function cmdEvaluate({ code }) {
  const tab = await getActiveTab();
  // Use MAIN world so the page's context allows Function/eval
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (c) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(c);
        const r = fn();
        return { ok: true, result: typeof r === 'object' ? JSON.stringify(r) : String(r ?? '') };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    args: [code],
  });

  if (!result?.result?.ok) return fail(result?.result?.error ?? 'evaluate failed');
  return ok({ result: result.result.result });
}

async function cmdScroll({ x = 0, y = 500, selector = null }) {
  const tab = await getActiveTab();
  await runInTab(tab.id, (sel, dx, dy) => {
    if (sel) {
      document.querySelector(sel)?.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    } else {
      window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    }
  }, [selector, x, y]);
  return ok({});
}

async function cmdWaitFor({ selector, timeout = 10000 }) {
  const tab = await getActiveTab();
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const found = await runInTab(tab.id, (sel) => !!document.querySelector(sel), [selector]);
    if (found) return ok({ found: true, selector });
    await new Promise(r => setTimeout(r, 400));
  }

  return fail(`Timeout waiting for: ${selector}`);
}

async function cmdFillForm({ fields }) {
  const tab = await getActiveTab();
  const results = [];

  for (const { selector, value } of fields) {
    const result = await runInTab(tab.id, (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, selector: sel };
      el.focus();
      if (el.tagName === 'SELECT') {
        el.value = val;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, selector: sel, value: el.value };
    }, [selector, value]);
    results.push(result);
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length) return fail(`Could not fill: ${failed.map(r => r.selector).join(', ')}`);
  return ok({ filled: results.length });
}

async function cmdGetInfo() {
  const tab = await getActiveTab();
  return ok({ id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId });
}

async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  return ok(tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })));
}

async function cmdSwitchTab({ tabId }) {
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  return ok({ id: tab.id, url: tab.url, title: tab.title });
}

async function cmdNewTab({ url } = {}) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank' });
  if (url) await waitForLoad(tab.id);
  return ok({ id: tab.id, url: tab.url, title: tab.title });
}

async function cmdCloseTab({ tabId } = {}) {
  const id = tabId ?? (await getActiveTab()).id;
  await chrome.tabs.remove(id);
  return ok({ closed: id });
}

async function cmdHistory(direction) {
  const tab = await getActiveTab();
  await runInTab(tab.id, (dir) => {
    if (dir === 'back') window.history.back();
    else window.history.forward();
  }, [direction]);
  await new Promise(r => setTimeout(r, 300));
  return ok({});
}

async function cmdReload() {
  const tab = await getActiveTab();
  await chrome.tabs.reload(tab.id);
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return ok({ url: updated.url, title: updated.title });
}

// ─── Keepalive alarm (MV3 service workers can sleep) ─────────────────────────

chrome.alarms.create('nexus-keepalive', { periodInMinutes: 0.4 }); // ~24s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nexus-keepalive') {
    if (!connected) connect();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
