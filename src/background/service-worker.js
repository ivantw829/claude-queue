/*
 * Service worker：佇列的唯一寫入者、重置排程（chrome.alarms）、桌面通知、分頁協調。
 *
 * 所有佇列異動都經過這裡並用 promise 串列（mutex）序列化，
 * 避免多個 claude.ai 分頁與 popup 同時讀寫 chrome.storage 造成覆蓋或重複送出。
 */
importScripts(
  '/src/shared/constants.js',
  '/src/shared/i18n.js',
  '/src/shared/settings.js',
  '/src/shared/logger.js',
  '/src/shared/text.js'
);

const { STORAGE_KEYS: K, STATUS, ALARMS, TIMING, LIMITS, MSG } = CQ;
const t = CQ.t;
const log = CQ.logger.createLogger('sw');
const NOTIFY_READY = 'cq-ready';
const NOTIFY_FAILED = 'cq-check-failed';
const NOTIFY_AUTO_FAILED_PREFIX = 'cq-auto-failed:';
const CLAUDE_MATCH = 'https://claude.ai/*';
// 已交給某個分頁還原、但還沒取得 claim（例如倒數中）的項目，在這段時間內不會再被自動開啟
const RESTORING_TTL_MS = 3 * 60 * 1000;
// 新對話群組：第一則送出後等待網址回報的時間上限，逾時就標失敗（不冒險送到別的新對話）
const AWAIT_REBIND_TTL_MS = 2 * 60 * 1000;
const FAIL_REASON_KEYS = {
  'conversation-missing': 'reasonConversationMissing',
  'send-button-unavailable': 'reasonSendButton',
  'not-sent': 'reasonNotSent',
  uncertain: 'reasonUncertain',
  'fill-failed': 'reasonFillFailed',
  'editor-missing': 'reasonEditor',
  'stale-limit': 'reasonStaleLimit',
  duplicate: 'reasonDuplicate',
  'new-chat-url-unknown': 'reasonNewChatUrl'
};

// ─────────────────────────── mutex ───────────────────────────

let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ─────────────────────────── logs ───────────────────────────

let logBuffer = [];
let logFlushTimer = null;
CQ.logger.setSink((entry) => {
  logBuffer.push(entry);
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 500);
});
function flushLogs() {
  logFlushTimer = null;
  const batch = logBuffer;
  logBuffer = [];
  if (!batch.length) return;
  locked(async () => {
    const data = await chrome.storage.local.get(K.LOGS);
    const logs = (data[K.LOGS] || []).concat(batch).slice(-LIMITS.MAX_LOGS);
    await chrome.storage.local.set({ [K.LOGS]: logs });
  });
}

// ─────────────────────────── storage helpers ───────────────────────────

async function getQueue() {
  return (await chrome.storage.local.get(K.QUEUE))[K.QUEUE] || [];
}

async function saveQueue(queue) {
  queue.sort((a, b) => a.createdAt - b.createdAt);
  await chrome.storage.local.set({ [K.QUEUE]: queue });
  updateBadge(queue);
  return queue;
}

async function getVal(key, fallback) {
  const v = (await chrome.storage.local.get(key))[key];
  return v === undefined ? fallback : v;
}

async function addSentId(id) {
  const ids = await getVal(K.SENT_IDS, []);
  if (!ids.includes(id)) ids.push(id);
  await chrome.storage.local.set({ [K.SENT_IDS]: ids.slice(-LIMITS.MAX_SENT_IDS) });
}

// ─────────────────────────── badge ───────────────────────────

