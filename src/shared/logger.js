/*
 * Debug logger。只在 options 開啟「debug log」時記錄。
 * - 一律輸出到該環境的 console（前綴 [ClaudeQueue:<context>]）
 * - 寫入 chrome.storage.local 的環狀緩衝（最多 500 筆），供 options 頁面複製回報
 * - 非 service worker 的環境把 log 傳給 SW 統一寫入，避免多個分頁同時寫入互相覆蓋
 *
 * 隱私：呼叫端只能記錄 id、長度、狀態等中繼資料，不可傳入訊息內文。
 * error 等級的 log 不受開關限制，一律輸出到 console（但同樣受開關控制是否保存）。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  let sink = null; // SW 會設定成直接寫入 storage 的函式

  function setSink(fn) {
    sink = fn;
  }

  function safeData(data) {
    if (data === undefined) return undefined;
    try {
      if (data instanceof Error) return { name: data.name, message: data.message };
      return JSON.parse(JSON.stringify(data));
    } catch (_) {
      return String(data);
    }
  }

  function createLogger(context) {
    function write(level, msg, data) {
      const enabled = CQ.settings && CQ.settings.get().debugLog;
      if (!enabled && level !== 'error') return;
      const prefix = `[ClaudeQueue:${context}]`;
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      if (data !== undefined) fn(prefix, msg, data);
      else fn(prefix, msg);
      if (!enabled) return;

      const entry = { ts: Date.now(), level, context, msg: String(msg), data: safeData(data) };
      if (sink) {
        sink(entry);
      } else {
        try {
          chrome.runtime.sendMessage({ type: CQ.MSG.LOG, entry }).catch(() => {});
        } catch (_) {
          // 擴充功能重新載入後舊 content script 的 runtime 失效，忽略
        }
      }
    }
    return {
      debug: (m, d) => write('debug', m, d),
      info: (m, d) => write('info', m, d),
      warn: (m, d) => write('warn', m, d),
      error: (m, d) => write('error', m, d)
    };
  }

  CQ.logger = { createLogger, setSink };
})(globalThis);
