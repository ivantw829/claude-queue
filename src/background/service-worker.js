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
  '/src/shared/text.js',
  '/src/shared/session.js',
  '/src/shared/version.js',
  '/src/background/filestore.js'
);

const { STORAGE_KEYS: K, STATUS, ALARMS, TIMING, LIMITS, MSG } = CQ;
const t = CQ.t;
const log = CQ.logger.createLogger('sw');
const NOTIFY_READY = 'cq-ready';
const NOTIFY_FAILED = 'cq-check-failed';
const NOTIFY_AUTO_FAILED_PREFIX = 'cq-auto-failed:';
const NOTIFY_KEEPALIVE_FAILED = 'cq-keepalive-failed';
const NOTIFY_UPDATE = 'cq-update';
const NEW_CHAT_URL = 'https://claude.ai/new';
// 自動重設連續失敗幾次後暫停（直到看到工作階段重新開始，或重新開啟設定）
const KEEPALIVE_MAX_FAILS = 3;
// 自動重設項目一直沒被分頁領取的時間上限（逾時就移除，下次再試）
const KEEPALIVE_STALE_MS = 15 * 60 * 1000;
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
  'new-chat-url-unknown': 'reasonNewChatUrl',
  'attach-failed': 'reasonAttachFailed',
  'attachments-missing': 'reasonAttachmentsMissing',
  'composer-has-attachments': 'reasonComposerHasAttachments'
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
  await gcFiles(queue);
  return queue;
}

/**
 * 刪除已不在佇列中的項目的附件（送出、刪除、取消、失敗移除都會經過 saveQueue，在這裡集中處理）。
 * 檔案清理失敗不影響佇列本身。
 */
async function gcFiles(queue) {
  try {
    const n = await CQ.fileStore.gc(queue.map((i) => i.id));
    if (n) log.info('attachments removed', { count: n });
  } catch (e) {
    log.warn('attachment gc failed', { error: e.message });
  }
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
  // 自動重設的項目是內部工作，不算在徽章數字裡
  const active = queue.filter((i) => i.status !== STATUS.SENT && !i.keepalive);
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
  else if (id === NOTIFY_FAILED) await focusOrOpen(NEW_CHAT_URL);
  else if (id === NOTIFY_KEEPALIVE_FAILED) {
    const st = await getKeepaliveState();
    await focusOrOpen(st.conversationUrl || NEW_CHAT_URL);
  }
  else if (id === NOTIFY_UPDATE) await chrome.tabs.create({ url: CQ.version.UPDATE_GUIDE_URL });
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
    if (it.keepalive) {
      // 自動重設不留下失敗項目，直接移除
      await saveQueue(q.filter((i) => i.id !== id));
      return it;
    }
    it.claim = null;
    it.restoring = null;
    it.status = STATUS.FAILED;
    it.lastError = String(reason || 'unknown');
    await saveQueue(q);
    return it;
  });
  if (!item) return { ok: false };
  log.warn('auto send gave up', { id, reason, keepalive: !!item.keepalive });
  if (item.keepalive) await keepaliveFailed(item, reason, { notify: true });
  else await notifyAutoFailed(item, reason);
  return { ok: true };
}

/** 自動模式下，這次還原結束後繼續處理其他可送的項目 */
async function continueAuto() {
  const settings = await CQ.settings.load();
  if (!settings.autoSend) return;
  await openNext('auto');
}

// ─────────────────────────── 自動重設（keepalive） ───────────────────────────
//
// claude.ai 的 5 小時工作階段在送出第一則訊息時才開始倒數。工作階段結束後如果沒人送訊息，
// 就會一直停在「歸零」。開啟「自動重設」後，工作階段一結束就送出一則短訊息（預設 Hello World!）
// 到一個固定的專用對話，讓下一個工作階段馬上開始倒數。
// 送出本身沿用佇列的自動送出流程（keepalive 項目），所以一樣有 claim、對話確認、用量再確認等保護。