function updateBadge(queue) {
  const active = queue.filter((i) => i.status !== STATUS.SENT);
  const text = active.length ? String(active.length) : '';
  let color = '#d97757';
  if (active.some((i) => i.status === STATUS.FAILED)) color = '#c0392b';
  else if (active.some((i) => i.status === STATUS.READY)) color = '#2e8b57';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// ─────────────────────────── alarms ───────────────────────────

async function scheduleResetAlarm() {
  const queue = await getQueue();
  const waiting = queue.filter((i) => i.status === STATUS.WAITING && !i.checkGaveUp);
  if (!waiting.length) {
    await chrome.alarms.clear(ALARMS.RESET_CHECK);
    await chrome.storage.local.set({ [K.RESET_CHECK]: { attempt: 0, nextAt: null } });
    return;
  }
  const rc = await getVal(K.RESET_CHECK, { attempt: 0, nextAt: null });
  const earliest = Math.min(...waiting.map((i) => i.resetAt)) + TIMING.RESET_BUFFER_MS;
  const when = Math.max(rc.nextAt || earliest, Date.now() + 1000);
  const existing = await chrome.alarms.get(ALARMS.RESET_CHECK);
  if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
    await chrome.alarms.create(ALARMS.RESET_CHECK, { when });
    log.info('reset alarm scheduled', { when: new Date(when).toISOString(), attempt: rc.attempt });
  }
}

async function requestUsageFromTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CLAUDE_MATCH });
  } catch (e) {
    log.warn('tabs.query failed', { error: e.message });
  }
  tabs = tabs.filter((tb) => !tb.discarded).sort((a, b) => Number(b.active) - Number(a.active));
  for (const tab of tabs.slice(0, 3)) {
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: MSG.USAGE_REFRESH }),
        new Promise((r) => setTimeout(() => r(null), 12000))
      ]);
      if (res && res.snapshot) return res.snapshot;
    } catch (_) {
      // 該分頁的 content script 尚未載入（例如擴充功能剛更新），換下一個
    }
  }
  return null;
}

async function handleResetCheck() {
  const now = Date.now();
  const queue = await getQueue();
  const due = queue.filter(
    (i) => i.status === STATUS.WAITING && !i.checkGaveUp && i.resetAt <= now + 60 * 1000
  );
  if (!due.length) {
    await scheduleResetAlarm();
    return;
  }
  const rc = await getVal(K.RESET_CHECK, { attempt: 0, nextAt: null });
  const snap = await requestUsageFromTab();
  log.info('reset check', { due: due.length, attempt: rc.attempt, full: snap ? snap.full : 'no-tab' });

  if (!snap) {
    // 沒有開著的 claude.ai 分頁可以確認；先通知，開啟對話時頁面會再確認一次
    await markReady(due.map((i) => i.id), { unverified: true });
    return;
  }
  if (snap.full === false) {
    await markReady(due.map((i) => i.id), { unverified: false });
    return;
  }
  if (snap.full === null) {
    // 用量端點失敗、頁面上也沒有上限提示 → 很可能已重置，但無法確認
    await markReady(due.map((i) => i.id), { unverified: true });
    return;
  }
  // 仍然已滿
  if (snap.full === true && snap.resetAt && snap.resetAt > now + 3 * 60 * 1000) {
    // 拿到更晚的重置時間（例如同時碰到每週上限）→ 改排到新時間
    await locked(async () => {
      const q = await getQueue();
      for (const it of q) {
        if (due.some((d) => d.id === it.id)) {
          it.resetAt = snap.resetAt;
          it.resetEstimated = !!snap.estimated;
        }
      }
      await saveQueue(q);
      await chrome.storage.local.set({ [K.RESET_CHECK]: { attempt: 0, nextAt: null } });
    });
    await scheduleResetAlarm();
    return;
  }
  if (rc.attempt < TIMING.MAX_RETRIES) {
    const next = { attempt: rc.attempt + 1, nextAt: now + TIMING.RETRY_INTERVAL_MS };
    await chrome.storage.local.set({ [K.RESET_CHECK]: next });
    log.info('not reset yet, retry scheduled', next);
    await scheduleResetAlarm();
    return;
  }
  // 重試用盡
  log.warn('reset check gave up', { attempts: rc.attempt });
  await locked(async () => {
    const q = await getQueue();
    for (const it of q) if (due.some((d) => d.id === it.id)) it.checkGaveUp = true;
    await saveQueue(q);
    await chrome.storage.local.set({ [K.RESET_CHECK]: { attempt: 0, nextAt: null } });
  });
  await notify(NOTIFY_FAILED, t('notifyCheckFailedTitle'), t('notifyCheckFailedBody'));
  await scheduleResetAlarm();
}

