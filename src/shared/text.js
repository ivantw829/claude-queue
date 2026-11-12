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

  // 去除常見 Markdown 標記（訊息氣泡會把它們渲染掉）並移除所有空白，只留內容字元
  function stripMarkdown(text) {
    return normalizeForCompare(text)
      .replace(/```[^\n]*\n?/g, '')
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/[*_~`]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, '');
  }

  /** 渲染後的訊息氣泡是否就是這段原文（先比原文開頭，再比去除格式後的開頭） */
  function renderedMatches(rendered, original, len = 200) {
    if (textStartsMatch(rendered, original, len)) return true;
    const r = stripMarkdown(rendered);
    const o = stripMarkdown(original);
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

  /** 檔案大小：1.2 MB / 340 KB / 12 B */
  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(v >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  }

  CQ.text = {
    formatBytes,
    normalizeForCompare,
    sameText,
    textStartsMatch,
    stripMarkdown,
    renderedMatches,
    conversationKey,
    isNewChatUrl,
    uuid,
    preview
  };
})(globalThis);
