/*
 * 工作階段狀態判斷（自動重設用）。SW、content script、popup 共用。
 *
 * 只看用量 API 的資料，不看頁面上的上限提示：
 * 頁面提示在工作階段結束後常常還留在畫面上（分頁沒重新整理），
 * 而且「resets at 1:00 AM」過了 1 點之後會被解析成隔天 1 點，會讓自動重設整整卡一天。
 *
 * 工作階段結束後，API 可能是以下任一種樣子，全部都視為「已歸零」：
 *   five_hour: { utilization: 0, resets_at: null }
 *   five_hour: null（解析後 session 為 null）
 *   five_hour: { utilization: 100, resets_at: <已過去的時間> }
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const FULL = 100;

  /** 快照裡有沒有 API（或模擬）的用量資料；只靠頁面提示判斷的快照沒有 */
  function hasApiData(snap) {
    return !!(snap && (snap.session || snap.weekly));
  }

  /** 這個上限目前是否擋住送出（已滿而且還沒到重置時間） */
  function isBlocking(bucket, now = Date.now()) {
    if (!bucket || bucket.pct == null || bucket.pct < FULL) return false;
    const r = Number(bucket.resetsAt);
    return !r || r > now;
  }

  /** API 回報的工作階段結束時間（未來的時間才算），沒有進行中的工作階段時回傳 null */
  function sessionEndAt(snap, now = Date.now()) {
    const r = snap && snap.session ? Number(snap.session.resetsAt) : 0;
    return r && r > now ? r : null;
  }

  /**
   * 自動重設要不要送出。
   * state：{ lastSentAt }（SW 的自動重設狀態；content 端可以傳 {}）
   * @returns {{ idle: boolean, result: string, endAt: number|null }}
   *   result：
   *     'idle'            工作階段已歸零，可以送
   *     'session-active'  工作階段進行中（endAt＝結束時間）
   *     'recently-sent'   剛送過，API 還沒反映（endAt＝估計結束時間）
   *     'weekly-full'     每週上限已滿（endAt＝每週重置時間，可能為 null）
   *     'no-usage-data'   讀不到用量 API，無法判斷
   */
  function keepaliveCheck(snap, state = {}, now = Date.now()) {
    if (!hasApiData(snap)) return { idle: false, result: 'no-usage-data', endAt: null };
    if (isBlocking(snap.weekly, now)) {
      const r = Number(snap.weekly.resetsAt);
      return { idle: false, result: 'weekly-full', endAt: r > now ? r : null };
    }
    const end = sessionEndAt(snap, now);
    if (end) return { idle: false, result: 'session-active', endAt: end };
    const len = (CQ.TIMING && CQ.TIMING.SESSION_LENGTH_MS) || 5 * 60 * 60 * 1000;
    // API 回報的工作階段在上次送出「之後」才結束 → 那次送出開始的工作階段已經結束，不用再估計
    // （例如模擬用量時：模擬的工作階段比上次送出晚結束，可以馬上再測一次）
    const endedAt = snap.session ? Number(snap.session.resetsAt) || 0 : 0;
    const superseded = state.lastSentAt && endedAt > state.lastSentAt;
    const est = state.lastSentAt && !superseded ? state.lastSentAt + len : 0;
    if (est > now) return { idle: false, result: 'recently-sent', endAt: est };
    return { idle: true, result: 'idle', endAt: null };
  }

  CQ.session = { hasApiData, isBlocking, sessionEndAt, keepaliveCheck };
})(globalThis);