let kaChain = Promise.resolve();
async function getKeepaliveState() {
  return {
    conversationUrl: null,
    lastAttemptAt: 0,
    lastSentAt: 0,
    lastError: null,
    failCount: 0,
    ...((await getVal(K.KEEPALIVE, null)) || {})
  };
}
function setKeepaliveState(patch) {
  const p = kaChain.then(async () => {
    const next = { ...(await getKeepaliveState()), ...patch };
    await chrome.storage.local.set({ [K.KEEPALIVE]: next });
    return next;
  });
  kaChain = p.catch(() => {});
  return p;
}

/**
 * 自動重設的狀態判斷（CQ.session.keepaliveCheck，只看 API，不看頁面上的上限提示）。
 * 結果寫進 keepalive.lastCheck，就算沒開 debug log，也能在設定頁看到最後一次檢查的結論。
 */
function checkKeepalive(snap, state, now = Date.now()) {
  return CQ.session.keepaliveCheck(snap, state, now);
}

async function recordCheck(why, result, extra = {}) {
  await setKeepaliveState({ lastCheck: { at: Date.now(), why, result, ...extra } });
  log.info('keepalive check', { why, result, ...extra });
}

async function scheduleKeepaliveAlarm(snap) {
  const settings = await CQ.settings.load();
  if (!settings.autoReset) {
    await chrome.alarms.clear(ALARMS.KEEPALIVE);
    return;
  }
  const state = await getKeepaliveState();
  const now = Date.now();
  const c = checkKeepalive(snap, state, now);
  let when = null;
  if (c.result === 'session-active' || c.result === 'recently-sent') {
    when = c.endAt + TIMING.KEEPALIVE_BUFFER_MS;
  } else if (c.result === 'weekly-full') {
    // 每週上限已滿 → 等它重置後再看（不知道時間就每小時看一次）
    when = c.endAt ? c.endAt + TIMING.KEEPALIVE_BUFFER_MS : now + 60 * 60 * 1000;
  } else if (c.result === 'no-usage-data' && state.lastKnownEnd > now) {
    // 讀不到用量，但知道上一個工作階段何時結束 → 到時候再看
    when = state.lastKnownEnd + TIMING.KEEPALIVE_BUFFER_MS;
  } else if (state.failCount < KEEPALIVE_MAX_FAILS) {
    // 已歸零但這次還不能送（冷卻中、佇列正在送…），或讀不到用量 → 稍後再檢查
    when = Math.max(state.lastAttemptAt + TIMING.KEEPALIVE_COOLDOWN_MS, now + 60 * 1000);
  }
  if (!when) {
    await chrome.alarms.clear(ALARMS.KEEPALIVE);
    return;
  }
  const existing = await chrome.alarms.get(ALARMS.KEEPALIVE);
  if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
    await chrome.alarms.create(ALARMS.KEEPALIVE, { when });
    log.info('keepalive alarm scheduled', { when: new Date(when).toISOString(), result: c.result });
  }
}

/**
 * 把自動重設訊息加進佇列並開啟專用對話。回傳結果字串（寫進 lastCheck）。
 * unverified：沒有 API 用量資料可以確認（沒有開著的分頁，或端點讀取失敗）→ 交給頁面再確認
 * force：略過冷卻（專用對話被刪除、改開新對話時）
 */
async function triggerKeepalive(why, { unverified = false, force = false } = {}) {
  const settings = await CQ.settings.load();
  if (!settings.autoReset) return 'disabled';
  const state = await getKeepaliveState();
  const now = Date.now();
  if (state.failCount >= KEEPALIVE_MAX_FAILS) return 'paused';
  if (!force && now - state.lastAttemptAt < TIMING.KEEPALIVE_COOLDOWN_MS) return 'cooldown';

  const item = await locked(async () => {
    const q = await getQueue();
    if (q.some((i) => i.keepalive)) return 'already-queued';
    // 佇列的訊息正在送（或開著自動送出且有可送的訊息）→ 那則訊息本身就會開始新的工作階段
    if (q.some((i) => i.claim || (i.restoring && now - i.restoring.at < RESTORING_TTL_MS))) return 'queue-busy';
    if (settings.autoSend && q.some((i) => isAutoEligible(i, q, now))) return 'queue-busy';
    const it = {
      id: CQ.text.uuid(),
      text: settings.autoResetText,
      url: state.conversationUrl || NEW_CHAT_URL,
      createdAt: now,
      resetAt: now,
      resetEstimated: false,
      reasons: [],
      keepalive: true,
      draft: false,
      newChatGroup: null,
      status: STATUS.READY,
      attempts: 0,
      lastError: null,
      claim: null
    };
    q.push(it);
    await saveQueue(q);
    return it;
  });
  if (typeof item === 'string') return item;
  await setKeepaliveState({ lastAttemptAt: now });
  log.info('keepalive triggered', { why, unverified, newChat: !state.conversationUrl });
  await openItem(item, 'auto');
  return 'triggered';
}

