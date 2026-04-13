/**
 * NEXUS Bridge — Chrome Extension Background Service Worker
 * Universal browser automation: CSS selectors, aria-label, placeholder, label text,
 * cross-framework event sequences (React/Vue/Angular/Svelte), SPA navigation,
 * keyboard simulation, cookie banner dismissal, form field discovery, and more.
 */

const WS_URL = 'ws://127.0.0.1:9338';
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 20000;

let ws = null;
let connected = false;
let pingTimer = null;
let reconnectTimer = null; // persistent reconnect interval — keeps SW alive

// ─── Connection management ────────────────────────────────────────────────────

function startReconnectLoop() {
  if (reconnectTimer) return; // already running
  reconnectTimer = setInterval(() => {
    if (!connected) connect();
  }, RECONNECT_DELAY_MS);
}

function stopReconnectLoop() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    connected = true;
    updateBadge(true);
    chrome.storage.local.set({ connected: true, connectedAt: Date.now(), commandCount: 0, recentCommands: [] });
    startPing();
    console.log('[NEXUS] Connected to bridge');
  });

  ws.addEventListener('close', () => {
    connected = false;
    updateBadge(false);
    chrome.storage.local.set({ connected: false });
    stopPing();
    console.log('[NEXUS] Disconnected — reconnect loop will retry');
  });

  ws.addEventListener('error', () => {
    // close event fires next and handles reconnection
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'pong') return; // heartbeat response

    if (msg.type === 'command') {
      const result = await handleCommand(msg);
      ws.send(JSON.stringify({ id: msg.id, type: 'response', ...result }));

      // Track command stats for popup
      chrome.storage.local.get(['commandCount', 'recentCommands'], (data) => {
        const count  = (data.commandCount  ?? 0) + 1;
        const recent = (data.recentCommands ?? []).slice(-19);
        recent.push({ action: msg.action, ts: Date.now(), success: !!result.success });
        chrome.storage.local.set({ commandCount: count, recentCommands: recent });
      });
    }
  });
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
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
      case 'navigate':          return await cmdNavigate(params);
      case 'click':             return await cmdClick(params);
      case 'hover':             return await cmdHover(params);
      case 'type':              return await cmdType(params);
      case 'press_key':         return await cmdPressKey(params);
      case 'clear':             return await cmdClear(params);
      case 'select':            return await cmdSelect(params);
      case 'extract':           return await cmdExtract(params);
      case 'screenshot':        return await cmdScreenshot();
      case 'evaluate':          return await cmdEvaluate(params);
      case 'scroll':            return await cmdScroll(params);
      case 'wait_for':          return await cmdWaitFor(params);
      case 'wait_for_url':      return await cmdWaitForUrl(params);
      case 'fill_form':         return await cmdFillForm(params);
      case 'dismiss_cookies':   return await cmdDismissCookies();
      case 'suppress_dialogs':  return await cmdSuppressDialogs();
      case 'get_info':          return await cmdGetInfo();
      case 'get_tabs':          return await cmdGetTabs();
      case 'switch_tab':        return await cmdSwitchTab(params);
      case 'new_tab':           return await cmdNewTab(params);
      case 'close_tab':         return await cmdCloseTab(params);
      case 'back':              return await cmdHistory('back');
      case 'forward':           return await cmdHistory('forward');
      case 'reload':            return await cmdReload();
      default:                  return fail(`Unknown action: ${action}`);
    }
  } catch (err) {
    return fail(err.message ?? String(err));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data) { return { success: true, data }; }
function fail(error) { return { success: false, error }; }

async function getActiveTab() {
  // Try active tab in current window first
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab;
  // Fall back to any tab in any window
  const allTabs = await chrome.tabs.query({});
  if (allTabs.length > 0) return allTabs[0];
  throw new Error('No active tab');
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
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, timeoutMs);
  });
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN', // page JS context — required for execCommand, native setters, React
    func,
    args,
  });
  if (result?.result instanceof Error) throw result.result;
  return result?.result;
}

// ─── Command implementations ──────────────────────────────────────────────────

/**
 * Navigate to URL with SPA settle time and optional selector wait.
 */
