/*
 * Content script 進入點：用量狀態與輪詢、佇列快取、SPA 換頁偵測、與 SW 的訊息。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('main');
  const { MSG, STORAGE_KEYS } = CQ;
  const t = CQ.t;

  if (CQ.__mainLoaded) return; // 防止重複注入
  CQ.__mainLoaded = true;

  // ───────────── 用量狀態 ─────────────
  // 快照存在 chrome.storage.local（由 SW 寫入），所有 claude.ai 分頁共享，
  // 任一分頁查詢後其他分頁會透過 onChanged 取得，避免多分頁重複輪詢。

  let snapshot = null;
  let inflight = null;

  function withTimeout(promise, ms) {
    if (!ms) return promise;
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
  }

  CQ.usageState = {
    current: () => snapshot,
    /** 重新查詢用量；超過 timeout 回傳 null（查詢仍會在背景完成並更新快照） */
    refresh({ timeout } = {}) {
      if (!inflight) {
        inflight = CQ.usage
          .getStatus()
          .then((snap) => {
            snapshot = snap;
            return CQ.bg
              .send(MSG.USAGE_SNAPSHOT, { snapshot: snap })
              .catch(() => {})
              .then(() => snap);
          })
          .catch((e) => {
            log.error('usage refresh failed', e);
            return null;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return withTimeout(inflight, timeout);
    }
  };

  function snapshotAge() {
    return snapshot && snapshot.fetchedAt ? Date.now() - snapshot.fetchedAt : Infinity;
  }

  let staleRefreshAt = 0;

  function pollTick() {
    const now = Date.now();
    const interval = CQ.settings.get().pollMinutes * 60 * 1000;
    // 背景分頁多等 30 秒，讓前景分頁優先負責輪詢
    const threshold = document.hidden ? interval + 30000 : interval - 5000;
    // 快照裡的重置時間已經過了 → 不等下一輪，馬上重抓（自動重設、等待中的訊息都靠它判斷）；最多每分鐘一次
    const stale =
      CQ.session.staleAfterReset(snapshot, now - (document.hidden ? 30000 : 0)) && now - staleRefreshAt > 60000;
    if (stale) staleRefreshAt = now;
    if (stale || snapshotAge() >= threshold) CQ.usageState.refresh();
  }

  // ───────────── 佇列快取（供手動送出比對） ─────────────

  let queue = [];
  CQ.queueCache = { get: () => queue };

  // ───────────── 初始化 ─────────────

  async function init() {
    await CQ.settings.ready;
    const data = await chrome.storage.local.get([STORAGE_KEYS.USAGE, STORAGE_KEYS.QUEUE]);
    snapshot = data[STORAGE_KEYS.USAGE] || null;
    queue = data[STORAGE_KEYS.QUEUE] || [];

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.USAGE]) snapshot = changes[STORAGE_KEYS.USAGE].newValue || null;
      if (changes[STORAGE_KEYS.QUEUE]) {
        queue = changes[STORAGE_KEYS.QUEUE].newValue || [];
        // 還原中的項目在別處被刪除 / 送出 → 關閉確認列
        const cur = CQ.restore.getCurrentId();
        if (cur && !queue.some((it) => it.id === cur)) CQ.ui.hideBar('gone');
      }
    });

    CQ.selectors.onMissing((name) => {
      CQ.ui.toast(t('toastSelectorMissing', { name }), { kind: 'error', duration: 15000 });
    });

    CQ.interceptor.install();

    // 聚焦輸入框時（準備打字送出）刷新一次用量，讓送出時的同步判斷更準
    document.addEventListener(
      'focusin',
      (e) => {
        if (CQ.selectors.closestEditor(e.target) && snapshotAge() > 30000) CQ.usageState.refresh();
      },
      true
    );

    setInterval(pollTick, 15000);
    pollTick();

    // SPA 換頁偵測（claude.ai 用 history API 切換對話，content script 不會重新載入）
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log.debug('url changed');
        CQ.interceptor.onNavigate();
        CQ.restore.onNavigate(); // 還原中離開原對話 → 中止，不會送到別的對話
        CQ.restore.check();
      }
    }, 500);

    // 等頁面渲染完成後檢查是否有指定給此分頁的還原工作；頁面載入慢時多檢查幾次（領到就不會重複）
    for (const delay of CQ.TIMING.RESTORE_CHECK_DELAYS_MS) setTimeout(() => CQ.restore.check(), delay);

    // 若設定變更（例如開啟模擬），立刻更新一次
    CQ.settings.onChange(() => CQ.usageState.refresh());

    log.info('content script ready');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === MSG.USAGE_REFRESH) {
      CQ.usageState.refresh({ timeout: 10000 }).then((snap) => sendResponse({ snapshot: snap }));
      return true;
    }
    if (msg.type === MSG.RESTORE_START) {
      // 忙碌時回 ok:false，SW 會保留工作，這個分頁處理完目前這則後再來領取
      const accepted = CQ.restore.start(msg.item, msg.mode, msg.attempt || {});
      sendResponse({ ok: accepted, busy: !accepted });
      return false;
    }
    return false;
  });

  init().catch((e) => log.error('init failed', e));
})(globalThis);
