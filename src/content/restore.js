/*
 * 重置後的還原流程：把佇列中的文字填回輸入框 → 顯示確認列 → 由你按下送出（或自動送出）。
 *
 * 只有 service worker 指定給「這個分頁」的項目才會還原（點通知 / popup 的「立即嘗試」/ 自動送出），
 * 不會因為你同時開著多個 claude.ai 分頁而在每個分頁都填入。
 *
 * 自動送出的原則：寧可不送，也不送錯對話、不重複送。
 *   - 送出前（取得 claim 前、按下送出前）都會再確認目前就是原對話；不是就請 SW 重新開啟原對話
 *   - 確定沒送出（文字仍完整在輸入框）時，重新整理分頁後重試（最多 LIMITS.MAX_RESTORE_RETRIES 次）
 *   - 可能已送出但無法確認時，標記失敗並通知，不自動重試
 *   - 任何無法完成的情況都以桌面通知結束，不會靜默卡住
 *
 * 附件：先用頁面上的上傳元件把檔案加回輸入區、等上傳完成，才填文字與倒數。
 *   - 輸入區原本就有附件 → 自動模式不送（不把你的附件和佇列訊息混在一起）；手動模式讓你選
 *   - 有任何一個檔案加不回去 → 自動模式不送（重新整理後重試，仍失敗就通知）；手動模式可下載附件自己加
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('restore');
  const { MSG, TIMING, LIMITS } = CQ;
  const t = CQ.t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keyOf = (url) => CQ.text.conversationKey(url);

  let running = false;
  /** 目前這次還原的狀態 */
  let ctx = null;

  async function waitForEditor(timeoutMs = TIMING.COMPOSER_WAIT_MS) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ed = CQ.editor.getEditor();
      if (ed && ed.isConnected) return ed;
      await sleep(300);
    }
    return null;
  }

  async function bg(type, payload) {
    try {
      return await CQ.bg.send(type, payload);
    } catch (e) {
      log.warn(`${type} failed`, { error: e.message });
      return null;
    }
  }

  async function release(c, status = 'ready', extra = {}) {
    await bg(MSG.QUEUE_RELEASE, { id: c.item.id, token: c.token, status, ...extra });
    c.token = null;
  }

  /** 確定還沒送出 → 請 SW 重新整理這個分頁後重試 */
  async function retry(c, reason) {
    log.warn('restore retry requested', { id: c.item.id, reason, retries: c.attempt.retries });
    const res = await bg(MSG.RESTORE_RETRY, {
      id: c.item.id,
      token: c.token,
      reason,
      mode: c.mode,
      attempt: c.attempt
    });
    c.token = null;
    CQ.ui.toast(t(res && res.ok ? 'toastRetryReload' : 'toastAutoSendGaveUp'), {
      kind: res && res.ok ? 'info' : 'error'
    });
  }

  /** 目前不是原對話 → 請 SW 開啟正確的對話（自動模式絕不在別的對話送出） */
  async function reopen(c) {
    log.warn('not in original conversation, reopening', { id: c.item.id });
    const res = await bg(MSG.RESTORE_REOPEN, { id: c.item.id, token: c.token, mode: c.mode, attempt: c.attempt });
    c.token = null;
    CQ.ui.toast(t(res && res.ok ? 'toastWrongConversation' : 'toastAutoSendGaveUp'), {
      kind: res && res.ok ? 'info' : 'error'
    });
  }

  /** 自動送出無法完成 → 標記失敗並發通知 */
  async function giveUp(c, reason) {
    await bg(MSG.RESTORE_GIVE_UP, { id: c.item.id, token: c.token, reason });
    c.token = null;
    CQ.ui.toast(t('toastAutoSendGaveUp'), { kind: 'error' });
  }

  function inTargetConversation(c) {
    return keyOf(location.href) === c.targetKey;
  }

  /** 用量快照只因頁面上的上限提示判定已滿，但 API 明確顯示未滿 → 多半是沒重新整理的舊頁面 */
  function isStaleDomOnly(snap) {
    return (
      !!snap &&
      snap.full === true &&
      snap.source === 'api+dom' &&
      Array.isArray(snap.fullReasons) &&
      snap.fullReasons.length === 1 &&
      snap.fullReasons[0] === 'dom'
    );
  }

  /**
   * 處理「用量看起來仍滿」。回傳 true 代表已處理（流程應結束）。
   */
  async function handleStillFull(c, snap) {
    if (isStaleDomOnly(snap) && c.attempt.retries < LIMITS.MAX_RESTORE_RETRIES) {
      await retry(c, 'stale-limit');
      return true;
    }
    CQ.ui.toast(
      t('toastStillFull', { time: CQ.i18n.formatClock(snap.resetAt) }) + (snap.estimated ? t('estimatedSuffix') : ''),
      { kind: 'warn' }
    );
    await release(c, 'waiting', { resetAt: snap.resetAt, resetEstimated: !!snap.estimated });
    return true;
  }

  /** 詢問 SW：有沒有指定給這個分頁的還原工作 */
  async function check() {
    if (running) return;
    const res = await bg(MSG.RESTORE_CHECK, { url: location.href });
    if (res && res.item) start(res.item, res.mode, res.attempt);
  }

  /**
   * 開始還原。同步回傳是否接受（分頁正在處理另一則時回傳 false，SW 會保留工作，結束後再領取）。
   */
  function start(item, mode = 'manual', attempt = {}) {
    if (running) {
      log.info('restore already running, will pick up later', { id: item.id });
      return false;
    }
    running = true;
    ctx = {
      item,
      mode,
      attempt: { retries: attempt.retries || 0, reopened: attempt.reopened || 0 },
      token: null,
      targetKey: keyOf(item.url),
      phase: 'prepare',
      // 送出前輸入區應有的附件數（null = 不檢查）；preexisting = 還原前輸入區就有的附件數
      expectedFiles: null,
      preexisting: 0
    };
    const c = ctx;
    log.info('restore start', { id: item.id, mode, length: item.text.length, attempt: c.attempt });
    runInner(c)
      .catch(async (e) => {
        log.error('restore error', e);
        CQ.ui.toast(t('toastRestoreError'), { kind: 'error' });
        if (c.mode === 'auto') await giveUp(c, 'generic');
        else if (c.token) await release(c, 'ready');
      })
      .then((outcome) => {
        running = false;
        ctx = null;
        if (outcome === 'sent') continueWithNext(c);
        // 分頁忙碌時 SW 留下的工作，現在來領取
        setTimeout(check, 500);
      });
    return true;
  }

  /** SPA 換頁（由 main.js 呼叫）：還沒按下送出前離開原對話 → 中止這次還原 */
  function onNavigate() {
    const c = ctx;
    if (!c || c.phase === 'sending') return;
    if (!inTargetConversation(c)) {
      log.warn('navigated away during restore', { id: c.item.id });
      c.navigated = true;
      CQ.ui.hideBar('navigated');
    }
  }

  async function handleNavigatedAway(c) {
    if (c.mode === 'auto') {
      await reopen(c);
    } else {
      await release(c, 'ready');
      CQ.ui.toast(t('toastKeptInQueue'), { kind: 'info' });
    }
  }

  /** @returns {Promise<'sent'|'stopped'>} */
  async function runInner(c) {
    const { item } = c;
    const auto = c.mode === 'auto';

    const editor = await waitForEditor();
    if (!editor) {
      CQ.selectors.reportMissing('editor');
      if (auto) await retry(c, 'editor-missing');
      else await release(c, 'ready');
      return 'stopped';
    }

    // 不是原對話（分頁被切到別的對話、對話已刪除被導向 /new…）
    if (!inTargetConversation(c)) {
      log.warn('conversation url mismatch', { expectedNew: CQ.text.isNewChatUrl(item.url) });
      if (auto) {
        await reopen(c);
        return 'stopped';
      }
      const choice = await CQ.ui.showBar({
        message: t('barConversationMissing'),
        buttons: [
          { id: 'here', label: t('btnSendHere'), kind: 'primary' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (choice !== 'here') {
        await release(c, 'ready');
        return 'stopped';
      }
      c.targetKey = keyOf(location.href); // 你明確選擇在這個對話送出
    }

    // 確認額度真的恢復
    const snap = await CQ.usageState.refresh({ timeout: TIMING.USAGE_FETCH_TIMEOUT_MS });
    if (item.keepalive) {
      // 自動重設只看 API：頁面上殘留的上限提示不代表還不能送
      if (await keepaliveBlocked(c, snap)) return 'stopped';
      CQ.ui.toast(t('toastKeepalive'), { kind: 'info', duration: 8000 });
    } else if (snap && snap.full === true) {
      await handleStillFull(c, snap);
      return 'stopped';
    }

    // 你可能已經手動送出過相同內容（自動重設的專用對話裡本來就有很多相同訊息，不檢查）
    if (!item.keepalive && CQ.sender.findDuplicateInConversation(item.text)) {
      if (auto) {
        // 不確定是不是已經送過 → 不自動送，交給你決定
        await giveUp(c, 'duplicate');
        return 'stopped';
      }
      const choice = await CQ.ui.showBar({
        message: t('barDuplicate'),
        sub: CQ.text.preview(item.text),
        buttons: [
          { id: 'markSent', label: t('btnMarkSent'), kind: 'primary' },
          { id: 'restore', label: t('btnRestoreAnyway') },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (choice === 'markSent') {
        await bg(MSG.QUEUE_MARK_SENT_BY_TEXT, { id: item.id, by: 'duplicate-confirmed' });
        CQ.ui.toast(t('toastMarkedSent'), { kind: 'success' });
        return 'stopped';
      }
      if (choice === 'navigated') {
        await handleNavigatedAway(c);
        return 'stopped';
      }
      if (choice !== 'restore') {
        await release(c, 'ready');
        return 'stopped';
      }
    }

    // 輸入區已有附件（你的附件草稿，或之前加到一半的）
    if (CQ.attachments.count() > 0) {
      const r = await handleExistingAttachments(c);
      if (r !== 'ok') return 'stopped';
    }

    // 輸入框已有其他內容
    const existing = CQ.editor.getText(editor);
    const alreadyFilled = existing && CQ.text.sameText(existing, item.text);
    if (existing && !alreadyFilled) {
      if (auto) {
        // 先把你的草稿存進佇列（標記為草稿，不會自動送出），確定存好才覆蓋
        const saved = await bg(MSG.QUEUE_ADD, { item: { text: existing, url: location.href, draft: true } });
        if (!saved || !saved.ok) {
          await giveUp(c, 'draft-save-failed');
          return 'stopped';
        }
        CQ.ui.toast(t('toastDraftSaved'), { kind: 'info', duration: 10000 });
      } else {
        const choice = await CQ.ui.showBar({
          message: t('barEditorNotEmpty'),
          buttons: [
            { id: 'overwrite', label: t('btnOverwrite'), kind: 'danger' },
            { id: 'keep', label: t('btnKeepInQueue') }
          ]
        });
        if (choice === 'navigated') {
          await handleNavigatedAway(c);
          return 'stopped';
        }
        if (choice !== 'overwrite') {
          await release(c, 'ready');
          return 'stopped';
        }
      }
    }

    // 把附件加回去並等上傳完成（倒數要在這之後才開始）
    if ((item.attachments || []).length) {
      const r = await restoreAttachments(c);
      if (r !== 'ok') return 'stopped';
    }

    if (!alreadyFilled) {
      const filled = await CQ.editor.fill(item.text, editor);
      if (!filled.ok) {
        log.error('fill failed with all methods', { id: item.id });
        if (auto) {
          await retry(c, 'fill-failed');
          return 'stopped';
        }
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
        await release(c, 'ready');
        return 'stopped';
      }
    }

    let choice = c.navigated ? 'navigated' : 'manual';
    if (auto && choice !== 'navigated') choice = await autoCountdown();
    if (choice === 'manual' || choice === 'cancelAuto') {
      choice = await CQ.ui.showBar({
        message: t('barRestored'),
        sub: CQ.text.preview(item.text) + filesSuffix(item),
        buttons: [
          { id: 'send', label: t('btnSend'), kind: 'primary' },
          { id: 'cancel', label: t('btnCancel'), kind: 'danger' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      // 你取消了自動送出 → 之後的步驟都以手動模式處理（不自動重試、不自動放棄）
      if (auto) c.mode = 'manual';
    }

    if (choice === 'send') {
      return doSend(c);
    }
    if (choice === 'navigated') {
      await handleNavigatedAway(c);
    } else if (choice === 'cancel') {
      await bg(MSG.QUEUE_DELETE, { id: item.id });
      CQ.ui.toast(t('toastCancelled'), { kind: 'info' });
    } else if (choice === 'keep') {
      await CQ.editor.clear();
      // 只在輸入區原本沒有你的附件時才移除（不動你自己加的）
      if ((item.attachments || []).length && !c.preexisting) await CQ.attachments.removeAll();
      await release(c, 'ready');
      CQ.ui.toast(t('toastKeptInQueue'), { kind: 'info' });
    } else {
      // 'gone'（項目在別處被處理掉）或 'dismissed'
      log.info('restore bar closed', { choice });
    }
    return 'stopped';
  }

  /**
   * 自動送出倒數。用截止時間計算（不是累加計數），背景分頁的計時器被節流也會準時結束。
   */
  function autoCountdown() {
    const deadline = Date.now() + TIMING.AUTO_SEND_COUNTDOWN_S * 1000;
    const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const p = CQ.ui.showBar({
      message: t('barAutoSendCountdown', { seconds: secondsLeft() }),
      buttons: [
        { id: 'send', label: t('btnSendNow'), kind: 'primary' },
        { id: 'cancelAuto', label: t('btnCancelAutoSend') }
      ]
    });
    const finish = () => CQ.ui.hideBar('send');
    const endTimer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    const tick = setInterval(() => {
      if (Date.now() >= deadline) finish();
      else CQ.ui.updateBar(t('barAutoSendCountdown', { seconds: secondsLeft() }));
    }, 250);
    return p.finally(() => {
      clearTimeout(endTimer);
      clearInterval(tick);
    });
  }

  /** 送出前再查一次用量。回傳 true 代表可以送出；false 代表已處理（打回佇列或重試） */
  async function usageAllowsSend(c) {
    const fresh = await CQ.usageState.refresh({ timeout: TIMING.PRE_SEND_RECHECK_TIMEOUT_MS });
    const snap = fresh || CQ.usageState.current();
    if (c.item.keepalive && CQ.session.hasApiData(snap)) return !(await keepaliveBlocked(c, snap));
    if (snap && snap.full === true && (!snap.resetAt || snap.resetAt > Date.now() || isStaleDomOnly(snap))) {
      await handleStillFull(c, snap);
      return false;
    }
    if (!snap && CQ.interceptor.decideSync().block) {
      // 完全查不到用量時才退回頁面判斷
      const cur = CQ.interceptor.decideSync();
      await release(c, 'waiting', { resetAt: cur.resetAt, resetEstimated: !!cur.estimated });
      CQ.ui.toast(t('toastStillFull', { time: CQ.i18n.formatClock(cur.resetAt) }), { kind: 'warn' });
      return false;
    }
    return true;
  }

  async function doSend(c) {
    const { item } = c;

    // 1. 聊天室守門（取得 claim 前）
    if (c.navigated || !inTargetConversation(c)) {
      await handleNavigatedAway(c);
      return 'stopped';
    }

    // 2. 取得送出鎖定（防重複送出）
    const claim = await bg(MSG.QUEUE_CLAIM, { id: item.id });
    if (!claim || !claim.ok) {
      log.warn('claim rejected', { id: item.id, reason: claim && claim.reason });
      CQ.ui.toast(t(claim && claim.reason === 'not-found' ? 'toastAlreadyHandled' : 'toastClaimRejected'), {
        kind: 'warn'
      });
      return 'stopped';
    }
    c.token = claim.token;

    // 3. 額度（在確認列停留期間可能又被別的分頁用掉；也排除舊頁面殘留的上限提示）
    if (!(await usageAllowsSend(c))) return 'stopped';

    // 4. 輸入框內容：自動模式下若被清空或改變，重新填入
    let textNow = CQ.editor.getText();
    if (c.mode === 'auto' && !CQ.text.sameText(textNow, item.text)) {
      log.warn('editor content changed before auto send, refilling', { got: textNow.length });
      const filled = await CQ.editor.fill(item.text);
      if (!filled.ok) {
        await retry(c, 'fill-failed');
        return 'stopped';
      }
      textNow = CQ.editor.getText();
    }
    if (!textNow) {
      await release(c, 'ready');
      CQ.ui.toast(t('toastEditorEmpty'), { kind: 'warn' });
      return 'stopped';
    }

    // 4b. 附件：上傳要完成；自動模式還要確認數量沒少（少了就不送）
    if (!(await attachmentsAllowSend(c))) return 'stopped';

    // 5. 聊天室守門（按下送出前的最後一刻）
    if (c.navigated || !inTargetConversation(c)) {
      await handleNavigatedAway(c);
      return 'stopped';
    }

    c.phase = 'sending';
    const r = await CQ.sender.clickSendAndConfirm(textNow);
    if (r.ok) {
      await bg(MSG.QUEUE_MARK_SENT, {
        id: item.id,
        token: c.token,
        confidence: r.confidence,
        edited: !CQ.text.sameText(textNow, item.text)
      });
      c.token = null;
      log.info('queued message sent', { id: item.id, confidence: r.confidence });
      CQ.ui.toast(t(r.confidence === 'weak' ? 'toastSentWeak' : 'toastSent'), { kind: 'success' });
      await rebindNewChatGroup(c);
      await bindKeepaliveConversation(c);
      return 'sent';
    }

    log.error('send not confirmed', { id: item.id, error: r.error, safeToRetry: !!r.safeToRetry });
    if (c.mode === 'auto') {
      if (r.safeToRetry) await retry(c, r.error);
      else await giveUp(c, 'uncertain');
      return 'stopped';
    }
    await bg(MSG.QUEUE_MARK_FAILED, { id: item.id, token: c.token, error: r.error });
    c.token = null;
    CQ.ui.toast(t('toastSendFailed'), { kind: 'error' });
    return 'stopped';
  }

  function filesSuffix(item) {
    const n = (item.attachments || []).length;
    return n ? t('barFilesSuffix', { count: n }) : '';
  }

  /**
   * 還原前輸入區已經有附件。回傳 'ok' 代表繼續，其他代表已處理（流程應結束）。
   */
  async function handleExistingAttachments(c) {
    if (c.mode === 'auto') {
      log.warn('composer already has attachments, not auto sending', { id: c.item.id });
      await giveUp(c, 'composer-has-attachments');
      return 'stopped';
    }
    for (;;) {
      const choice = await CQ.ui.showBar({
        message: t('barComposerHasAttachments'),
        buttons: [
          { id: 'recheck', label: t('btnRecheckAttachments'), kind: 'primary' },
          { id: 'together', label: t('btnSendTogether') },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (choice === 'recheck') {
        if (CQ.attachments.count() === 0) return 'ok';
        continue;
      }
      if (choice === 'together') {
        c.preexisting = CQ.attachments.count();
        return 'ok';
      }
      if (choice === 'navigated') await handleNavigatedAway(c);
      else if (choice !== 'gone') await release(c, 'ready');
      return 'stopped';
    }
  }

  /** 把佇列項目的附件加回輸入區。回傳 'ok' 代表繼續，其他代表已處理 */
  async function restoreAttachments(c) {
    const { item } = c;
    const auto = c.mode === 'auto';
    const base = CQ.attachments.count();

    const loaded = await CQ.attachments.load(item);
    if (!loaded.ok) {
      log.error('attachments missing from storage', { id: item.id });
      if (auto) {
        await giveUp(c, 'attachments-missing');
        return 'stopped';
      }
      const choice = await CQ.ui.showBar({
        message: t('barAttachmentsMissing'),
        sub: CQ.text.preview(item.text),
        buttons: [
          { id: 'textOnly', label: t('btnSendTextOnly'), kind: 'primary' },
          { id: 'keep', label: t('btnKeepInQueue') }
        ]
      });
      if (choice === 'textOnly') return 'ok';
      if (choice === 'navigated') await handleNavigatedAway(c);
      else if (choice !== 'gone') await release(c, 'ready');
      return 'stopped';
    }

    CQ.ui.toast(t('toastAttaching', { count: loaded.files.length }), { kind: 'info' });
    const res = await CQ.attachments.attach(loaded.files);
    if (c.navigated) {
      await handleNavigatedAway(c);
      return 'stopped';
    }
    if (res.ok) {
      c.expectedFiles = base + loaded.files.length;
      return 'ok';
    }

    if (auto) {
      // 還沒送出，重新整理後重試（會清掉加到一半的附件）；用完重試次數就通知你
      await retry(c, 'attach-failed');
      return 'stopped';
    }
    const choice = await CQ.ui.showBar({
      message: t('barAttachFailed'),
      sub: loaded.files.map((f) => f.name).join('、'),
      buttons: [
        {
          id: 'download',
          label: t('btnDownloadAttachments'),
          keepOpen: true,
          onClick: () => CQ.attachments.download(loaded.files)
        },
        { id: 'continue', label: t('btnAttachedManually'), kind: 'primary' },
        { id: 'keep', label: t('btnKeepInQueue') }
      ]
    });
    if (choice === 'continue') return 'ok'; // 你自己處理附件，不檢查數量
    if (choice === 'navigated') {
      await handleNavigatedAway(c);
      return 'stopped';
    }
    if (choice !== 'gone') {
      if (!base) await CQ.attachments.removeAll();
      await release(c, 'ready');
    }
    return 'stopped';
  }

  /** 送出前的附件檢查。回傳 true 代表可以送出 */
  async function attachmentsAllowSend(c) {
    const end = Date.now() + TIMING.ATTACH_UPLOAD_WAIT_MS;
    while (CQ.attachments.uploading() && Date.now() < end) await sleep(300);
    const stillUploading = CQ.attachments.uploading();
    const missing = c.expectedFiles != null && CQ.attachments.count() < c.expectedFiles;
    if (!stillUploading && !(c.mode === 'auto' && missing)) return true;

    log.warn('attachments not ready at send', { id: c.item.id, stillUploading, missing });
    if (c.mode === 'auto') {
      await retry(c, 'attach-failed');
    } else {
      await release(c, 'ready');
      CQ.ui.toast(t('toastAttachmentsNotReady'), { kind: 'warn', duration: 8000 });
    }
    return false;
  }

  /** 新對話群組的第一則送出後，把其餘項目改指向剛建立的對話（依序送進同一個對話） */
  async function rebindNewChatGroup(c) {
    const { item } = c;
    if (!item.newChatGroup || !CQ.text.isNewChatUrl(item.url)) return;
    const url = await CQ.sender.waitForConversationUrl();
    log.info('new chat url for group', { found: !!url });
    await bg(MSG.QUEUE_REBIND, { group: item.newChatGroup, url });
  }

  /**
   * 自動重設項目：用 API 資料判斷要不要送。回傳 true 代表已處理（流程應結束）。
   *  - 工作階段已經在進行（例如你用手機送過訊息）→ 不需要送，移除
   *  - 每週上限已滿 → 不送（SW 會移除並等每週重置）
   *  - 讀不到 API → 退回頁面判斷：頁面明確顯示已滿就不送
   */
  async function keepaliveBlocked(c, snap) {
    const check = CQ.session.keepaliveCheck(snap, {});
    if (check.result === 'session-active') {
      log.info('keepalive skipped: session already active');
      await bg(MSG.QUEUE_DELETE, { id: c.item.id });
      return true;
    }
    if (check.result === 'weekly-full') {
      log.info('keepalive skipped: weekly limit full');
      await release(c, 'waiting', { resetAt: check.endAt, resetEstimated: false });
      return true;
    }
    if (check.result === 'no-usage-data' && snap && snap.full === true) {
      await handleStillFull(c, snap);
      return true;
    }
    return false;
  }

  /** 自動重設第一次在新對話送出 → 回報建立的對話網址，之後都送進這個專用對話 */
  async function bindKeepaliveConversation(c) {
    const { item } = c;
    if (!item.keepalive || !CQ.text.isNewChatUrl(item.url)) return;
    const url = await CQ.sender.waitForConversationUrl();
    log.info('keepalive conversation url', { found: !!url });
    if (url) await bg(MSG.KEEPALIVE_BOUND, { url });
  }

  /** 同一對話還有其他項目 → 等回應生成完再依序處理；沒有 → 自動模式交給 SW 處理其他對話 */
  async function continueWithNext(c) {
    try {
      const res = await bg(MSG.RESTORE_NEXT, { url: location.href, peek: true });
      if (res && res.item) {
        CQ.ui.toast(t('toastWaitingForResponse'), { kind: 'info' });
        await CQ.sender.waitForGenerationDone();
        const next = await bg(MSG.RESTORE_NEXT, { url: location.href });
        if (next && next.item && start(next.item, next.mode || c.mode)) return;
      }
      await bg(MSG.RESTORE_DONE, {});
    } catch (e) {
      log.warn('continue with next failed', { error: e.message });
    }
  }

  function getCurrentId() {
    return ctx ? ctx.item.id : null;
  }

  CQ.restore = { check, start, run: start, onNavigate, getCurrentId };
})(globalThis);
