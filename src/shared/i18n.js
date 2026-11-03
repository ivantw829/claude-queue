/*
 * i18n 包裝：文字放在 _locales/<locale>/messages.json，
 * 以 {name} 形式的具名佔位符在這裡替換（避免 chrome.i18n 的 $ 佔位符語法）。
 * 新增語系：複製 _locales/zh_TW/messages.json 到新資料夾並翻譯即可。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});

  function t(key, subs) {
    let msg = '';
    try {
      msg = chrome.i18n.getMessage(key) || '';
    } catch (_) {
      msg = '';
    }
    if (!msg) msg = key; // 找不到時顯示 key，方便發現漏翻
    if (subs) {
      msg = msg.replace(/\{(\w+)\}/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(subs, name) ? String(subs[name]) : m
      );
    }
    return msg;
  }

  // 套用到 HTML：data-i18n（textContent）、data-i18n-title、data-i18n-placeholder
  function applyI18n(doc) {
    doc.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    doc.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    doc.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // HH:MM；若不是今天則加上 M/D
  function formatClock(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    const now = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  // 倒數：1 天 2:03:04 / 2:03:04 / 3:04
  function formatCountdown(ms) {
    if (ms == null || isNaN(ms)) return '--';
    if (ms <= 0) return t('countdownDone');
    const s = Math.floor(ms / 1000);
    const days = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const core = h > 0 || days > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
    return days > 0 ? t('countdownDays', { days, rest: core }) : core;
  }

  CQ.i18n = { t, applyI18n, formatClock, formatCountdown };
  CQ.t = t;
})(globalThis);