async function cmdNavigate({ url, waitForSelector = null }) {
  let tab;
  try { tab = await getActiveTab(); } catch (e) { tab = null; }
  if (!tab) {
    // No tab at all — open a new one
    tab = await chrome.tabs.create({ url });
    await waitForLoad(tab.id);
    await new Promise(r => setTimeout(r, 800));
    if (waitForSelector) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const found = await runInTab(tab.id, (sel) => !!document.querySelector(sel), [waitForSelector]);
        if (found) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    const created = await chrome.tabs.get(tab.id);
    return ok({ url: created.url, title: created.title });
  }
  await chrome.tabs.update(tab.id, { url });
  await waitForLoad(tab.id);
  // Extra settle time for SPAs that render JS after the load event fires
  await new Promise(r => setTimeout(r, 800));

  if (waitForSelector) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await runInTab(tab.id, (sel) => !!document.querySelector(sel), [waitForSelector]);
      if (found) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const updated = await chrome.tabs.get(tab.id);
  return ok({ url: updated.url, title: updated.title });
}

/**
 * Click an element — by CSS selector, aria-label, placeholder, label text, or visible text.
 * Fires change event for checkboxes/radios. Auto-dismisses cookie banners if requested.
 * Suppresses native dialog boxes (alert/confirm/prompt) that would freeze automation.
 */
async function cmdClick({ selector = null, text = null, index = 0, dismissCookies = false, suppressDialogs = false }) {
  const tab = await getActiveTab();

  // Override native dialogs before clicking — alert/confirm freeze executeScript
  if (suppressDialogs) {
    await runInTab(tab.id, () => {
      window._nexusAlertOrig = window.alert;
      window._nexusConfirmOrig = window.confirm;
      window._nexusPromptOrig = window.prompt;
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => '';
    });
  }

  if (dismissCookies) {
    await runInTab(tab.id, () => {
      const sels = [
        '#onetrust-accept-btn-handler', '.cc-btn.cc-allow',
        '[data-testid="accept-cookies"]', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        'button[id*="accept-cookie"]', 'button[id*="cookie-accept"]',
        '[aria-label="Accept cookies"]', '[aria-label="Accept all cookies"]',
      ];
      for (const s of sels) { try { const b = document.querySelector(s); if (b) { b.click(); return true; } } catch(e) {} }
      return false;
    });
  }

  const result = await runInTab(tab.id, (sel, txt, idx) => {
    // Universal element finder: CSS → aria-label → button/link text
    function $find(q) {
      if (!q) return null;
      // 1. CSS selector (with index support)
      try {
        const els = document.querySelectorAll(q);
        if (els.length) return els[idx] ?? els[0];
      } catch(e) {}
      // 2. aria-label (exact then partial)
      for (const el of document.querySelectorAll('[aria-label]')) {
        if (el.getAttribute('aria-label').toLowerCase() === q.toLowerCase()) return el;
      }
      for (const el of document.querySelectorAll('[aria-label]')) {
        if (el.getAttribute('aria-label').toLowerCase().includes(q.toLowerCase())) return el;
      }
      // 3. Clickable elements by text content
      const clickable = 'a,button,[role="button"],input[type="submit"],input[type="button"],label,[onclick]';
      for (const el of document.querySelectorAll(clickable)) {
        if (el.textContent?.trim().toLowerCase() === q.toLowerCase()) return el;
      }
      for (const el of document.querySelectorAll(clickable)) {
        if (el.textContent?.trim().toLowerCase().includes(q.toLowerCase())) return el;
      }
      return null;
    }

    let el;
    if (sel) {
      el = $find(sel);
    } else if (txt) {
      const clickable = 'a,button,[role="button"],input[type="submit"],input[type="button"],label,[onclick]';
      el = Array.from(document.querySelectorAll(clickable))
        .find(e => e.textContent?.trim().toLowerCase().includes(txt.toLowerCase()));
    }
    if (!el) return { ok: false, error: `Element not found: ${sel ?? txt}` };

    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.click();

    // Checkboxes and radios need an explicit change event
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: true, tag: el.tagName, type: el.type ?? '', text: el.textContent?.trim().slice(0, 80) };
  }, [selector, text, index]);

  if (!result?.ok) return fail(result?.error ?? 'click failed');
  return ok(result);
}

/**
 * Hover over an element — fires mouseenter/mouseover/mousemove.
 * Essential for dropdown menus and tooltips.
 */
async function cmdHover({ selector }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel) => {
    function $find(q) {
      try { const r = document.querySelector(q); if (r) return r; } catch(e) {}
      for (const el of document.querySelectorAll('[aria-label]')) {
        if (el.getAttribute('aria-label').toLowerCase().includes(q.toLowerCase())) return el;
      }
      return null;
    }
    const el = $find(sel);
    if (!el) return { ok: false, error: `Element not found: ${sel}` };

    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return { ok: true, tag: el.tagName };
  }, [selector]);

  if (!result?.ok) return fail(result?.error ?? 'hover failed');
  return ok(result);
}

/**
 * Press a keyboard key on an element or the focused element.
 * Works for Enter (submit), Tab (focus next), Escape, arrow keys, etc.
 */