/** 沒有 API 資料時，只有在「知道上一個工作階段已經結束、而且之後沒送過」時才送 */
function knownEndedWithoutApi(state, now) {
  if (state.lastKnownEnd && state.lastKnownEnd > now) return false; // 工作階段還在進行
  if (state.lastSentAt && state.lastSentAt + TIMING.SESSION_LENGTH_MS > now) return false; // 剛送過
  return true;
}

async function evaluateKeepalive(snap, why) {
  const settings = await CQ.settings.load();
  if (!settings.autoReset) return;
  const now = Date.now();
  let state = await getKeepaliveState();
  const c = checkKeepalive(snap, state, now);

  if (c.result === 'session-active') {
    // 記下工作階段結束時間（之後讀不到用量時用來判斷）；你自己用了 Claude → 清掉連續失敗次數
    const patch = {};
    if (state.lastKnownEnd !== c.endAt) patch.lastKnownEnd = c.endAt;
    if (state.failCount) patch.failCount = 0;
    if (Object.keys(patch).length) state = await setKeepaliveState(patch);
  }

  let result = c.result;
  if (c.idle) {
    result = await triggerKeepalive(why);
  } else if (c.result === 'no-usage-data' && state.lastKnownEnd && knownEndedWithoutApi(state, now)) {
    // 用量端點讀取失敗，但上一個工作階段確定已經結束 → 開啟對話，由頁面再確認
    result = await triggerKeepalive(why, { unverified: true });
  }
  await recordCheck(why, result, c.endAt ? { endAt: c.endAt } : {});
  await scheduleKeepaliveAlarm(snap);
}

async function handleKeepaliveAlarm() {
  const settings = await CQ.settings.load();
  if (!settings.autoReset) return;
  // 分頁查詢用量時也會回報 USAGE_SNAPSHOT（同樣會評估）；重複觸發由「佇列中已有自動重設項目」擋下
  const snap = await requestUsageFromTab();
  log.info('keepalive alarm', { hasTab: !!snap });
  if (snap) {
    await evaluateKeepalive(snap, 'alarm');
    return;
  }
  // 沒有可以查詢的 claude.ai 分頁（沒開、被凍結或被 Chrome 的記憶體節省功能丟棄）
  // → 直接開啟專用對話，頁面載入後會再確認工作階段是否真的歸零
  const state = await getKeepaliveState();
  const result = knownEndedWithoutApi(state, Date.now())
    ? await triggerKeepalive('alarm-no-tab', { unverified: true })
    : 'session-active';
  await recordCheck('alarm-no-tab', result);
  await scheduleKeepaliveAlarm(await getVal(K.USAGE, null));
}

async function keepaliveSent() {
  await setKeepaliveState({ lastSentAt: Date.now(), lastError: null, failCount: 0 });
  log.info('keepalive sent');
  await scheduleKeepaliveAlarm(await getVal(K.USAGE, null));
}

