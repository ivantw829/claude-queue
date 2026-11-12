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
    ORG_ID: 'orgId', // 快取的 organization uuid
    KEEPALIVE: 'keepalive', // 自動重設狀態 { conversationUrl, lastAttemptAt, lastSentAt, lastError }
    UPDATE: 'update' // 新版本檢查 { latest, checkedAt, error, notifiedVersion, dismissedVersion, updatedFrom }
  });

  // 佇列項目狀態
  CQ.STATUS = Object.freeze({
    WAITING: 'waiting', // 等待額度重置
    READY: 'ready', // 已確認（或預估）重置，可還原送出
    SENT: 'sent', // 已送出（會立即從佇列移除，僅短暫存在）
    FAILED: 'failed' // 送出失敗或中斷，需要使用者處理
  });

  CQ.ALARMS = Object.freeze({
    RESET_CHECK: 'cq-reset-check',
    KEEPALIVE: 'cq-keepalive', // 自動重設：工作階段結束後檢查並送出訊息
    UPDATE_CHECK: 'cq-update-check' // 每天檢查一次 GitHub 上有沒有新版本
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
    AUTO_SEND_COUNTDOWN_S: 3,
    SEND_BUTTON_WAIT_MS: 8000, // 填入後等送出按鈕變成可按
    NEW_CHAT_URL_WAIT_MS: 15 * 1000, // 新對話送出後等網址變成 /chat/<id>
    RESTORE_CHECK_DELAYS_MS: [1500, 5000, 10000], // 頁面載入後領取還原工作的時間點
    ATTACH_APPEAR_WAIT_MS: 5000, // 加入附件後等附件卡片出現（逾時改用拖放）
    ATTACH_UPLOAD_WAIT_MS: 2 * 60 * 1000, // 等附件上傳完成
    KEEPALIVE_BUFFER_MS: 90 * 1000, // 工作階段結束後再等 90 秒（比佇列的重置檢查晚，讓排隊的訊息先送）
    KEEPALIVE_COOLDOWN_MS: 10 * 60 * 1000, // 自動重設兩次嘗試之間的最短間隔
    SESSION_LENGTH_MS: 5 * 60 * 60 * 1000 // 工作階段長度（API 沒給結束時間時用來估計）
  });

  CQ.LIMITS = Object.freeze({
    MAX_LOGS: 500,
    MAX_SENT_IDS: 200,
    PASTE_FALLBACK_MAX_CHARS: 2000, // 過長的貼上會被 claude.ai 轉為附件，故限制
    MAX_RESTORE_RETRIES: 2, // 確定未送出時，重新整理分頁後重試的次數上限
    // 附件（和 claude.ai 自己的上限一致：單檔 30MB、每則 20 個）
    MAX_FILE_BYTES: 30 * 1024 * 1024,
    MAX_FILES_PER_ITEM: 20,
    MAX_TOTAL_FILE_BYTES: 300 * 1024 * 1024 // 整個佇列的附件總量
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
    FILE_STAGE: 'file:stage', // 排隊前先把附件逐一交給 SW 暫存
    FILE_GET: 'file:get', // 還原時取回附件
    RESTORE_CHECK: 'restore:check',
    RESTORE_NEXT: 'restore:next',
    RESTORE_RETRY: 'restore:retry', // 確定未送出 → 重新整理分頁後重試
    RESTORE_REOPEN: 'restore:reopen', // 目前分頁不是原對話 → 重新開啟正確對話
    RESTORE_DONE: 'restore:done', // 這個分頁的還原結束 → 自動模式繼續處理其他對話
    RESTORE_GIVE_UP: 'restore:giveUp', // 自動送出無法完成 → 標記失敗並通知
    QUEUE_REBIND: 'queue:rebind', // 新對話群組：把後續項目改指向剛建立的對話
    KEEPALIVE_BOUND: 'keepalive:bound', // 自動重設：回報專用對話的網址
    USAGE_SNAPSHOT: 'usage:snapshot',
    USAGE_REFRESH_REQUEST: 'usage:refreshRequest',
    CLEAR_ALL: 'data:clearAll',
    UPDATE_DISMISS: 'update:dismiss', // popup 關掉「有新版本」或「已更新」提示
    LOG: 'log',
    // service worker -> content
    USAGE_REFRESH: 'usage:refresh',
    RESTORE_START: 'restore:start'
  });
})(globalThis);