async function markReady(ids, { unverified }) {
  const changed = await locked(async () => {
    const q = await getQueue();
    let n = 0;
    for (const it of q) {
      if (ids.includes(it.id) && it.status === STATUS.WAITING) {
        it.status = STATUS.READY;
        it.readyAt = Date.now();
        it.unverified = !!unverified;
        it.checkGaveUp = false;
        n++;
      }
    }
    if (n) await saveQueue(q);
    await chrome.storage.local.set({ [K.RESET_CHECK]: { attempt: 0, nextAt: null } });
    return n;
  });
  await scheduleResetAlarm();
  if (!changed) return;
  log.info('items ready', { count: changed, unverified });

  const settings = await CQ.settings.load();
  const body = t(unverified ? 'notifyReadyBodyUnverified' : 'notifyReadyBody', { count: changed });
  if (settings.autoSend) {
    await notify(NOTIFY_READY, t('notifyReadyTitle'), t('notifyAutoSendBody', { count: changed }));
    await openNext('auto');
  } else {
    await notify(NOTIFY_READY, t('notifyReadyTitle'), body);
  }
}

// ─────────────────────────── notifications ───────────────────────────

async function notify(id, title, message) {
  const settings = await CQ.settings.load();
  if (!settings.notifications) return;
  try {
    await chrome.notifications.clear(id);
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
      requireInteraction: id === NOTIFY_READY
    });
  } catch (e) {
    log.error('notification failed', e);
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  if (id === NOTIFY_READY) await openNext('manual');
  else if (id === NOTIFY_FAILED) await focusOrOpen('https://claude.ai/new');
  else if (id.startsWith(NOTIFY_AUTO_FAILED_PREFIX)) {
    const itemId = id.slice(NOTIFY_AUTO_FAILED_PREFIX.length);
    const it = (await getQueue()).find((i) => i.id === itemId);
    await focusOrOpen(it ? it.url : 'https://claude.ai/new');
  }
});

/** 自動送出無法完成時的通知（使用者可能不在電腦前） */
async function notifyAutoFailed(item, reason) {
  const key = FAIL_REASON_KEYS[reason] || 'reasonGeneric';
  await notify(
    NOTIFY_AUTO_FAILED_PREFIX + item.id,
    t('notifyAutoFailedTitle'),
    t('notifyAutoFailedBody', { reason: t(key) })
  );
}

// ─────────────────────────── 自動送出的項目選擇 ───────────────────────────

/**
 * 可以被「自動」開啟還原的項目：
 *  - ready、沒有送出鎖定、不是草稿
 *  - 沒有正在某個分頁還原中（倒數中等，避免同一則被開兩次）
 *  - 不在等待新對話網址（新對話群組的後續項目要等第一則建立對話後才知道要送去哪）
 *  - 同一個新對話群組中，前面沒有尚未送出的項目（確保依序送進同一個對話）
 */
function isAutoEligible(item, queue, now = Date.now()) {
  if (item.status !== STATUS.READY || item.claim || item.draft) return false;
  if (item.restoring && now - item.restoring.at < RESTORING_TTL_MS) return false;
  if (item.awaitRebind) return false;
  if (item.newChatGroup) {
    const earlier = queue.some(
      (o) =>
        o.id !== item.id &&
        o.newChatGroup === item.newChatGroup &&
        o.status !== STATUS.SENT &&
        o.createdAt < item.createdAt
    );
    if (earlier) return false;
  }
  return true;
}