async function keepaliveFailed(item, reason, { notify: shouldNotify }) {
  reason = String(reason || 'unknown');
  if (reason === 'conversation-missing') {
    // 專用對話不見了（被刪除）→ 忘記它，改開新對話再試一次
    await setKeepaliveState({ conversationUrl: null, lastError: reason });
    log.warn('keepalive conversation missing, retrying in a new chat');
    if (!CQ.text.isNewChatUrl(item.url)) {
      await triggerKeepalive('conversation-missing', { unverified: true, force: true });
      return;
    }
  }
  const st = await setKeepaliveState({
    lastError: reason,
    failCount: (await getKeepaliveState()).failCount + 1
  });
  log.warn('keepalive failed', { reason, failCount: st.failCount });
  if (shouldNotify || st.failCount >= KEEPALIVE_MAX_FAILS) {
    const key = FAIL_REASON_KEYS[reason] || 'reasonGeneric';
    await notify(
      NOTIFY_KEEPALIVE_FAILED,
      t('notifyKeepaliveFailedTitle'),
      t(st.failCount >= KEEPALIVE_MAX_FAILS ? 'notifyKeepalivePausedBody' : 'notifyKeepaliveFailedBody', {
        reason: t(key)
      })
    );
  }
  await scheduleKeepaliveAlarm(await getVal(K.USAGE, null));
}

async function onKeepaliveToggled(enabled) {
  if (!enabled) {
    await chrome.alarms.clear(ALARMS.KEEPALIVE);
    await locked(async () => {
      const q = await getQueue();
      const kept = q.filter((i) => !i.keepalive || i.claim);
      if (kept.length !== q.length) await saveQueue(kept);
    });
    log.info('keepalive disabled');
    return;
  }
  await setKeepaliveState({ failCount: 0, lastError: null });
  log.info('keepalive enabled');
  const snap = await requestUsageFromTab();
  if (snap) await evaluateKeepalive(snap, 'enabled');
  else await scheduleKeepaliveAlarm(await getVal(K.USAGE, null));
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
      : queue.filter(
          (i) => i.status === STATUS.READY && !i.claim && !i.draft && !i.awaitRebind && !i.keepalive
        );
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
    let q = await getQueue();
    let changed = false;
    const droppedKeepalive = [];
    for (const it of q) {
      if (it.restoring && it.restoring.tabId === tabId) {
        it.restoring = null;
        changed = true;
      }
      if (it.claim && it.claim.tabId === tabId) {
        it.claim = null;
        it.status = STATUS.FAILED;
        it.lastError = 'tab-closed-during-send';
        if (it.keepalive) droppedKeepalive.push(it);
        changed = true;
      }
    }
    if (droppedKeepalive.length) q = q.filter((i) => !droppedKeepalive.includes(i));
    if (changed) {
      log.warn('tab closed during send', { tabId });
      await saveQueue(q);
    }
    return droppedKeepalive;
  }).then((dropped) => {
    for (const it of dropped || []) keepaliveFailed(it, 'tab-closed-during-send', { notify: false });
  });
});

// ─────────────────────────── 新版本檢查 ───────────────────────────
//
// 從 GitHub 下載、用「載入未封裝項目」安裝時，Chrome 不會自動更新。
// 每天讀一次 GitHub main 上的 manifest.json 比較版本號：只是一個不帶參數的 GET，不送出任何資料。
// 從商店安裝（installType 不是 development）時不檢查，商店會自己更新。

const UPDATE_FETCH_TIMEOUT_MS = 15 * 1000;

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

let updChain = Promise.resolve();
async function getUpdateState() {
  return {
    latest: null,
    checkedAt: 0,
    error: null,
    notifiedVersion: null,
    dismissedVersion: null,
    updatedFrom: null,
    ...((await getVal(K.UPDATE, null)) || {})
  };
}
function setUpdateState(patch) {
  const p = updChain.then(async () => {
    const next = { ...(await getUpdateState()), ...patch };
    await chrome.storage.local.set({ [K.UPDATE]: next });
    return next;
  });
  updChain = p.catch(() => {});
  return p;
}

/** 只有從原始碼載入（開發人員模式）才檢查；chrome.management.getSelf 不需要額外權限 */
async function isDevInstall() {
  try {
    const self = await chrome.management.getSelf();
    return !!self && self.installType === 'development';
  } catch (_) {
    return false;
  }
}

async function fetchLatestVersion() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPDATE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CQ.version.MANIFEST_URL, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const v = data && typeof data.version === 'string' ? data.version.trim() : '';
    if (!CQ.version.isValid(v)) throw new Error('bad version');
    return v;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 同一時間只跑一次（SW 啟動時 reconcile 可能被觸發兩次，避免重複連線）。
 * @returns {Promise<'disabled'|'not-dev'|'error'|'newer'|'up-to-date'>}
 */
