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

  async function waitForEnabledSendButton(timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    let btn = null;
    while (Date.now() < end) {
      btn = CQ.selectors.getSendButton();
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;
      await sleep(100);
    }
    if (!btn) CQ.selectors.reportMissing('sendButton');
    return null;
  }

  /**
   * 按下送出並等待訊息出現在對話中。
   * @returns {Promise<{ok: boolean, confidence?: 'strong'|'weak', error?: string}>}
   */
  async function clickSendAndConfirm(text) {
    const btn = await waitForEnabledSendButton();
    if (!btn) return { ok: false, error: 'send-button-unavailable' };

    const before = snapshotMessages();
    CQ.interceptor.allowNextSend(); // 不要攔截我們自己觸發的送出
    btn.click();
    log.info('send button clicked', { beforeCount: before.count });
    return detectSent(text, before);
  }

  async function detectSent(text, before, timeoutMs = TIMING.SEND_DETECT_TIMEOUT_MS) {
    const end = Date.now() + timeoutMs;
    let weakSince = 0;
    while (Date.now() < end) {
      await sleep(250);
      const msgs = userMessages();
      const last = msgs[msgs.length - 1];
      if (last && last !== before.lastEl && CQ.text.textStartsMatch(messageText(last), text)) {
        return { ok: true, confidence: 'strong' };
      }
      // 選擇器失效時的弱判斷：輸入框已清空，且開始生成回應或網址變了（/new → /chat/...）
      if (!msgs.length) {
        const started = !!CQ.selectors.find('stopButton') || location.href !== before.url;
        if (CQ.editor.isEmpty() && started) {
          if (!weakSince) weakSince = Date.now();
          if (Date.now() - weakSince > 1000) {
            CQ.selectors.reportMissing('userMessage');
            return { ok: true, confidence: 'weak' };
          }
        } else {
          weakSince = 0;
        }
      }
    }
    return { ok: false, error: 'not-detected' };
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
    waitForGenerationDone
  };
})(globalThis);
