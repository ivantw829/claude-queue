/*
 * 文字與網址工具。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});

  // 用於比對「是不是同一段文字」：統一換行、去除多餘空白
  function normalizeForCompare(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
  }

  function sameText(a, b) {
    return normalizeForCompare(a) === normalizeForCompare(b);
  }

  // 只比對開頭（訊息渲染後可能被截斷或加上格式）
  function textStartsMatch(rendered, original, len = 200) {
    const r = normalizeForCompare(rendered).replace(/\s+/g, ' ');
    const o = normalizeForCompare(original).replace(/\s+/g, ' ');
    if (!r || !o) return false;
    const n = Math.min(len, o.length);
    return r.slice(0, n) === o.slice(0, n);
  }

  // 對話識別：/chat/<uuid>、/project/<uuid>、/new。忽略 query 與 hash。
  function conversationKey(url) {
    try {
      const u = new URL(url, 'https://claude.ai');
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (_) {
      return String(url || '');
    }
  }

  function isNewChatUrl(url) {
    try {
      const p = new URL(url, 'https://claude.ai').pathname;
      return p === '/new' || p === '/' || /^\/project\/[^/]+\/?$/.test(p);
    } catch (_) {
      return false;
    }
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function preview(text, n = 80) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  CQ.text = { normalizeForCompare, sameText, textStartsMatch, conversationKey, isNewChatUrl, uuid, preview };
})(globalThis);
