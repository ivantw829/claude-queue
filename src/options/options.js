/*
 * Options：自動送出、通知、輪詢頻率、debug log、模擬用量已滿、清除所有資料。
 */
(function () {
  const { STORAGE_KEYS: K, MSG } = CQ;
  const t = CQ.t;
  const $ = (id) => document.getElementById(id);

  CQ.i18n.applyI18n(document);
  document.title = t('optionsTitle');
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  let savedTimer = null;
  function flashSaved(msg = t('optSaved')) {
    const el = $('saved');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  function render(s) {
    $('autoSend').checked = s.autoSend;
    $('notifications').checked = s.notifications;
    $('pollMinutes').value = s.pollMinutes;
    $('debugLog').checked = s.debugLog;
    $('debugSimulate').checked = s.debugSimulate;
    $('debugSimulateMinutes').value = s.debugSimulateMinutes;
    renderSimulateStatus(s);
  }

  function renderSimulateStatus(s = CQ.settings.get()) {
    const el = $('simulateStatus');
    if (!s.debugSimulate) {
      el.textContent = '';
      return;
    }
    const left = s.debugSimulateUntil - Date.now();
    el.textContent =
      left > 0
        ? t('optSimulateActive', { time: CQ.i18n.formatClock(s.debugSimulateUntil), countdown: CQ.i18n.formatCountdown(left) })
        : t('optSimulateEnded');
  }

  async function save(patch) {
    const s = await CQ.settings.update(patch);
    render(s);
    flashSaved();
  }

  $('autoSend').addEventListener('change', async (e) => {
    if (e.target.checked && !confirm(t('optAutoSendConfirm'))) {
      e.target.checked = false;
      return;
    }
    save({ autoSend: e.target.checked });
  });
  $('notifications').addEventListener('change', (e) => save({ notifications: e.target.checked }));
  $('pollMinutes').addEventListener('change', (e) => save({ pollMinutes: Number(e.target.value) }));
  $('debugLog').addEventListener('change', (e) => save({ debugLog: e.target.checked }));
  $('debugSimulate').addEventListener('change', (e) => {
    const minutes = Number($('debugSimulateMinutes').value) || 2;
    save({
      debugSimulate: e.target.checked,
      debugSimulateMinutes: minutes,
      debugSimulateUntil: e.target.checked ? Date.now() + minutes * 60000 : 0
    });
  });
  $('debugSimulateMinutes').addEventListener('change', (e) => {
    const minutes = Number(e.target.value) || 2;
    const s = CQ.settings.get();
    save({
      debugSimulateMinutes: minutes,
      debugSimulateUntil: s.debugSimulate ? Date.now() + minutes * 60000 : 0
    });
  });

  // ───────────── logs ─────────────

  function formatLog(e) {
    const d = new Date(e.ts);
    const time = d.toLocaleString('sv-SE').replace(' ', 'T') + '.' + String(d.getMilliseconds()).padStart(3, '0');
    const data = e.data !== undefined ? ' ' + JSON.stringify(e.data) : '';
    return `${time} ${e.level.toUpperCase().padEnd(5)} [${e.context}] ${e.msg}${data}`;
  }

  async function loadLogs() {
    const logs = (await chrome.storage.local.get(K.LOGS))[K.LOGS] || [];
    $('logs').value = logs.map(formatLog).join('\n');
    $('logs').scrollTop = $('logs').scrollHeight;
    $('logCount').textContent = t('optLogCount', { count: logs.length });
  }

  $('refreshLogs').addEventListener('click', loadLogs);
  $('copyLogs').addEventListener('click', async () => {
    const header = [
      `Claude Queue ${chrome.runtime.getManifest().version}`,
      navigator.userAgent,
      `settings: ${JSON.stringify(CQ.settings.get())}`,
      '---'
    ].join('\n');
    try {
      await navigator.clipboard.writeText(header + '\n' + $('logs').value);
      flashSaved(t('toastCopied'));
    } catch (_) {
      $('logs').select();
    }
  });
  $('clearLogs').addEventListener('click', async () => {
    await chrome.storage.local.set({ [K.LOGS]: [] });
    loadLogs();
  });

  $('clearAll').addEventListener('click', async () => {
    if (!confirm(t('optClearAllConfirm'))) return;
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_ALL });
    render(await CQ.settings.load());
    loadLogs();
    flashSaved(t('optCleared'));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[K.LOGS]) loadLogs();
  });
  CQ.settings.onChange(render);

  CQ.settings.load().then(render);
  loadLogs();
  setInterval(() => renderSimulateStatus(), 1000);
})();
