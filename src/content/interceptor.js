/*
 * 攔截送出：監聽輸入框的 Enter（不含 Shift+Enter、不含輸入法選字中的 Enter）與送出按鈕點擊。
 *
 * 判斷是否攔截必須是「同步」的（preventDefault 只能在事件當下呼叫），所以：
 *   1. 同步依據：模擬狀態 → 頁面上的上限提示 → 最近一次的用量快照（每 2 分鐘輪詢，
 *      且在你聚焦輸入框時會額外刷新，讓快照在送出前盡量是新的）
 *   2. 若同步判斷為「已滿」，先擋下，再非同步重新查一次用量（最多 3 秒）：
 *      - 其實已恢復 → 不排隊，提示你再按一次送出（文字仍在輸入框）
 *      - 仍然已滿 → 存入佇列，確認存檔成功後才清空輸入框
 *   3. 用量未滿 → 完全不干涉
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('interceptor');
  const { MSG, TIMING, STATUS } = CQ;
  const t = CQ.t;

  let allowUntil = 0;
  let handling = false;

  function allowNextSend() {
    allowUntil = Date.now() + 2000;
  }

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  /** 同步判斷：目前是否應攔截 */
  function decideSync(now = Date.now()) {
    const sim = CQ.usage.simulatedStatus(now);
    if (sim) return sim.full ? { block: true, ...pickReset(sim) } : { block: false };

    const dom = CQ.usage.detectLimitFromDom(now);
    if (dom.limited) {
      return { block: true, resetAt: dom.resetAt, estimated: dom.estimated, reasons: ['dom'] };
    }
    const snap = CQ.usageState.current();
    if (snap && snap.full === true && (!snap.resetAt || snap.resetAt > now)) {
      return { block: true, ...pickReset(snap) };
    }
    return { block: false };
  }

  function pickReset(snap) {
    return { resetAt: snap.resetAt, estimated: !!snap.estimated, reasons: snap.fullReasons || [] };
  }

  function onKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (!e.isTrusted) return;
    if (!CQ.selectors.closestEditor(e.target)) return;
    handleSendAttempt(e, 'enter');
  }

  function onClick(e) {
    if (!e.isTrusted) return;
    const btn = CQ.selectors.closestSendButton(e.target);
    if (!btn) return;
    handleSendAttempt(e, 'click');
  }

  // 用量已滿時 claude.ai 可能把送出按鈕設為 disabled，disabled 按鈕不會觸發 click，
  // 所以在 pointerdown 階段處理「disabled 的送出按鈕」
  function onPointerDown(e) {
    if (!e.isTrusted || e.button !== 0) return;
    const btn = CQ.selectors.closestSendButton(e.target);
    if (!btn || !(btn.disabled || btn.getAttribute('aria-disabled') === 'true')) return;
    handleSendAttempt(e, 'pointerdown-disabled');
  }

  function handleSendAttempt(e, via) {
    if (Date.now() < allowUntil) return; // 我們自己觸發的送出
    if (handling) {
      stop(e);
      return;
    }
    const decision = decideSync();
    const text = CQ.editor.getText();

    if (!decision.block) {
      if (text) trackManualSend(text);
      return; // 不干涉
    }
    if (!text) return; // 沒有文字可保存，維持原本行為

    if (CQ.editor.hasAttachments()) {
      log.info('attachment detected, not queueing', { via });
      CQ.ui.toast(t('toastHasAttachment'), { kind: 'warn' });
      return; // 放行原本行為
    }

    stop(e);
    handling = true;
    log.info('send blocked (usage full)', { via, length: text.length, reasons: decision.reasons });
    queueMessage(text, decision)
      .catch((err) => {
        log.error('queue message failed', err);
        CQ.ui.toast(t('toastSaveFailed'), { kind: 'error' });
      })
      .finally(() => {
        handling = false;
      });
  }

  async function queueMessage(text, decision) {
    // 送出前再查一次
    const fresh = await CQ.usageState.refresh({ timeout: TIMING.PRE_SEND_RECHECK_TIMEOUT_MS });
    if (fresh && fresh.full === false) {
      log.info('usage recovered on re-check, not queueing');
      CQ.ui.toast(t('toastUsageRecovered'), { kind: 'success' });
      return;
    }
    const d = fresh && fresh.full === true ? { ...pickReset(fresh) } : decision;
    let resetAt = d.resetAt;
    let estimated = d.estimated;
    if (!resetAt) {
      resetAt = Date.now() + TIMING.FALLBACK_RESET_MS;
      estimated = true;
    }

    const res = await CQ.bg.send(MSG.QUEUE_ADD, {
      item: {
        text,
        url: location.href,
        resetAt,
        resetEstimated: !!estimated,
        reasons: d.reasons || []
      }
    });
    if (!res || !res.ok || !res.item) {
      CQ.ui.toast(t('toastSaveFailed'), { kind: 'error' });
      return;
    }

    // 已確認存檔成功，才清空輸入框；若等待期間內容被改過，就不清空
    if (CQ.text.sameText(CQ.editor.getText(), text)) {
      const cleared = await CQ.editor.clear();
      if (!cleared) CQ.ui.toast(t('toastClearFailed'), { kind: 'warn' });
    } else {
      CQ.ui.toast(t('toastEditorChangedNotCleared'), { kind: 'warn' });
    }

    const clock = CQ.i18n.formatClock(res.item.resetAt);
    CQ.ui.toast(
      t('toastQueued', { time: clock }) + (res.item.resetEstimated ? t('estimatedSuffix') : ''),
      { kind: 'info', duration: 8000 }
    );
  }

  /** 你在額度可用時手動送出了與佇列中相同的內容 → 確認送出後將該項目標記為已送出 */
  function trackManualSend(text) {
    const key = CQ.text.conversationKey(location.href);
    const match = CQ.queueCache
      .get()
      .find(
        (it) =>
          it.status !== STATUS.SENT &&
          !it.claim &&
          CQ.text.conversationKey(it.url) === key &&
          CQ.text.sameText(it.text, text)
      );
    if (!match) return;
    const before = CQ.sender.snapshotMessages();
    CQ.sender.detectSent(text, before).then((r) => {
      if (!r.ok) return;
      log.info('manual send of queued text detected', { id: match.id });
      CQ.bg
        .send(MSG.QUEUE_MARK_SENT_BY_TEXT, { id: match.id, by: 'manual' })
        .then(() => CQ.ui.toast(t('toastManualSendDetected'), { kind: 'success' }))
        .catch(() => {});
    });
  }

  function install() {
    // capture 階段掛在 window：會在 claude.ai（React 掛在 root）處理之前執行
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('click', onClick, true);
    log.debug('interceptor installed');
  }

  CQ.interceptor = { install, allowNextSend, decideSync };
})(globalThis);