/** 標記失敗＋通知（自動送出無法完成時使用）；token 不符代表別的分頁正在送，不動它 */
async function giveUp(id, token, reason) {
  const item = await locked(async () => {
    const q = await getQueue();
    const it = q.find((i) => i.id === id);
    if (!it) return null;
    if (it.claim && token && it.claim.token !== token) return null;
    if (it.claim && !token && Date.now() - it.claim.at < TIMING.CLAIM_TTL_MS) return null;
    it.claim = null;
    it.restoring = null;
    it.status = STATUS.FAILED;
    it.lastError = String(reason || 'unknown');
    await saveQueue(q);
    return it;
  });
  if (!item) return { ok: false };
  log.warn('auto send gave up', { id, reason });
  await notifyAutoFailed(item, reason);
  return { ok: true };
}

/** 自動模式下，這次還原結束後繼續處理其他可送的項目 */
async function continueAuto() {
  const settings = await CQ.settings.load();
  if (!settings.autoSend) return;
  await openNext('auto');
}

// ─────────────────────────── tabs ───────────────────────────

async function findTabFor(url) {
  const key = CQ.text.conversationKey(url);
  try {
    const tabs = await chrome.tabs.query({ url: CLAUDE_MATCH });
    return tabs.find((tb) => tb.url && CQ.text.conversationKey(tb.url) === key) || null;
  } catch (_) {
    return null;
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  try {
    // 視窗最小化時先還原，否則頁面在背景、輸入框拿不到焦點，填入可能失敗
    const win = await chrome.windows.get(tab.windowId);
    const opts = { focused: true };
    if (win && win.state === 'minimized') opts.state = 'normal';
    await chrome.windows.update(tab.windowId, opts);
  } catch (_) {}
}

async function focusOrOpen(url) {
  const tab = await findTabFor(url);
  if (tab) await focusTab(tab);
  else await chrome.tabs.create({ url, active: true });
}

async function setRestoring(id, tabId) {
  await locked(async () => {
    const q = await getQueue();
    const it = q.find((i) => i.id === id);
    if (!it) return;
    it.restoring = { tabId, at: Date.now() };
    await saveQueue(q);
  });
}

/**
 * 開啟（或切換到）項目的原對話，並指派還原工作給該分頁。
 * attempt：{ retries, reopened }，由重新整理重試 / 重新開啟流程沿用，避免無限循環。
 */
async function openItem(item, mode, attempt = {}) {
  const at = { retries: attempt.retries || 0, reopened: attempt.reopened || 0 };
  const tab = await findTabFor(item.url);
  if (tab) {
    await focusTab(tab);
    await setRestoring(item.id, tab.id);
    await chrome.storage.local.set({
      [K.PENDING_RESTORE]: { itemId: item.id, tabId: tab.id, mode, at: Date.now(), ...at }
    });
    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: MSG.RESTORE_START, item, mode, attempt: at });
    } catch (_) {
      // content script 尚未就緒（例如擴充功能剛重新載入）→ 重新整理分頁，載入後會來領取
      log.info('content not ready, reloading tab', { id: item.id });
      await chrome.tabs.reload(tab.id);
      return;
    }
    if (res && res.ok) {
      await chrome.storage.local.remove(K.PENDING_RESTORE);
      log.info('restore started in existing tab', { id: item.id });
    } else {
      // 分頁正在處理另一則，pendingRestore 保留，那一則結束後分頁會來領取
      log.info('tab busy, restore left pending', { id: item.id });
    }
  } else {
    const created = await chrome.tabs.create({ url: item.url, active: true });
    await setRestoring(item.id, created.id);
    await chrome.storage.local.set({
      [K.PENDING_RESTORE]: { itemId: item.id, tabId: created.id, mode, at: Date.now(), ...at }
    });
    log.info('opened new tab for restore', { id: item.id });
  }
}

