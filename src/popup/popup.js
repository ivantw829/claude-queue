/*
 * Popup：顯示用量、重置倒數、佇列清單（刪除 / 編輯 / 立即嘗試）。
 */
(function () {
  const { STORAGE_KEYS: K, MSG, STATUS } = CQ;
  const t = CQ.t;
  const { formatClock, formatCountdown } = CQ.i18n;

  let queue = [];
  let usage = null;
  let keepalive = null; // 自動重設狀態
  let autoReset = false;
  let sourceNote = ''; // 暫時提示（例如沒有開著的 claude.ai 分頁）
  const editing = new Set(); // 正在編輯的項目 id（重繪時保留狀態）

  CQ.i18n.applyI18n(document);

  function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
  }

  // ───────────── 用量 ─────────────

  function renderMeter(el, bucket) {
    const pctEl = el.querySelector('.pct');
    const fill = el.querySelector('.fill');
    const reset = el.querySelector('.reset');
    if (!bucket || bucket.pct == null) {
      pctEl.textContent = '--';
      fill.style.width = '0';
      reset.textContent = '';
      return;
    }
    const pct = Math.round(bucket.pct);
    pctEl.textContent = `${pct}%`;
    fill.style.width = `${Math.min(100, pct)}%`;
    fill.classList.toggle('full', pct >= 100);
    reset.textContent = bucket.resetsAt
      ? t('usageResetAt', { time: formatClock(bucket.resetsAt), countdown: formatCountdown(bucket.resetsAt - Date.now()) })
      : '';
  }

  function renderUsage() {
    renderMeter(document.getElementById('sessionMeter'), usage && usage.session);
    renderMeter(document.getElementById('weeklyMeter'), usage && usage.weekly);

    const status = document.getElementById('usageStatus');
    const source = document.getElementById('usageSource');
    status.className = 'status-line';
    if (!usage) {
      status.textContent = t('usageUnknownOpenClaude');
      source.textContent = sourceNote;
      return;
    }
    if (usage.full === true) {
      status.classList.add('full');
      status.textContent =
        t('usageFullUntil', {
          time: formatClock(usage.resetAt),
          countdown: formatCountdown(usage.resetAt - Date.now())
        }) + (usage.estimated ? t('estimatedSuffix') : '');
    } else if (usage.full === false) {
      status.classList.add('ok');
      status.textContent = t('usageAvailable');
    } else {
      status.textContent = t('usageUnknown');
    }
    const srcKey = {
      api: 'sourceApi',
      'api+dom': 'sourceApiDom',
      dom: 'sourceDom',
      simulated: 'sourceSimulated',
      none: 'sourceNone'
    }[usage.source] || 'sourceNone';
    const ago = Math.max(0, Math.round((Date.now() - usage.fetchedAt) / 60000));
    source.textContent =
      t('usageSourceLine', { source: t(srcKey), ago }) + (usage.error ? ` · ${t('usageEndpointError')}` : '') +
      (sourceNote ? ` · ${sourceNote}` : '');
  }

  // ───────────── 佇列 ─────────────

  function badgeFor(item) {
    if (item.claim) return { cls: 'sending', label: t('statusSending') };
    if (item.keepalive) return { cls: 'keepalive', label: t('popupKeepaliveTag') };
    if (item.draft && item.status === STATUS.READY) return { cls: 'draft', label: t('popupDraftTag') };
    return (
      {
        [STATUS.WAITING]: { cls: 'waiting', label: t('statusWaiting') },
        [STATUS.READY]: { cls: 'ready', label: t('statusReady') },
        [STATUS.FAILED]: { cls: 'failed', label: t('statusFailed') }
      }[item.status] || { cls: '', label: item.status }
    );
  }

  function convLabel(url) {
    try {
      const u = new URL(url);
      if (CQ.text.isNewChatUrl(url)) return u.pathname.startsWith('/project') ? t('convProject') : t('convNew');
      return u.pathname.replace(/^\/chat\//, '').slice(0, 8) + '…';
    } catch (_) {
      return url;
    }
  }

  function errorText(code) {
    const map = {
      'tab-closed-during-send': 'errTabClosed',
      'send-interrupted': 'errInterrupted',
      'not-detected': 'errNotDetected',
      'send-button-unavailable': 'errSendButton',
      'conversation-missing': 'reasonConversationMissing',
      'not-sent': 'reasonNotSent',
      uncertain: 'reasonUncertain',
      'fill-failed': 'reasonFillFailed',
      'editor-missing': 'reasonEditor',
      'stale-limit': 'reasonStaleLimit',
      duplicate: 'reasonDuplicate',
      'new-chat-url-unknown': 'reasonNewChatUrl',
      'attach-failed': 'reasonAttachFailed',
      'attachments-missing': 'reasonAttachmentsMissing',
      'composer-has-attachments': 'reasonComposerHasAttachments',
      'draft-save-failed': 'reasonGeneric',
      generic: 'reasonGeneric'
    };
    return map[code] ? t(map[code]) : t('errGeneric', { code });
  }

  function renderQueue() {
    const list = document.getElementById('queueList');
    const tpl = document.getElementById('itemTpl');
    const active = queue.filter((i) => i.status !== STATUS.SENT);
    const countable = active.filter((i) => !i.keepalive);
    document.getElementById('queueCount').textContent = countable.length ? `(${countable.length})` : '';
    document.getElementById('queueEmpty').hidden = active.length > 0;

    // 保留正在編輯的 textarea 內容
    const drafts = {};
    list.querySelectorAll('.item').forEach((li) => {
      const ta = li.querySelector('.editor');
      if (!ta.hidden) drafts[li.dataset.id] = ta.value;
    });
    list.textContent = '';

    for (const item of active) {
      const li = tpl.content.firstElementChild.cloneNode(true);
      CQ.i18n.applyI18n(li);
      li.dataset.id = item.id;
      const b = badgeFor(item);
      const badge = li.querySelector('.badge');
      badge.textContent = b.label;
      badge.classList.add(b.cls);
      const conv = li.querySelector('.conv');
      conv.textContent = convLabel(item.url);
      conv.href = item.url;
      conv.title = item.url;
      li.querySelector('.time').textContent = formatClock(item.createdAt);
      li.querySelector('.text').textContent = item.text;

      const atts = item.attachments || [];
      if (atts.length) {
        const files = li.querySelector('.files');
        files.hidden = false;
        files.textContent = t('popupFiles', {
          count: atts.length,
          size: CQ.text.formatBytes(atts.reduce((n, a) => n + (a.size || 0), 0)),
          names: atts.map((a) => a.name).join('、')
        });
        files.title = files.textContent;
      }

      const meta = li.querySelector('.meta');
      if (item.status === STATUS.WAITING) {
        meta.textContent = t('metaResetAt', {
          time: formatClock(item.resetAt),
          countdown: formatCountdown(item.resetAt - Date.now())
        });
        if (item.resetEstimated) {
          const est = document.createElement('span');
          est.className = 'est';
          est.textContent = t('estimatedSuffix');
          meta.appendChild(est);
        }
        if (item.checkGaveUp) meta.textContent += ' · ' + t('metaGaveUp');
      } else if (item.status === STATUS.READY) {
        meta.textContent = item.unverified ? t('metaReadyUnverified') : t('metaReady');
      }
      meta.dataset.resetAt = item.status === STATUS.WAITING ? item.resetAt : '';
      meta.dataset.estimated = item.resetEstimated ? '1' : '';

      if (item.lastError) {
        const err = li.querySelector('.error');
        err.hidden = false;
        err.textContent = errorText(item.lastError);
      }

      const sending = !!item.claim;
      li.querySelectorAll('button').forEach((btn) => (btn.disabled = sending));
      wireItem(li, item);
      if (editing.has(item.id)) enterEdit(li, item, drafts[item.id]);
      list.appendChild(li);
    }
  }

  function enterEdit(li, item, draft) {
    editing.add(item.id);
    const ta = li.querySelector('.editor');
    ta.hidden = false;
    ta.value = draft ?? item.text;
    li.querySelector('.text').hidden = true;
    li.querySelector('.btn-edit').hidden = true;
    li.querySelector('.btn-try').hidden = true;
    li.querySelector('.btn-save').hidden = false;
    li.querySelector('.btn-cancel-edit').hidden = false;
  }

  function wireItem(li, item) {
    li.querySelector('.btn-edit').addEventListener('click', () => {
      enterEdit(li, item);
      li.querySelector('.editor').focus();
    });
    li.querySelector('.btn-cancel-edit').addEventListener('click', () => {
      editing.delete(item.id);
      renderQueue();
    });
    li.querySelector('.btn-save').addEventListener('click', async () => {
      const text = li.querySelector('.editor').value;
      if (!text.trim()) return;
      const res = await send(MSG.QUEUE_UPDATE, { id: item.id, text });
      if (res && res.ok) editing.delete(item.id);
      else alert(t('popupSaveFailed'));
      renderQueue();
    });
    li.querySelector('.btn-try').addEventListener('click', async () => {
      await send(MSG.QUEUE_TRY_NOW, { id: item.id });
      window.close();
    });
    const del = li.querySelector('.btn-delete');
    let confirmTimer = null;
    del.addEventListener('click', async () => {
      // 兩段式確認，避免誤刪
      if (!del.classList.contains('confirming')) {
        del.classList.add('confirming');
        del.textContent = t('btnDeleteConfirm');
        confirmTimer = setTimeout(() => {
          del.classList.remove('confirming');
          del.textContent = t('btnDelete');
        }, 3000);
        return;
      }
      clearTimeout(confirmTimer);
      editing.delete(item.id);
      await send(MSG.QUEUE_DELETE, { id: item.id });
    });
  }

  // ───────────── 自動重設 ─────────────

  function renderKeepalive() {
    const el = document.getElementById('keepaliveStatus');
    if (!autoReset) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const st = keepalive || {};
    const now = Date.now();
    let text;
    const c = CQ.session.keepaliveCheck(usage, st, now);
    if ((st.failCount || 0) >= 3) {
      text = t('popupKeepalivePaused');
    } else if (c.endAt && (c.result === 'session-active' || c.result === 'recently-sent')) {
      text = t('popupKeepaliveNext', { time: formatClock(c.endAt + CQ.TIMING.KEEPALIVE_BUFFER_MS) });
    } else if (c.result === 'weekly-full') {
      text = t('popupKeepaliveWeeklyFull', { time: c.endAt ? formatClock(c.endAt) : '?' });
    } else if (c.result === 'no-usage-data') {
      text = t('popupKeepaliveNoData');
    } else {
      text = t('popupKeepaliveIdle');
    }
    if (st.lastError) text += ' · ' + t('popupKeepaliveLastError', { reason: errorText(st.lastError) });
    el.textContent = text;
  }

  // 每秒只更新倒數文字，不整個重繪（避免打斷編輯）
  function tick() {
    renderUsage();
    renderKeepalive();
    document.querySelectorAll('.item .meta').forEach((meta) => {
      const resetAt = Number(meta.dataset.resetAt);
      if (!resetAt) return;
      const li = meta.closest('.item');
      const item = queue.find((i) => i.id === li.dataset.id);
      if (!item) return;
      meta.textContent = t('metaResetAt', {
        time: formatClock(resetAt),
        countdown: formatCountdown(resetAt - Date.now())
      });
      if (meta.dataset.estimated) {
        const est = document.createElement('span');
        est.className = 'est';
        est.textContent = t('estimatedSuffix');
        meta.appendChild(est);
      }
      if (item.checkGaveUp) meta.textContent += ' · ' + t('metaGaveUp');
    });
  }

  // ───────────── 初始化 ─────────────

  async function init() {
    // 顯示目前載入的版本，方便確認更新是否已生效
    document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
    const data = await chrome.storage.local.get([K.QUEUE, K.USAGE, K.KEEPALIVE]);
    queue = data[K.QUEUE] || [];
    usage = data[K.USAGE] || null;
    keepalive = data[K.KEEPALIVE] || null;
    const settings = await CQ.settings.load();
    autoReset = settings.autoReset;
    document.getElementById('autoSendWarning').hidden = !settings.autoSend;
    renderKeepalive();
    renderUsage();
    renderQueue();
    setInterval(tick, 1000);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[K.QUEUE]) {
        queue = changes[K.QUEUE].newValue || [];
        renderQueue();
      }
      if (changes[K.USAGE]) {
        usage = changes[K.USAGE].newValue || null;
        renderUsage();
      }
      if (changes[K.SETTINGS]) {
        const ns = changes[K.SETTINGS].newValue || {};
        document.getElementById('autoSendWarning').hidden = !ns.autoSend;
        autoReset = !!ns.autoReset;
        renderKeepalive();
      }
      if (changes[K.KEEPALIVE]) {
        keepalive = changes[K.KEEPALIVE].newValue || null;
        renderKeepalive();
      }
    });

    document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
    const refreshBtn = document.getElementById('refresh');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        const res = await send(MSG.USAGE_REFRESH_REQUEST);
        sourceNote = res && res.noTab ? t('usageNeedTab') : '';
        renderUsage();
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }

  init();
})();
