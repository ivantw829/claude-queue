/*
 * 重置後的還原流程：把佇列中的文字填回輸入框 → 顯示確認列 → 由你按下送出（或自動送出）。
 *
 * 只有 service worker 指定給「這個分頁」的項目才會還原（點通知 / popup 的「立即嘗試」），
 * 不會因為你同時開著多個 claude.ai 分頁而在每個分頁都填入。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('restore');
  const { MSG, TIMING } = CQ;
  const t = CQ.t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let running = false;
  let currentId = null;

  async function waitForEditor(timeoutMs = TIMING.COMPOSER_WAIT_MS) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ed = CQ.editor.getEditor();
      if (ed && ed.isConnected) return ed;
      await sleep(300);
    }
    return null;
  }

  async function release(item, status = 'ready', extra = {}) {
    try {
      await CQ.bg.send(MSG.QUEUE_RELEASE, { id: item.id, status, ...extra });
    } catch (e) {
      log.warn('release failed', { error: e.message });
    }
  }

  /** 詢問 SW：有沒有指定給這個分頁的還原工作 */
  async function check() {
    if (running) return;
    try {
      const res = await CQ.bg.send(MSG.RESTORE_CHECK, { url: location.href });
      if (res && res.item) run(res.item, res.mode);
    } catch (e) {
      log.debug('restore check failed', { error: e.message });
    }
  }

  async function run(item, mode = 'manual') {
    if (running) {
      log.warn('restore already running, ignoring', { id: item.id });
      return;
    }
    running = true;
    currentId = item.id;
    log.info('restore start', { id: item.id, mode, length: item.text.length });
    try {
      await runInner(item, mode);
    } catch (e) {
      log.error('restore error', e);
      CQ.ui.toast(t('toastRestoreError'), { kind: 'error' });
    } finally {
      running = false;
      currentId = null;
    }
  }

  async function runInner(item, mode) {
    const editor = await waitForEditor();
    if (!editor) {
      CQ.selectors.reportMissing('editor');
      await release(item, 'ready');
      return;
    }

    // 對話網址不同（對話已刪除被導向 /new，或被重新導向）
    if (CQ.text.conversationKey(location.href) !== CQ.text.conversationKey(item.url)) {
      log.warn('conversation url mismatch', { expectedNew: CQ.text.isNewChatUrl(item.url) });
      const c = await CQ.ui.showBar({
        message: t('barConversationMissing'),
        buttons: [
          { id: 'here', label: t('btnSendHere'), kind: 'primary' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (c !== 'here') {
        await release(item, 'ready');
        return;
      }
    }

    // 確認額度真的恢復
    const snap = await CQ.usageState.refresh({ timeout: TIMING.USAGE_FETCH_TIMEOUT_MS });
    if (snap && snap.full === true) {
      CQ.ui.toast(
        t('toastStillFull', { time: CQ.i18n.formatClock(snap.resetAt) }) +
          (snap.estimated ? t('estimatedSuffix') : ''),
        { kind: 'warn' }
      );
      await release(item, 'waiting', { resetAt: snap.resetAt, resetEstimated: !!snap.estimated });
      return;
    }

    // 你可能已經手動送出過相同內容
    if (CQ.sender.findDuplicateInConversation(item.text)) {
      const c = await CQ.ui.showBar({
        message: t('barDuplicate'),
        sub: CQ.text.preview(item.text),
        buttons: [
          { id: 'markSent', label: t('btnMarkSent'), kind: 'primary' },
          { id: 'restore', label: t('btnRestoreAnyway') },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (c === 'markSent') {
        await CQ.bg.send(MSG.QUEUE_MARK_SENT_BY_TEXT, { id: item.id, by: 'duplicate-confirmed' });
        CQ.ui.toast(t('toastMarkedSent'), { kind: 'success' });
        return;
      }
      if (c !== 'restore') {
        await release(item, 'ready');
        return;
      }
    }

    // 輸入框已有其他內容 → 詢問是否覆蓋
    const existing = CQ.editor.getText(editor);
    const alreadyFilled = existing && CQ.text.sameText(existing, item.text);
    if (existing && !alreadyFilled) {
      const c = await CQ.ui.showBar({
        message: t('barEditorNotEmpty'),
        buttons: [
          { id: 'overwrite', label: t('btnOverwrite'), kind: 'danger' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (c !== 'overwrite') {
        await release(item, 'ready');
        return;
      }
    }

    if (!alreadyFilled) {
      const filled = await CQ.editor.fill(item.text, editor);
      if (!filled.ok) {
        log.error('fill failed with all methods', { id: item.id });
        await CQ.ui.showBar({
          message: t('barFillFailed'),
          buttons: [
            {
              id: 'copy',
              label: t('btnCopyText'),
              kind: 'primary',
              keepOpen: true,
              onClick: () =>
                navigator.clipboard
                  .writeText(item.text)
                  .then(() => CQ.ui.toast(t('toastCopied'), { kind: 'success' }))
                  .catch(() => CQ.ui.toast(t('toastCopyFailed'), { kind: 'error' }))
            },
            { id: 'keep', label: t('btnClose') }
          ]
        });
        await release(item, 'ready');
        return;
      }
    }

    let choice = 'manual';
    if (mode === 'auto') choice = await autoCountdown();
    if (choice === 'manual' || choice === 'cancelAuto') {
      choice = await CQ.ui.showBar({
        message: t('barRestored'),
        sub: CQ.text.preview(item.text),
        buttons: [
          { id: 'send', label: t('btnSend'), kind: 'primary' },
          { id: 'cancel', label: t('btnCancel'), kind: 'danger' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
    }

    if (choice === 'send') {
      await doSend(item, mode);
    } else if (choice === 'cancel') {
      await CQ.bg.send(MSG.QUEUE_DELETE, { id: item.id });
      CQ.ui.toast(t('toastCancelled'), { kind: 'info' });
    } else if (choice === 'keep') {
      await CQ.editor.clear();
      await release(item, 'ready');
      CQ.ui.toast(t('toastKeptInQueue'), { kind: 'info' });
    } else {
      // 'gone'（項目在別處被處理掉）或 'dismissed'
      log.info('restore bar closed', { choice });
    }
  }

  function autoCountdown() {
    let left = TIMING.AUTO_SEND_COUNTDOWN_S;
    const p = CQ.ui.showBar({
      message: t('barAutoSendCountdown', { seconds: left }),
      buttons: [
        { id: 'send', label: t('btnSendNow'), kind: 'primary' },
        { id: 'cancelAuto', label: t('btnCancelAutoSend') }
      ]
    });
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        CQ.ui.hideBar('send');
      } else {
        CQ.ui.updateBar(t('barAutoSendCountdown', { seconds: left }));
      }
    }, 1000);
    return p.finally(() => clearInterval(timer));
  }

  async function doSend(item, mode) {
    const claim = await CQ.bg.send(MSG.QUEUE_CLAIM, { id: item.id });
    if (!claim || !claim.ok) {
      log.warn('claim rejected', { id: item.id, reason: claim && claim.reason });
      CQ.ui.toast(t(claim && claim.reason === 'not-found' ? 'toastAlreadyHandled' : 'toastClaimRejected'), {
        kind: 'warn'
      });
      return;
    }
    const token = claim.token;

    // 在確認列停留期間可能又被擋（例如被別的分頁用掉額度）
    if (CQ.interceptor.decideSync().block) {
      const snap = CQ.usageState.current();
      const resetAt = snap && snap.full ? snap.resetAt : null;
      await CQ.bg.send(MSG.QUEUE_RELEASE, { id: item.id, token, status: 'waiting', resetAt });
      CQ.ui.toast(t('toastStillFull', { time: CQ.i18n.formatClock(resetAt) }), { kind: 'warn' });
      return;
    }

    const textNow = CQ.editor.getText();
    if (!textNow) {
      await CQ.bg.send(MSG.QUEUE_RELEASE, { id: item.id, token, status: 'ready' });
      CQ.ui.toast(t('toastEditorEmpty'), { kind: 'warn' });
      return;
    }

    const r = await CQ.sender.clickSendAndConfirm(textNow);
    if (r.ok) {
      await CQ.bg.send(MSG.QUEUE_MARK_SENT, {
        id: item.id,
        token,
        confidence: r.confidence,
        edited: !CQ.text.sameText(textNow, item.text)
      });
      log.info('queued message sent', { id: item.id, confidence: r.confidence });
      CQ.ui.toast(t(r.confidence === 'weak' ? 'toastSentWeak' : 'toastSent'), { kind: 'success' });
      continueWithNext(mode);
    } else {
      await CQ.bg.send(MSG.QUEUE_MARK_FAILED, { id: item.id, token, error: r.error });
      log.error('send not confirmed', { id: item.id, error: r.error });
      CQ.ui.toast(t('toastSendFailed'), { kind: 'error' });
    }
  }

  /** 同一對話還有其他 ready 的項目：等回應生成完再依序處理 */
  async function continueWithNext(mode) {
    try {
      const res = await CQ.bg.send(MSG.RESTORE_NEXT, { url: location.href, peek: true });
      if (!res || !res.item) return;
      CQ.ui.toast(t('toastWaitingForResponse'), { kind: 'info' });
      await CQ.sender.waitForGenerationDone();
      const next = await CQ.bg.send(MSG.RESTORE_NEXT, { url: location.href });
      if (next && next.item) run(next.item, next.mode || mode);
    } catch (e) {
      log.warn('continue with next failed', { error: e.message });
    }
  }

  function getCurrentId() {
    return currentId;
  }

  CQ.restore = { check, run, getCurrentId };
})(globalThis);