let updateInFlight = null;
function checkForUpdate(why) {
  if (!updateInFlight) updateInFlight = runUpdateCheck(why).finally(() => (updateInFlight = null));
  return updateInFlight;
}

async function runUpdateCheck(why) {
  const settings = await CQ.settings.load();
  if (!settings.updateCheck) return 'disabled';
  if (!(await isDevInstall())) return 'not-dev';
  const now = Date.now();
  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch (e) {
    const error = String((e && e.name === 'AbortError' ? 'timeout' : e && e.message) || e).slice(0, 100);
    await setUpdateState({ checkedAt: now, error });
    log.warn('update check failed', { why, error });
    return 'error';
  }
  const current = currentVersion();
  const newer = CQ.version.compare(latest, current) > 0;
  const st = await setUpdateState({ latest, checkedAt: now, error: null });
  log.info('update check', { why, current, latest, newer });
  if (newer && st.notifiedVersion !== latest) {
    // 每個新版本只發一次通知；popup 會一直顯示提示，直到更新或按 ×
    await setUpdateState({ notifiedVersion: latest });
    await notify(NOTIFY_UPDATE, t('notifyUpdateTitle'), t('notifyUpdateBody', { version: latest, current }));
  }
  return newer ? 'newer' : 'up-to-date';
}

/** 排每天一次的檢查；距離上次檢查超過一天就馬上查一次 */
async function scheduleUpdateCheck(why = 'startup') {
  const settings = await CQ.settings.load();
  if (!settings.updateCheck || !(await isDevInstall())) {
    await chrome.alarms.clear(ALARMS.UPDATE_CHECK);
    return;
  }
  const periodInMinutes = CQ.version.CHECK_INTERVAL_MS / 60000;
  const existing = await chrome.alarms.get(ALARMS.UPDATE_CHECK);
  if (!existing) await chrome.alarms.create(ALARMS.UPDATE_CHECK, { delayInMinutes: periodInMinutes, periodInMinutes });
  const st = await getUpdateState();
  if (Date.now() - st.checkedAt >= CQ.version.CHECK_INTERVAL_MS) await checkForUpdate(why);
}

/** 第一次安裝 → 開啟使用教學；更新 → 記下舊版本，popup 顯示「已更新到 vX」 */
async function handleInstalled(details) {
  const reason = details && details.reason;
  if (reason === 'install') {
    await chrome.tabs.create({ url: CQ.version.GUIDE_URL });
    log.info('installed, guide opened');
  } else if (reason === 'update') {
    const from = details.previousVersion;
    const to = currentVersion();
    // 開發人員模式按「重新載入」也是 update，但版本沒變 → 不提示
    if (from && CQ.version.compare(to, from) > 0) {
      await setUpdateState({ updatedFrom: from });
      log.info('updated', { from, to });
    }
  }
}

// ─────────────────────────── reconcile（啟動時重建） ───────────────────────────

async function reconcile() {
  await locked(async () => {
    const q = await getQueue();
    const now = Date.now();
    let changed = false;
    for (const it of q) {
      if (it.keepalive && !it.claim && now - it.createdAt > KEEPALIVE_STALE_MS) {
        // 自動重設項目一直沒被分頁領取（例如分頁載入失敗）→ 移除，之後再試
        it.status = STATUS.SENT; // 下面的過濾會移除
        changed = true;
        continue;
      }
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
    // 自動重設項目送出中斷 → 直接移除（不留下失敗的內部訊息）
    const kept = q.filter((i) => i.status !== STATUS.SENT && !(i.keepalive && i.status === STATUS.FAILED));
    if (kept.length !== q.length) changed = true;
    if (changed) await saveQueue(kept);
    else {
      updateBadge(q);
      await gcFiles(q); // 清掉逾時的暫存附件
    }

    const pending = await getVal(K.PENDING_RESTORE, null);
    if (pending && now - pending.at > TIMING.PENDING_RESTORE_TTL_MS) {
      await chrome.storage.local.remove(K.PENDING_RESTORE);
    }
  });
  await scheduleResetAlarm();
  await scheduleKeepaliveAlarm(await getVal(K.USAGE, null));
  scheduleUpdateCheck().catch((e) => log.error('update check scheduling failed', e));
}

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch((e) => log.error('install handling failed', e));
  reconcile();
});
chrome.runtime.onStartup.addListener(() => reconcile()); // 瀏覽器重啟後 alarms 可能遺失 → 依佇列重建
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.RESET_CHECK) {
    handleResetCheck().catch((e) => log.error('reset check failed', e));
  } else if (alarm.name === ALARMS.KEEPALIVE) {
    handleKeepaliveAlarm().catch((e) => log.error('keepalive alarm failed', e));
  } else if (alarm.name === ALARMS.UPDATE_CHECK) {
    checkForUpdate('alarm').catch((e) => log.error('update check failed', e));
  }
});