async function cmdPressKey({ key, selector = null }) {
  const tab = await getActiveTab();

  const KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, ' ': 32, Space: 32,
    Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116,
  };

  const result = await runInTab(tab.id, (sel, k, keyCodes) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { ok: false, error: `Element not found: ${sel}` };

    const keyCode = keyCodes[k] ?? k.charCodeAt(0);
    const opts = { key: k, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));

    // For Tab: move focus to the next focusable element
    if (k === 'Tab') {
      const focusable = Array.from(document.querySelectorAll(
        'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),' +
        'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
      ));
      const idx = focusable.indexOf(document.activeElement);
      if (idx >= 0 && idx + 1 < focusable.length) focusable[idx + 1].focus();
    }

    return { ok: true, key: k };
  }, [selector, key, KEY_CODES]);

  if (!result?.ok) return fail(result?.error ?? 'press_key failed');
  return ok(result);
}

/**
 * Type text into an input field — universal: CSS, aria-label, placeholder, label.
 * Uses React-compatible native setter. Fires beforeinput + input + change for all frameworks.
 */
async function cmdType({ selector = null, text, clear = false }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel, txt, clr) => {
    let step = 'find-element';
    try {
      // Universal finder: CSS → aria-label → placeholder → name → label text
      function $find(q) {
        if (!q) return document.activeElement;
        try { const r = document.querySelector(q); if (r) return r; } catch(e) {}
        for (const el of document.querySelectorAll('[aria-label]')) {
          if (el.getAttribute('aria-label').toLowerCase().includes(q.toLowerCase())) return el;
        }
        for (const el of document.querySelectorAll('[placeholder]')) {
          if (el.getAttribute('placeholder').toLowerCase().includes(q.toLowerCase())) return el;
        }
        try { const n = document.querySelector('[name="' + CSS.escape(q) + '"]'); if (n) return n; } catch(e) {}
        for (const lbl of document.querySelectorAll('label')) {
          if (lbl.textContent.trim().toLowerCase().includes(q.toLowerCase())) {
            if (lbl.htmlFor) { const t = document.getElementById(lbl.htmlFor); if (t) return t; }
            const inner = lbl.querySelector('input,textarea,select,[contenteditable="true"]');
            if (inner) return inner;
          }
        }
        return null;
      }

      let el = $find(sel);
      if (!el) return { ok: false, error: `Element not found: ${sel}` };

      step = 'drill-into-container';
      if (!el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
        const inner = el.querySelector('[contenteditable="true"],[role="textbox"],input,textarea');
        if (inner) el = inner;
      }

      step = 'focus';
      el.focus();
      const finalTag = el.tagName;
      const finalEditable = el.isContentEditable;

      if (finalEditable) {
        step = 'contenteditable-click';
        el.click();
        if (clr) {
          step = 'contenteditable-clear';
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
        step = 'contenteditable-insert';
        document.execCommand('insertText', false, txt);
        // Fallback if execCommand was blocked (some CSP configs)
        if (!el.textContent.includes(txt.slice(0, 10))) {
          step = 'contenteditable-fallback';
          if (clr) el.textContent = '';
          el.textContent += txt;
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: txt, bubbles: true }));
        }
      } else if (finalTag === 'SELECT') {
        step = 'select-value';
        el.value = txt;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // INPUT or TEXTAREA — React/Vue/Angular/Svelte compatible
        step = 'beforeinput-event';
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: txt, bubbles: true, cancelable: true }));
        step = 'native-setter';
        const proto = finalTag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const current = clr ? '' : el.value;
        if (setter) setter.call(el, current + txt); else el.value = current + txt;
        step = 'input-event';
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: txt, bubbles: true }));
        step = 'change-event';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, finalTag, finalEditable };
    } catch(e) {
      return { ok: false, error: `[${step}] ${String(e)}` };
    }
  }, [selector, text, clear]);

  if (!result?.ok) return fail(result?.error ?? 'type failed');
  return ok({ typed: text });
}

/**
 * Clear a field — works on inputs, textareas, and contenteditables.
 * Uses React-compatible native setter.
 */
async function cmdClear({ selector }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { ok: false, error: `Element not found: ${sel}` };
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContent', bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true };
  }, [selector]);

  if (!result?.ok) return fail(result?.error ?? 'clear failed');
  return ok({});
}

async function cmdSelect({ selector, value }) {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: `Select not found: ${sel}` };
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: el.value };
  }, [selector, value]);

  if (!result?.ok) return fail(result?.error ?? 'select failed');
  return ok(result);
}

