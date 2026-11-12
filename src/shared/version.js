/*
 * 版本號比較與相關網址。SW、popup、options 共用。
 *
 * 新版本檢查只讀取 GitHub main 分支上的 manifest.json（不帶參數、不送出任何資料）。
 * 所以「push 到 main 並提高 manifest 版本號」就等於對所有從 GitHub 安裝的使用者發布更新通知。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});

  const GUIDE_URL = 'https://me.asdtw.org/articles/claude-queue-guide.html';

  /** Chrome 的版本號格式：1–4 段、以點分隔的整數 */
  function parse(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!/^\d+(\.\d+){0,3}$/.test(s)) return null;
    return s.split('.').map(Number);
  }

  function isValid(v) {
    return parse(v) !== null;
  }

  /** a > b → 1，a < b → -1，相同或無法比較 → 0（"0.10.0" 比 "0.9.0" 新） */
  function compare(a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return 0;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  CQ.version = Object.freeze({
    parse,
    isValid,
    compare,
    GUIDE_URL,
    UPDATE_GUIDE_URL: GUIDE_URL + '#s12', // 教學第 12 節「更新到新版本」
    MANIFEST_URL: 'https://raw.githubusercontent.com/ivantw829/claude-queue/main/manifest.json',
    CHANGES_URL: 'https://github.com/ivantw829/claude-queue/commits/main',
    CHECK_INTERVAL_MS: 24 * 60 * 60 * 1000
  });
})(globalThis);
