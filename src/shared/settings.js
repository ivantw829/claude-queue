/*
 * 設定讀取與快取。各執行環境（SW / content / popup / options）各自持有一份快取，
 * 透過 chrome.storage.onChanged 保持同步。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const KEY = CQ.STORAGE_KEYS.SETTINGS;

  const DEFAULTS = Object.freeze({
    autoSend: false, // 重置後自動送出（不需確認）
    autoReset: false, // 自動重設：工作階段歸零時送出一則訊息，讓下一個工作階段馬上開始倒數
    autoResetText: 'Hello World!', // 自動重設送出的文字（可在設定頁修改）
    notifications: true, // 桌面通知
    pollMinutes: 2, // 用量輪詢頻率（分鐘）
    debugLog: false, // 記錄 debug log
    debugSimulate: false, // 模擬「用量已滿」
    debugSimulateMinutes: 2, // 模擬多久後重置
    debugSimulateUntil: 0 // 模擬的重置時間戳
  });

  let cache = { ...DEFAULTS };
  const listeners = new Set();

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    s.pollMinutes = Math.min(30, Math.max(1, Number(s.pollMinutes) || DEFAULTS.pollMinutes));
    s.debugSimulateMinutes = Math.min(600, Math.max(1, Number(s.debugSimulateMinutes) || 2));
    s.autoResetText = String(s.autoResetText || '').trim().slice(0, 200) || DEFAULTS.autoResetText;
    return s;
  }

  async function load() {
    const data = await chrome.storage.local.get(KEY);
    cache = normalize(data[KEY]);
    return cache;
  }

  function get() {
    return cache;
  }

  async function update(patch) {
    const current = await load();
    const next = normalize({ ...current, ...patch });
    await chrome.storage.local.set({ [KEY]: next });
    cache = next;
    return next;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      cache = normalize(changes[KEY].newValue);
      listeners.forEach((fn) => {
        try {
          fn(cache);
        } catch (_) {}
      });
    });
  } catch (_) {}

  const ready = load().catch(() => cache);

  CQ.settings = { DEFAULTS, load, get, update, onChange, ready };
})(globalThis);