/**
 * Extract content from the current tab.
 * - No selector: full page text, links, headings
 * - With selector: extract element text or attribute
 * - mode: 'form' — discover all form fields with their selectors and labels
 */
async function cmdExtract({ selector = null, attribute = null, all = false, mode = null }) {
  const tab = await getActiveTab();
  const data = await runInTab(tab.id, (sel, attr, getAllResults, extractMode) => {
    // Form discovery mode — returns all fillable fields with their best selectors
    if (extractMode === 'form') {
      const fields = [];
      const seen = new Set();
      document.querySelectorAll('input,textarea,select,[contenteditable="true"]').forEach((el, i) => {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'reset') return;
        const id = el.id ?? '';
        const name = el.name ?? '';
        // Best selector: id > name > nth-of-type
        let bestSel = id ? '#' + id : name ? '[name="' + name + '"]' : el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')';
        if (seen.has(bestSel)) bestSel = el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')';
        seen.add(bestSel);

        const labelEl = el.labels?.[0] ?? document.querySelector('[for="' + id + '"]');
        const labelText = labelEl?.textContent?.trim()
          ?? el.getAttribute('aria-label')
          ?? el.placeholder
          ?? el.getAttribute('name')
          ?? '';

        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type ?? (el.isContentEditable ? 'contenteditable' : ''),
          selector: bestSel,
          label: labelText,
          placeholder: el.placeholder ?? '',
          required: el.required ?? false,
          value: el.value ?? (el.isContentEditable ? el.textContent?.slice(0, 100) : '') ?? '',
        });
      });
      return { fields, count: fields.length, url: location.href };
    }

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
      attr === 'html'  ? el.innerHTML
      : attr           ? (el.getAttribute(attr) ?? el.textContent?.trim())
      : el.textContent?.trim();

    return getAllResults ? els.map(extract) : extract(els[0]);
  }, [selector, attribute, all, mode]);

  if (data === null) return fail(`No element matching: ${selector}`);
  return ok(data);
}

async function cmdScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  const base64 = dataUrl.split(',')[1] ?? dataUrl;
  return ok({ base64, mimeType: 'image/png' });
}

async function cmdEvaluate({ code }) {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (c) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(c);
        const r = fn();
        return { ok: true, result: typeof r === 'object' ? JSON.stringify(r) : String(r ?? '') };
      } catch(e) {
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

/**
 * Wait for a selector with configurable mode:
 * - 'present' (default) — element exists in DOM
 * - 'visible'           — element is visible (has non-zero size, not display:none)
 * - 'text'              — element contains expected text
 * - 'gone'              — element is no longer in DOM
 */
async function cmdWaitFor({ selector, timeout = 10000, mode = 'present', text = null }) {
  const tab = await getActiveTab();
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const found = await runInTab(tab.id, (sel, m, expectedText) => {
      const el = document.querySelector(sel);
      if (m === 'gone') return !el;
      if (!el) return false;
      if (m === 'visible') {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }
      if (m === 'text' && expectedText) {
        return (el.textContent ?? '').includes(expectedText);
      }
      return true; // 'present'
    }, [selector, mode, text]);

    if (found) return ok({ found: true, selector, mode });
    await new Promise(r => setTimeout(r, 400));
  }

  return fail(`Timeout waiting for "${selector}" [mode: ${mode}]`);
}

/**
 * Wait for the active tab URL to contain a pattern.
 * Use after clicks that trigger navigation or SPA route changes.
 */
