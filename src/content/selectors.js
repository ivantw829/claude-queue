/*
 * ⚠️ claude.ai 改版時最常需要修改的檔案之一。
 *
 * 所有 DOM 選擇器集中在這裡。每個項目是「依序嘗試」的候選清單：
 * 第一個是目前（2026 年）觀察到的主要選擇器，其餘是備用。
 * 找不到時請用 require()，它會記錄錯誤並在頁面提示「介面可能已改版」，不會靜默失敗。
 *
 * 修正方式：在 claude.ai 開 DevTools → Elements，找到對應元素，
 * 把新的選擇器加到該清單最前面即可。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('selectors');

  const SELECTORS = {
    // 聊天輸入框（ProseMirror / tiptap 富文字編輯器）
    editor: [
      'div.ProseMirror[contenteditable="true"]',
      '[data-testid="chat-input"] [contenteditable="true"]',
      '[data-testid="chat-input"][contenteditable="true"]',
      'fieldset [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ],

    // 包住輸入框、附件、送出按鈕的容器（用來限縮其他選擇器的搜尋範圍）
    composer: [
      'fieldset:has(div.ProseMirror)',
      '[data-testid="chat-input-container"]',
      'form:has([contenteditable="true"])',
      'div:has(> div > div.ProseMirror)'
    ],

    // 送出按鈕（aria-label 可能隨介面語言變動，忽略大小寫）
    sendButton: [
      'button[aria-label="Send message" i]',
      'button[aria-label="Send" i]',
      'button[aria-label="傳送訊息"]',
      'button[aria-label="發送訊息"]',
      'button[aria-label="送出訊息"]',
      'button[aria-label="傳送"]',
      'button[data-testid="send-button"]',
      'button[type="submit"]'
    ],

    // 回應生成中的「停止」按鈕
    stopButton: [
      'button[aria-label="Stop response" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      'button[data-testid="stop-button"]'
    ],

    // 輸入框區域中的附件 / 圖片縮圖（偵測到即放行、不排隊）
    attachment: [
      '[data-testid="file-thumbnail"]',
      '[data-testid*="attachment" i]',
      '[data-testid*="file-preview" i]',
      'img[alt][src^="blob:"]',
      'button[aria-label^="Remove" i]',
      'button[aria-label*="移除"]'
    ],

    // 對話中「使用者的訊息」氣泡（用於確認送出成功、偵測重複）
    userMessage: [
      '[data-testid="user-message"]',
      '[data-message-author-role="user"]',
      '.font-user-message'
    ],

    // 可能顯示「已達上限」提示的區域（備援偵測用）。
    // 只掃描這些區域，不掃描整頁，避免讀到聊天內容。
    limitBanner: [
      '[data-testid*="limit" i]',
      '[data-testid*="rate-limit" i]',
      '[role="alert"]',
      '[role="status"]',
      'fieldset ~ div',
      'fieldset > div:not(:has(.ProseMirror))'
    ]
  };

  const reported = new Set();
  let missingHandler = null;

  function onMissing(fn) {
    missingHandler = fn;
  }

  function list(name) {
    const l = SELECTORS[name];
    if (!l) throw new Error(`Unknown selector group: ${name}`);
    return l;
  }

  function safeQuery(scope, sel, all) {
    try {
      return all ? Array.from(scope.querySelectorAll(sel)) : scope.querySelector(sel);
    } catch (e) {
      // :has() 等語法在舊版瀏覽器可能不支援，跳過該候選
      log.warn('invalid selector', { sel, error: e.message });
      return all ? [] : null;
    }
  }

  // 回傳第一個找到的元素，找不到回傳 null（不報錯，用於「可有可無」的檢查）
  function find(name, scope = document) {
    for (const sel of list(name)) {
      const el = safeQuery(scope, sel, false);
      if (el) return el;
    }
    return null;
  }

  // 回傳第一個「有結果」的候選所找到的全部元素
  function findAll(name, scope = document) {
    for (const sel of list(name)) {
      const els = safeQuery(scope, sel, true);
      if (els.length) return els;
    }
    return [];
  }

  // 必要元素：找不到就明確報錯並提示使用者
  function require(name, scope = document) {
    const el = find(name, scope);
    if (!el) reportMissing(name);
    return el;
  }

  function reportMissing(name) {
    log.error(`selector not found: ${name}`, { tried: list(name) });
    if (!reported.has(name)) {
      reported.add(name);
      if (missingHandler) missingHandler(name);
    }
  }

  // 找出事件目標所屬的輸入框
  function closestEditor(target) {
    if (!target || !target.closest) return null;
    for (const sel of SELECTORS.editor) {
      try {
        const el = target.closest(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function closestSendButton(target) {
    if (!target || !target.closest) return null;
    for (const sel of SELECTORS.sendButton) {
      try {
        const el = target.closest(sel);
        if (el) {
          // button[type=submit] 太泛，必須在輸入框所屬區域內
          if (sel === 'button[type="submit"]' && !getComposer()?.contains(el)) continue;
          return el;
        }
      } catch (_) {}
    }
    return null;
  }

  // 以輸入框為基準往上找 composer；找不到就用 editor 的祖先
  function getComposer() {
    const editor = find('editor');
    if (!editor) return null;
    for (const sel of SELECTORS.composer) {
      try {
        const c = editor.closest(sel);
        if (c) return c;
      } catch (_) {}
    }
    // 備援：往上 4 層
    let el = editor;
    for (let i = 0; i < 4 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function getSendButton() {
    const composer = getComposer();
    // 優先在 composer 內找，避免抓到頁面其他按鈕
    return (composer && find('sendButton', composer)) || find('sendButton');
  }

  CQ.selectors = {
    SELECTORS,
    find,
    findAll,
    require,
    reportMissing,
    onMissing,
    closestEditor,
    closestSendButton,
    getComposer,
    getSendButton
  };
})(globalThis);