async function openNext(mode, itemId) {
  const queue = await getQueue();
  const now = Date.now();
  const candidates =
    mode === 'auto'
      ? queue.filter((i) => isAutoEligible(i, queue, now))
      : queue.filter((i) => i.status === STATUS.READY && !i.claim && !i.draft && !i.awaitRebind);
  const item = itemId ? queue.find((i) => i.id === itemId) : candidates[0];
  if (!item) {
    log.info('openNext: no ready item', { mode });
    return;
  }
  await openItem(item, mode);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  locked(async () => {
    const pending = await getVal(K.PENDING_RESTORE, null);
    if (pending && pending.tabId === tabId) await chrome.storage.local.remove(K.PENDING_RESTORE);
    // 送出過程中分頁被關閉 → 無法確定是否已送出，標記失敗讓使用者確認（不自動重送，避免重複）
    const q = await getQueue();
    let changed = false;
    for (const it of q) {
      if (it.restoring && it.restoring.tabId === tabId) {
        it.restoring = null;
        changed = true;
      }
      if (it.claim && it.claim.tabId === tabId) {
        it.claim = null;
        it.status = STATUS.FAILED;
        it.lastError = 'tab-closed-during-send';
        changed = true;
      }
    }
    if (changed) {
      log.warn('tab closed during send', { tabId });
      await saveQueue(q);
    }
  });
});

// ─────────────────────────── reconcile（啟動時重建） ───────────────────────────

async function reconcile() {
  await locked(async () => {
    const q = await getQueue();
    const now = Date.now();
    let changed = false;
    for (const it of q) {
      if (it.claim && now - it.claim.at > TIMING.CLAIM_TTL_MS) {
        it.claim = null;
        it.status = STATUS.FAILED;
        it.lastError = 'send-interrupted';
        changed = true;
      }
      if (it.awaitRebind && now - it.awaitRebind > AWAIT_REBIND_TTL_MS) {
        // 新對話群組的第一則送出後，一直沒回報新對話網址 → 不確定要送去哪，不冒險
        it.awaitRebind = null;
        it.status = STATUS.FAILED;
        it.lastError = 'new-chat-url-unknown';
        changed = true;
      }
    }
    const kept = q.filter((i) => i.status !== STATUS.SENT);
    if (kept.length !== q.length) changed = true;
    if (changed) await saveQueue(kept);
    else updateBadge(q);

    const pending = await getVal(K.PENDING_RESTORE, null);
    if (pending && now - pending.at > TIMING.PENDING_RESTORE_TTL_MS) {
      await chrome.storage.local.remove(K.PENDING_RESTORE);
    }
  });
  await scheduleResetAlarm();
}

chrome.runtime.onInstalled.addListener(() => reconcile());
chrome.runtime.onStartup.addListener(() => reconcile()); // 瀏覽器重啟後 alarms 可能遺失 → 依佇列重建
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.RESET_CHECK) {
    handleResetCheck().catch((e) => log.error('reset check failed', e));
  }
});

// ─────────────────────────── 訊息處理 ───────────────────────────