async function cmdWaitForUrl({ pattern, timeout = 10000 }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await getActiveTab();
    if (tab.url && tab.url.includes(pattern)) {
      return ok({ url: tab.url, matched: pattern });
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return fail(`Timeout waiting for URL containing: ${pattern}`);
}

/**
 * Fill multiple form fields in one call.
 * Selectors can be CSS, aria-label, placeholder text, or label text.
 * Uses React/Vue/Angular-compatible native setter + full event sequence.
 */
async function cmdFillForm({ fields }) {
  const tab = await getActiveTab();
  const results = [];

  for (const { selector, value } of fields) {
    const result = await runInTab(tab.id, (sel, val) => {
      let step = 'find-element';
      try {
        // Universal finder: CSS → aria-label → placeholder → name attr → label text
        function $find(q) {
          try { const r = document.querySelector(q); if (r) return r; } catch(e) {}
          for (const el of document.querySelectorAll('[aria-label]')) {
            if (el.getAttribute('aria-label').toLowerCase().includes(q.toLowerCase())) return el;
          }
          for (const el of document.querySelectorAll('[placeholder]')) {
            if (el.getAttribute('placeholder').toLowerCase().includes(q.toLowerCase())) return el;
          }
          try { const n = document.querySelector('[name="' + CSS.escape(q) + '"]'); if (n) return n; } catch(e) {}
          for (const lbl of document.querySelectorAll('label')) {
            if (lbl.textContent.trim().toLowerCase().includes(q.toLowerCase())) {
              if (lbl.htmlFor) { const t = document.getElementById(lbl.htmlFor); if (t) return t; }
              const inner = lbl.querySelector('input,textarea,select,[contenteditable="true"]');
              if (inner) return inner;
            }
          }
          return null;
        }

        let el = $find(sel);
        if (!el) return { ok: false, selector: sel, error: 'not found' };

        step = 'drill-into-container';
        if (!el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
          const inner = el.querySelector('[contenteditable="true"],[role="textbox"],input,textarea');
          if (inner) el = inner;
        }

        step = 'focus';
        el.focus();
        const finalTag = el.tagName;
        const finalEditable = el.isContentEditable;

        if (finalTag === 'SELECT') {
          step = 'select-value';
          el.value = val;
          step = 'select-change-event';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (finalEditable) {
          // Rich text / contenteditable (Gmail body, Notion, etc.)
          step = 'contenteditable-click';
          el.click();
          step = 'contenteditable-clear';
          document.execCommand('selectAll', false, null);
          step = 'contenteditable-insert';
          document.execCommand('insertText', false, val);
          if (!el.textContent.includes(val.slice(0, 20))) {
            step = 'contenteditable-fallback';
            el.textContent = val;
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: val, bubbles: true }));
          }
        } else {
          // INPUT or TEXTAREA — React/Vue/Angular/Svelte compatible
          step = 'beforeinput-event';
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: val, bubbles: true, cancelable: true }));
          step = 'native-setter';
          const proto = finalTag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          step = 'input-event';
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: val, bubbles: true }));
          step = 'change-event';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return { ok: true, selector: sel, finalTag, finalEditable };
      } catch(e) {
        return { ok: false, selector: sel, error: `[${step}] ${String(e)}` };
      }
    }, [selector, value]);
    results.push(result);
  }

  const failed = results.filter(r => !r?.ok);
  if (failed.length) {
    return fail(`Could not fill: ${failed.map(r => r?.selector ?? '?').join(', ')} — ${failed.map(r => r?.error ?? '').join('; ')}`);
  }
  return ok({ filled: results.length });
}

/**
 * Suppress native browser dialogs (alert/confirm/prompt) that would block automation.
 * Call before clicking elements that might trigger JS dialogs.
 * confirm() returns true, prompt() returns empty string.
 */
async function cmdSuppressDialogs() {
  const tab = await getActiveTab();
  await runInTab(tab.id, () => {
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => '';
  });
  return ok({ suppressed: true });
}

/**
 * Dismiss cookie consent banners.
 * Tries known selector patterns, then falls back to button text matching.
 */
async function cmdDismissCookies() {
  const tab = await getActiveTab();
  const result = await runInTab(tab.id, () => {
    const selectorList = [
      '#onetrust-accept-btn-handler',
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '.cc-btn.cc-allow',
      '[data-testid="accept-cookies"]',
      '[data-testid="cookie-policy-dialog-accept-button"]',
      'button[id*="accept-cookie"]',
      'button[id*="cookie-accept"]',
      'button[class*="accept-cookie"]',
      'button[class*="cookie-accept"]',
      'button[id*="accept-all"]',
      '[aria-label="Accept cookies"]',
      '[aria-label="Accept all cookies"]',
      '[aria-label="Allow all cookies"]',
      'button[id*="agree"]',
      '#cookie-consent button',
      '.cookie-notice button',
      '.gdpr-banner button',
    ];

    for (const sel of selectorList) {
      try {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) { btn.click(); return { ok: true, method: sel }; }
      } catch(e) {}
    }

    // Text-based fallback
    const acceptWords = new Set(['accept', 'accept all', 'allow all', 'i agree', 'agree', 'ok', 'got it', "that's ok", 'allow cookies', 'accept cookies']);
    const btn = Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .find(el => el.offsetParent !== null && acceptWords.has(el.textContent?.trim().toLowerCase()));
    if (btn) { btn.click(); return { ok: true, method: 'text-match:' + btn.textContent?.trim() }; }

    return { ok: false, method: null };
  });

  return ok({ dismissed: result?.ok ?? false, method: result?.method ?? null });
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
  await new Promise(r => setTimeout(r, 500));
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
    startReconnectLoop();
    if (!connected) connect();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
startReconnectLoop(); // persistent 3s interval keeps SW alive and retries on disconnect
