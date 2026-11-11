/*
 * 與 service worker 溝通，以及「按下頁面上的送出按鈕、確認訊息出現在對話中」。
 * 一律透過頁面按鈕操作，等同使用者自己按，不重放任何網路請求。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('sender');
  const { TIMING } = CQ;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────────── service worker 訊息 ─────────────

  let contextInvalidated = false;

  async function bgSend(type, payload = {}) {
    if (contextInvalidated) throw new Error('extension context invalidated');
    try {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (res && res.error) throw new Error(res.error);
      return res;
    } catch (e) {
      if (/context invalidated|Receiving end does not exist/i.test(e.message)) {
        contextInvalidated = /context invalidated/i.test(e.message);
        if (contextInvalidated) CQ.ui.toast(CQ.t('toastExtensionReloaded'), { kind: 'warn', duration: 0 });
      }
      throw e;
    }
  }

  CQ.bg = { send: bgSend };

  // ───────────── 對話中的使用者訊息 ─────────────

  function userMessages() {
    return CQ.selectors.findAll('userMessage');
  }

  function messageText(el) {
    return (el && (el.innerText || el.textContent)) || '';
  }

  function snapshotMessages() {
    const msgs = userMessages();
    return { count: msgs.length, lastEl: msgs[msgs.length - 1] || null, url: location.href };
  }

  /** 最近 3 則使用者訊息中是否已有相同內容（只在本機比對，不保存） */
  function findDuplicateInConversation(text) {
    const target = CQ.text.normalizeForCompare(text);
    return userMessages()
      .slice(-3)
      .some((el) => {
        const t = CQ.text.normalizeForCompare(messageText(el));
        if (!t) return false;
        if (t === target) return true;
        const lenOk = Math.abs(t.length - target.length) <= Math.max(5, target.length * 0.1);
        return lenOk && CQ.text.textStartsMatch(t, target, 500);
      });
  }

  // ───────────── 送出 ─────────────

  function isEnabled(btn) {
    return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  async function waitForEnabledSendButton(timeoutMs = TIMING.SEND_BUTTON_WAIT_MS) {
    const end = Date.now() + timeoutMs;
    let btn = null;
    while (Date.now() < end) {
      btn = CQ.selectors.getSendButton();
      if (isEnabled(btn)) return btn;
      await sleep(100);
    }
    if (!btn) CQ.selectors.reportMissing('sendButton');
    return null;
  }

  /** 備援：對輸入框送 Enter（ProseMirror 的 keymap 會處理；interceptor 忽略非 trusted 事件） */
  function pressEnter() {
    const editor = CQ.editor.getEditor();
    if (!editor) return false;
    editor.focus();
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', init));
    editor.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
  }

  /**
   * 按下送出並等待訊息出現在對話中。
   * 失敗時 error 會區分：
   *   'send-button-unavailable' / 'not-sent'：確定沒有送出（文字仍完整在輸入框）→ 可以安全重試
   *   'uncertain'：可能已送出 → 不可自動重試，避免重複
   * @returns {Promise<{ok: boolean, confidence?: 'strong'|'weak', error?: string, safeToRetry?: boolean}>}
   */
  async function clickSendAndConfirm(text) {
    const btn = await waitForEnabledSendButton();
    const before = snapshotMessages();
    CQ.interceptor.allowNextSend(); // 不要攔截我們自己觸發的送出
    if (btn) {
      btn.click();
      log.info('send button clicked', { beforeCount: before.count });
    } else {
      log.warn('send button unavailable, trying Enter fallback');
      if (!pressEnter()) return { ok: false, error: 'send-button-unavailable', safeToRetry: true };
    }
    const r = await detectSent(text, before);
    if (r.ok) return r;

    // Enter 備援也沒反應時，回報成「找不到送出按鈕」比較好懂
    if (r.error === 'not-sent' && !btn) return { ok: false, error: 'send-button-unavailable', safeToRetry: true };
    return r;
  }

  async function detectSent(text, before, timeoutMs = TIMING.SEND_DETECT_TIMEOUT_MS) {
    const end = Date.now() + timeoutMs;
    let weakSince = 0;
    while (Date.now() < end) {
      await sleep(250);
      const msgs = userMessages();
      const last = msgs[msgs.length - 1];
      const isNewLast = last && last !== before.lastEl;
      if (isNewLast && CQ.text.renderedMatches(messageText(last), text)) {
        return { ok: true, confidence: 'strong' };
      }
      const started = !!CQ.selectors.find('stopButton') || location.href !== before.url;
      // 弱判斷 1：多了一則使用者訊息且輸入框已清空（Markdown 渲染後文字對不上的情況）
      // 弱判斷 2：選擇器失效（找不到任何訊息），輸入框已清空，且開始生成回應或網址變了（/new → /chat/...）
      const weakSignal =
        CQ.editor.isEmpty() && ((isNewLast && msgs.length > before.count) || (!msgs.length && started));
      if (weakSignal) {
        if (!weakSince) weakSince = Date.now();
        if (Date.now() - weakSince > 1000) {
          if (!msgs.length) CQ.selectors.reportMissing('userMessage');
          return { ok: true, confidence: 'weak' };
        }
      } else {
        weakSince = 0;
      }
    }
    // 逾時：文字仍完整留在輸入框、沒有新訊息、也沒開始生成 → 確定沒送出
    const msgs = userMessages();
    const untouched =
      CQ.text.sameText(CQ.editor.getText(), text) &&
      msgs.length === before.count &&
      !CQ.selectors.find('stopButton') &&
      CQ.text.conversationKey(location.href) === CQ.text.conversationKey(before.url);
    if (untouched) return { ok: false, error: 'not-sent', safeToRetry: true };
    return { ok: false, error: 'uncertain', safeToRetry: false };
  }

  /** 新對話送出後，等網址從 /new 變成 /chat/<id>（取得新對話網址） */
  async function waitForConversationUrl(timeoutMs = TIMING.NEW_CHAT_URL_WAIT_MS) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!CQ.text.isNewChatUrl(location.href)) return location.href;
      await sleep(250);
    }
    return null;
  }

  async function waitForGenerationDone(timeoutMs = TIMING.GENERATION_WAIT_MS) {
    const end = Date.now() + timeoutMs;
    let clearCount = 0;
    await sleep(1000);
    while (Date.now() < end) {
      if (CQ.selectors.find('stopButton')) clearCount = 0;
      else if (++clearCount >= 3) return true;
      await sleep(700);
    }
    return false;
  }

  CQ.sender = {
    snapshotMessages,
    findDuplicateInConversation,
    clickSendAndConfirm,
    detectSent,
    waitForGenerationDone,
    waitForConversationUrl
  };
})(globalThis);
