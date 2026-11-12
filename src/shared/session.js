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

  /**
   * 快照抓下來之後，有沒有哪個重置時間已經過了（快照已過時，要馬上重抓）。
   * 例如 15:14 抓到「100%，15:15 重置」，15:15 之後這份快照就不準了。
   * API 停在「100%＋已過去的 resets_at」時，那個時間早於抓取時間，不算過時，不會一直重抓。
   */
  function staleAfterReset(snap, now = Date.now()) {
    if (!snap || !snap.fetchedAt) return false;
    const times = [snap.resetAt, snap.session && snap.session.resetsAt, snap.weekly && snap.weekly.resetsAt];
    return times.some((v) => {
      const r = Number(v);
      return r > snap.fetchedAt && r <= now;
    });
  }

  /**
   * Popup 顯示的自動重設狀態（依照 SW 實際會怎麼做，而不是只看用量）。
   * opts：{ now, queue, alarmAt（cq-keepalive 的排程時間）, pollMs（用量輪詢間隔）, maxFails }
   * @returns {{ kind: string, time: number|null }}
   *   kind：paused / sending / next / weekly-full / no-data / queue-busy / cooldown / soon
   */
  function keepaliveStatus(snap, state = {}, opts = {}) {
    const now = opts.now || Date.now();
    const queue = opts.queue || [];
    const maxFails = opts.maxFails || 3;
    const T = CQ.TIMING || {};
    if ((state.failCount || 0) >= maxFails) return { kind: 'paused', time: null };
    if (queue.some((i) => i.keepalive)) return { kind: 'sending', time: null };
    const c = keepaliveCheck(snap, state, now);
    if (c.endAt && (c.result === 'session-active' || c.result === 'recently-sent')) {
      return { kind: 'next', time: c.endAt + (T.KEEPALIVE_BUFFER_MS || 90 * 1000) };
    }
    if (c.result === 'weekly-full') return { kind: 'weekly-full', time: c.endAt };
    if (c.result === 'no-usage-data') return { kind: 'no-data', time: null };
    // 已歸零：SW 會在下一次收到用量（輪詢）或 alarm 時送出，除非被下面的情況擋住
    if (queue.some((i) => i.claim || i.restoring)) return { kind: 'queue-busy', time: null };
    const cooldownEnd = (state.lastAttemptAt || 0) + (T.KEEPALIVE_COOLDOWN_MS || 10 * 60 * 1000);
    if (cooldownEnd > now) return { kind: 'cooldown', time: cooldownEnd };
    const candidates = [opts.alarmAt, snap && snap.fetchedAt && opts.pollMs ? snap.fetchedAt + opts.pollMs : 0];
    const next = candidates.filter((v) => Number(v) > now).sort((a, b) => a - b)[0];
    return { kind: 'soon', time: next || null };
  }

  CQ.session = { hasApiData, isBlocking, sessionEndAt, keepaliveCheck, staleAfterReset, keepaliveStatus };
})(globalThis);