// 設定頁開關「自動重設」
chrome.storage.onChanged.addListener((changes, area) => {
  const ch = area === 'local' && changes[K.SETTINGS];
  if (!ch) return;
  // 設定頁開關「自動檢查新版本」：打開時馬上查一次
  const updBefore = !ch.oldValue || ch.oldValue.updateCheck !== false;
  const updAfter = !ch.newValue || ch.newValue.updateCheck !== false;
  if (updBefore !== updAfter) {
    (updAfter ? checkForUpdate('enabled').then(() => scheduleUpdateCheck('enabled')) : scheduleUpdateCheck()).catch((e) =>
      log.error('update toggle failed', e)
    );
  }
  const before = !!(ch.oldValue && ch.oldValue.autoReset);
  const after = !!(ch.newValue && ch.newValue.autoReset);
  if (before === after) return;
  onKeepaliveToggled(after).catch((e) => log.error('keepalive toggle failed', e));
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
      attachments: [],
      status: item.draft ? STATUS.READY : STATUS.WAITING,
      attempts: 0,
      lastError: null,
      claim: null
    };
    const stageIds = Array.isArray(item.attachments) ? item.attachments.filter((x) => typeof x === 'string') : [];
    if (stageIds.length > LIMITS.MAX_FILES_PER_ITEM) return { ok: false, error: 'too many attachments' };
    const saved = await locked(async () => {
      if (stageIds.length) {
        // 先把暫存的附件指向這個項目；任何一個不見了就整則不排隊（輸入框不會被清空）
        const linked = await CQ.fileStore.link(stageIds, newItem.id);
        if (!linked) return 'attachment-missing';
        newItem.attachments = linked;
      }
      const q = await getQueue();
      q.push(newItem);
      await saveQueue(q);
      // 讀回確認真的寫入成功，content script 收到 ok 才會清空輸入框
      const verify = await getQueue();
      return verify.some((i) => i.id === newItem.id && i.text === text);
    });
    if (saved === 'attachment-missing') return { ok: false, error: 'attachment-missing' };
    if (!saved) return { ok: false, error: 'storage verify failed' };
    log.info('queued', {
      id: newItem.id,
      length: text.length,
      files: newItem.attachments.length,
      bytes: newItem.attachments.reduce((n, a) => n + a.size, 0),
      resetAt: newItem.resetAt,
      draft: newItem.draft,
      group: !!newItem.newChatGroup
    });
    await scheduleResetAlarm();
    return { ok: true, item: newItem };
  },

  // 附件暫存：每次一個檔案（訊息大小有上限，不一次全部送）
  async [MSG.FILE_STAGE]({ file }) {
    const meta = file && typeof file === 'object' ? file : {};
    const data = typeof meta.data === 'string' ? meta.data : '';
    const size = Number(meta.size) || 0;
    if (!data) return { ok: false, error: 'empty' };
    if (size > LIMITS.MAX_FILE_BYTES || data.length > Math.ceil(LIMITS.MAX_FILE_BYTES / 3) * 4 + 4) {
      return { ok: false, error: 'file-too-large' };
    }
    return locked(async () => {
      if ((await CQ.fileStore.totalSize()) + size > LIMITS.MAX_TOTAL_FILE_BYTES) {
        return { ok: false, error: 'storage-full' };
      }
      const id = await CQ.fileStore.stage(
        { name: meta.name, type: meta.type, size, lastModified: meta.lastModified },
        data
      );
      return { ok: true, id };
    });
  },

  async [MSG.FILE_GET]({ id, fileId }) {
    const q = await getQueue();
    const it = q.find((i) => i.id === id);
    if (!it || !(it.attachments || []).some((a) => a.fileId === fileId)) return { ok: false, error: 'not found' };
    const rec = await CQ.fileStore.get(fileId);
    if (!rec || rec.itemId !== id) return { ok: false, error: 'missing' };
    return {
      ok: true,
      file: { name: rec.name, type: rec.type, size: rec.size, lastModified: rec.lastModified, data: rec.data }
    };
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
      log.info('marked sent', { id, confidence, edited: !!edited, keepalive: !!(it && it.keepalive) });
      return { ok: true, keepalive: !!(it && it.keepalive) };
    }).then(async (res) => {
      if (res && res.keepalive) await keepaliveSent();
      return res;
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
      if (it.keepalive) {
        await saveQueue(q.filter((i) => i.id !== id));
        return { ok: true, keepalive: it };
      }
      it.claim = null;
      it.restoring = null;
      it.status = STATUS.FAILED;
      it.lastError = String(error || 'unknown');
      await saveQueue(q);
      log.warn('marked failed', { id, error: it.lastError });
      return { ok: true };
    }).then(async (res) => {
      if (res && res.keepalive) {
        await keepaliveFailed(res.keepalive, error || 'unknown', { notify: true });
        return { ok: true };
      }
      return res;
    });
  },

  async [MSG.QUEUE_RELEASE]({ id, token, status, resetAt, resetEstimated }) {
    const res = await locked(async () => {
      const q = await getQueue();
      const it = q.find((i) => i.id === id);
      if (!it) return { ok: false, error: 'not found' };
      if (it.claim && it.claim.token !== token) return { ok: false, error: 'claimed by another' };
      if (it.keepalive && status === STATUS.WAITING) {
        // 仍然已滿（例如每週上限）→ 不送，移除；等上限重置後由 alarm 再處理
        await saveQueue(q.filter((i) => i.id !== id));
        log.info('keepalive skipped: still full', { resetAt });
        return { ok: true };
      }
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
    // 自動重設只看 API 的用量資料（頁面殘留的上限提示不算），讀不到 API 時也要評估（記錄原因、排程）
    await evaluateKeepalive(snapshot, 'snapshot');
    return { ok: true };
  },

  /** 自動重設：第一次在新對話送出後，記下專用對話的網址 */
  async [MSG.KEEPALIVE_BOUND]({ url }) {
    const valid = typeof url === 'string' && /^https:\/\/claude\.ai\//.test(url) && !CQ.text.isNewChatUrl(url);
    if (!valid) return { ok: false };
    await setKeepaliveState({ conversationUrl: url });
    log.info('keepalive conversation bound');
    return { ok: true };
  },

  async [MSG.USAGE_REFRESH_REQUEST]() {
    const snapshot = await requestUsageFromTab();
    return { snapshot, noTab: !snapshot };
  },

  async [MSG.CLEAR_ALL]() {
    await locked(async () => {
      await chrome.storage.local.clear();
      await CQ.fileStore.clear().catch((e) => log.warn('clear attachments failed', { error: e.message }));
    });
    await chrome.alarms.clearAll();
    updateBadge([]);
    await CQ.settings.load();
    await scheduleUpdateCheck('cleared').catch(() => {});
    return { ok: true };
  },

  /** popup 關掉提示：newer＝這個新版本不再提示；updated＝清掉「已更新到 vX」 */
  async [MSG.UPDATE_DISMISS]({ kind }) {
    if (kind === 'newer') {
      const st = await getUpdateState();
      if (st.latest) await setUpdateState({ dismissedVersion: st.latest });
    } else if (kind === 'updated') {
      await setUpdateState({ updatedFrom: null });
    }
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
