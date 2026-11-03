/*
 * 共用常數。以 classic script 形式載入，掛在 globalThis.CQ 下，
 * 讓 service worker（importScripts）、content script 與 popup/options 共用同一份。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});

  CQ.STORAGE_KEYS = Object.freeze({
    QUEUE: 'queue', // QueueItem[]
    SETTINGS: 'settings', // Settings
    USAGE: 'usage', // UsageSnapshot（最新一次）
    RESET_CHECK: 'resetCheck', // { attempt, nextAt }
    PENDING_RESTORE: 'pendingRestore', // { itemId, tabId, mode, at }
    SENT_IDS: 'sentIds', // string[]，已送出項目 id，防重複
    LOGS: 'logs', // LogEntry[]
    ORG_ID: 'orgId' // 快取的 organization uuid
  });

  // 佇列項目狀態
  CQ.STATUS = Object.freeze({
    WAITING: 'waiting', // 等待額度重置
    READY: 'ready', // 已確認（或預估）重置，可還原送出
    SENT: 'sent', // 已送出（會立即從佇列移除，僅短暫存在）
    FAILED: 'failed' // 送出失敗或中斷，需要使用者處理
  });

  CQ.ALARMS = Object.freeze({
    RESET_CHECK: 'cq-reset-check'
  });

  CQ.TIMING = Object.freeze({
    RESET_BUFFER_MS: 30 * 1000, // 重置時間點後再等 30 秒
    RETRY_INTERVAL_MS: 2 * 60 * 1000, // 未重置時 2 分鐘後重試
    MAX_RETRIES: 10,
    FALLBACK_RESET_MS: 5 * 60 * 60 * 1000, // 解析失敗時預設 5 小時後
    CLAIM_TTL_MS: 2 * 60 * 1000, // 送出鎖定逾時
    PENDING_RESTORE_TTL_MS: 5 * 60 * 1000,
    SEND_DETECT_TIMEOUT_MS: 20 * 1000,
    COMPOSER_WAIT_MS: 20 * 1000,
    PRE_SEND_RECHECK_TIMEOUT_MS: 3000,
    USAGE_FETCH_TIMEOUT_MS: 8000,
    GENERATION_WAIT_MS: 10 * 60 * 1000,
    AUTO_SEND_COUNTDOWN_S: 3
  });

  CQ.LIMITS = Object.freeze({
    MAX_LOGS: 500,
    MAX_SENT_IDS: 200,
    PASTE_FALLBACK_MAX_CHARS: 2000 // 過長的貼上會被 claude.ai 轉為附件，故限制
  });

  CQ.MSG = Object.freeze({
    // content/popup -> service worker
    QUEUE_ADD: 'queue:add',
    QUEUE_UPDATE: 'queue:update',
    QUEUE_DELETE: 'queue:delete',
    QUEUE_TRY_NOW: 'queue:tryNow',
    QUEUE_CLAIM: 'queue:claim',
    QUEUE_MARK_SENT: 'queue:markSent',
    QUEUE_MARK_FAILED: 'queue:markFailed',
    QUEUE_RELEASE: 'queue:release',
    QUEUE_MARK_SENT_BY_TEXT: 'queue:markSentByText',
    RESTORE_CHECK: 'restore:check',
    RESTORE_NEXT: 'restore:next',
    USAGE_SNAPSHOT: 'usage:snapshot',
    USAGE_REFRESH_REQUEST: 'usage:refreshRequest',
    CLEAR_ALL: 'data:clearAll',
    LOG: 'log',
    // service worker -> content
    USAGE_REFRESH: 'usage:refresh',
    RESTORE_START: 'restore:start'
  });
})(globalThis);