const handlers = {
  async [MSG.QUEUE_ADD]({ item }) {
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!text.trim()) return { ok: false, error: 'empty text' };
    if (text.length > 200000) return { ok: false, error: 'text too long' };
    const now = Date.now();
    const newItem = {
      id: CQ.text.uuid(),
      text,
      url: String(item.url || 'https://claude.ai/new'),
      createdAt: now,
      resetAt: Number(item.resetAt) > now ? Number(item.resetAt) : now + TIMING.FALLBACK_RESET_MS,
      resetEstimated: !!item.resetEstimated || !(Number(item.resetAt) > now),
      reasons: Array.isArray(item.reasons) ? item.reasons.slice(0, 5) : [],
      // 草稿：自動送出時從輸入框救下來的你的草稿，不會被自動送出
      draft: !!item.draft,
      // 新對話群組：同一次在新對話頁排的多則，之後要依序送進同一個新對話
      newChatGroup: typeof item.newChatGroup === 'string' ? item.newChatGroup.slice(0, 64) : null,
      status: item.draft ? STATUS.READY : STATUS.WAITING,
      attempts: 0,
      lastError: null,
      claim: null
    };
    const saved = await locked(async () => {
      const q = await getQueue();
      q.push(newItem);
      await saveQueue(q);
      // 讀回確認真的寫入成功，content script 收到 ok 才會清空輸入框
      const verify = await getQueue();
      return verify.some((i) => i.id === newItem.id && i.text === text);
    });
    if (!saved) return { ok: false, error: 'storage verify failed' };
    log.info('queued', {
      id: newItem.id,
      length: text.length,
      resetAt: newItem.resetAt,
      draft: newItem.draft,
      group: !!newItem.newChatGroup
    });
    await scheduleResetAlarm();
    return { ok: true, item: newItem };
  },

  async [MSG.QUEUE_UPDATE]({ id, text }) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty text' };
    return locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: false, error: 'not found' };
      if (it.claim) return { ok: false, error: 'sending' };
      it.text = text;
      await saveQueue(q);
      return { ok: true };
    });
  },

  async [MSG.QUEUE_DELETE]({ id }) {
    await locked(async () => {
      const q = await getQueue();
      await saveQueue(q.filter((i) => i.id !== id));
    });
    log.info('deleted', { id });
    await scheduleResetAlarm();
    return { ok: true };
  },

  async [MSG.QUEUE_TRY_NOW]({ id }) {
    const item = await locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it || it.claim) return null;
      it.status = STATUS.READY;
      it.lastError = null;
      it.checkGaveUp = false;
      await saveQueue(q);
      return it;
    });
    if (!item) return { ok: false, error: 'not available' };
    await scheduleResetAlarm();
    await openItem(item, 'manual');
    return { ok: true };
  },

  async [MSG.QUEUE_CLAIM]({ id }, sender) {
    return locked(async () => {
      const sentIds = await getVal(K.SENT_IDS, []);
      if (sentIds.includes(id)) return { ok: false, reason: 'sent' };
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: false, reason: 'not-found' };
      if (it.status === STATUS.SENT) return { ok: false, reason: 'sent' };
      if (it.claim && Date.now() - it.claim.at < TIMING.CLAIM_TTL_MS) return { ok: false, reason: 'claimed' };
      const token = CQ.text.uuid();
      it.claim = { token, tabId: sender.tab ? sender.tab.id : null, at: Date.now() };
      it.attempts = (it.attempts || 0) + 1;
      await saveQueue(q);
      log.info('claimed', { id, attempt: it.attempts });
      return { ok: true, token };
    });
  },

  async [MSG.QUEUE_MARK_SENT]({ id, token, confidence, edited }) {
    return locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (it && it.claim && it.claim.token !== token) return { ok: false, error: 'token mismatch' };
      if (it) it.status = STATUS.SENT;
      if (it && it.newChatGroup) {
        // 新對話群組的後續項目要等這一則建立的對話網址（QUEUE_REBIND）才能送
        for (const o of q) {
          if (o.id !== id && o.newChatGroup === it.newChatGroup && o.status !== STATUS.SENT) {
            o.awaitRebind = Date.now();
          }
        }
      }
      await addSentId(id);
      await saveQueue(q.filter((i) => i.id !== id)); // 送出成功才移除
      log.info('marked sent', { id, confidence, edited: !!edited });
      return { ok: true };
    });
  },

  async [MSG.QUEUE_MARK_SENT_BY_TEXT]({ id, by }) {
    return locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: true };
      if (it.claim) return { ok: false, error: 'sending' };
      await addSentId(id);
      await saveQueue(q.filter((i) => i.id !== id));
      log.info('marked sent (manual)', { id, by });
      return { ok: true };
    });
  },

  async [MSG.QUEUE_MARK_FAILED]({ id, token, error }) {
    return locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: false, error: 'not found' };
      if (it.claim && it.claim.token !== token) return { ok: false, error: 'token mismatch' };
      it.claim = null;
      it.restoring = null;
      it.status = STATUS.FAILED;
      it.lastError = String(error || 'unknown');
      await saveQueue(q);
      log.warn('marked failed', { id, error: it.lastError });
      return { ok: true };
    });
  },

  async [MSG.QUEUE_RELEASE]({ id, token, status, resetAt, resetEstimated }) {
    const res = await locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: false, error: 'not found' };
      if (it.claim && it.claim.token !== token) return { ok: false, error: 'claimed by another' };
      it.claim = null;
      it.restoring = null;
      it.status = status === STATUS.WAITING ? STATUS.WAITING : STATUS.READY;
      if (it.status === STATUS.WAITING && Number(resetAt) > Date.now()) {
        it.resetAt = Number(resetAt);
        it.resetEstimated = !!resetEstimated;
      }
      await saveQueue(q);
      return { ok: true };
    });
    await scheduleResetAlarm();
    return res;
  },

  async [MSG.RESTORE_CHECK](_msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    return locked(async () => {
      const pending = await getVal(K.PENDING_RESTORE, null);
      if (!pending || pending.tabId !== tabId) return { item: null };
      if (Date.now() - pending.at > TIMING.PENDING_RESTORE_TTL_MS) {
        await chrome.storage.local.remove(K.PENDING_RESTORE);
        return { item: null };
      }
      const q = await getQueue();
      const item = q.find((i) => i.id === pending.itemId && !i.claim && i.status !== STATUS.SENT);
      await chrome.storage.local.remove(K.PENDING_RESTORE); // 只領取一次，重新整理不會重複填入
      return item
        ? { item, mode: pending.mode, attempt: { retries: pending.retries || 0, reopened: pending.reopened || 0 } }
        : { item: null };
    });
  },

  async [MSG.RESTORE_NEXT]({ url, peek }) {
    const key = CQ.text.conversationKey(url);
    const q = await getQueue();
    const now = Date.now();
    // 同一對話的下一則：規則與自動開啟相同，但「還原中」標記可能就是這個分頁自己留下的，所以不看它
    const item = q.find(
      (i) =>
        CQ.text.conversationKey(i.url) === key && isAutoEligible({ ...i, restoring: null }, q, now)
    );
    if (!item) return { item: null };
    if (peek) return { item: { id: item.id } };
    const settings = await CQ.settings.load();
    return { item, mode: settings.autoSend ? 'auto' : 'manual' };
  },

  /** 確定還沒送出、但頁面狀態不對 → 重新整理分頁後重試（有上限） */
  async [MSG.RESTORE_RETRY]({ id, token, reason, mode, attempt }, sender) {
    const tabId = sender.tab && sender.tab.id;
    const retries = ((attempt && attempt.retries) || 0) + 1;
    if (retries > LIMITS.MAX_RESTORE_RETRIES || tabId == null) {
      const r = await giveUp(id, token, reason);
      await continueAuto();
      return { ok: false, gaveUp: r.ok };
    }
    const ok = await locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it || it.status === STATUS.SENT) return false;
      if (it.claim && it.claim.token !== token) return false;
      it.claim = null;
      it.status = STATUS.READY;
      it.restoring = { tabId, at: Date.now() };
      await saveQueue(q);
      await chrome.storage.local.set({
        [K.PENDING_RESTORE]: {
          itemId: id,
          tabId,
          mode: mode || 'auto',
          at: Date.now(),
          retries,
          reopened: (attempt && attempt.reopened) || 0
        }
      });
      return true;
    });
    if (!ok) return { ok: false };
    log.info('restore retry: reloading tab', { id, reason, retries });
    await chrome.tabs.reload(tabId);
    return { ok: true };
  },

  /** 目前分頁不是項目的原對話 → 重新開啟正確的對話（只試一次，仍不符就放棄，絕不送到別的對話） */
  async [MSG.RESTORE_REOPEN]({ id, token, mode, attempt }) {
    const reopened = ((attempt && attempt.reopened) || 0) + 1;
    if (reopened > 1) {
      const r = await giveUp(id, token, 'conversation-missing');
      await continueAuto();
      return { ok: false, gaveUp: r.ok };
    }
    const item = await locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it || it.status === STATUS.SENT) return null;
      if (it.claim && it.claim.token !== token) return null;
      it.claim = null;
      it.restoring = null;
      it.status = STATUS.READY;
      await saveQueue(q);
      return it;
    });
    if (!item) return { ok: false };
    log.info('restore reopen in correct conversation', { id });
    await openItem(item, mode || 'auto', { retries: (attempt && attempt.retries) || 0, reopened });
    return { ok: true };
  },

  async [MSG.RESTORE_GIVE_UP]({ id, token, reason }) {
    const r = await giveUp(id, token, reason);
    await continueAuto();
    return r;
  },

  /** 這個分頁的還原工作告一段落 → 自動模式繼續處理其他對話的項目 */
  async [MSG.RESTORE_DONE]() {
    await continueAuto();
    return { ok: true };
  },

  /** 新對話群組：第一則送出後建立的對話網址；url 為 null 代表沒取得 → 後續項目標失敗 */
  async [MSG.QUEUE_REBIND]({ group, url }) {
    if (!group) return { ok: false };
    const valid = typeof url === 'string' && /^https:\/\/claude\.ai\//.test(url) && !CQ.text.isNewChatUrl(url);
    const failed = await locked(async () => {
      const q = await getQueue();
      const out = [];
      for (const it of q) {
        if (it.newChatGroup !== group || it.status === STATUS.SENT) continue;
        it.awaitRebind = null;
        if (valid) {
          it.url = url;
        } else {
          it.status = STATUS.FAILED;
          it.lastError = 'new-chat-url-unknown';
          out.push(it);
        }
      }
      await saveQueue(q);
      return out;
    });
    log.info('new chat group rebound', { valid, failed: failed.length });
    for (const it of failed) await notifyAutoFailed(it, 'new-chat-url-unknown');
    return { ok: valid };
  },

  async [MSG.USAGE_SNAPSHOT]({ snapshot }) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false };
    await chrome.storage.local.set({ [K.USAGE]: snapshot });
    // 輪詢時發現已恢復 → 提早把等待中的項目標為 ready
    const trusted = ['api', 'simulated'].includes(snapshot.source);
    if (snapshot.full === false && trusted) {
      const now = Date.now();
      const q = await getQueue();
      const ids = q
        .filter((i) => i.status === STATUS.WAITING)
        // 只因頁面提示（DOM）被擋的項目，API 未滿不代表能送（可能是模型別上限），等到預估時間再說
        .filter((i) => !(i.reasons && i.reasons.length === 1 && i.reasons[0] === 'dom') || i.resetAt <= now)
        .map((i) => i.id);
      if (ids.length) await markReady(ids, { unverified: false });
    }
    return { ok: true };
  },

  async [MSG.USAGE_REFRESH_REQUEST]() {
    const snapshot = await requestUsageFromTab();
    return { snapshot, noTab: !snapshot };
  },

  async [MSG.CLEAR_ALL]() {
    await locked(async () => {
      await chrome.storage.local.clear();
    });
    await chrome.alarms.clearAll();
    updateBadge([]);
    await CQ.settings.load();
    return { ok: true };
  },

  async [MSG.LOG]({ entry }) {
    if (entry && typeof entry === 'object') {
      logBuffer.push(entry);
      if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 500);
    }
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res))
    .catch((e) => {
      log.error(`handler ${msg.type} failed`, e);
      sendResponse({ error: e.message || String(e) });
    });
  return true; // 非同步回應
});

// SW 每次被喚醒都做一次輕量檢查（確保 alarms 存在、清掉逾時鎖定）
reconcile().catch((e) => log.error('reconcile failed', e));
