/*
 * ⚠️ claude.ai 改版時最常需要修改的檔案之一。
 *
 * 用量偵測：端點、回應欄位解析、頁面「已達上限」文字的備援解析，全部集中在這裡。
 *
 * ── 端點（2026-11 查證）───────────────────────────────────────────
 *   GET https://claude.ai/api/organizations
 *       → [{ uuid, name, capabilities: [...] , ... }]
 *       （未登入時回 permission_error / account_session_invalid）
 *   GET https://claude.ai/api/organizations/{orgUuid}/usage
 *       → {
 *           "five_hour":  { "utilization": 37.0, "resets_at": "2026-11-03T09:59:59.9+00:00" },
 *           "seven_day":  { "utilization": 12.0, "resets_at": "2026-11-07T03:59:59.9+00:00" },
 *           "seven_day_opus":   { ... } | null,   // 依方案可能出現的模型別週上限
 *           "seven_day_sonnet": { ... } | null,
 *           ...
 *         }
 *   utilization 為 0–100 的百分比；resets_at 為 ISO 8601（也容忍 epoch 秒/毫秒）。
 *   組織 uuid 優先取 cookie `lastActiveOrg`，否則取 /api/organizations 中第一個具 chat 能力的組織。
 *
 * 以上格式非官方公開 API，若改版請在 DevTools → Network 篩選 "usage" 查看實際回應，
 * 並修改下方 ENDPOINTS / FIELD_ALIASES / parseUsageResponse()。
 *
 * 只做 GET 讀取用量；不會送出、重放或偽造任何聊天請求。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('usage');
  const { TIMING, STORAGE_KEYS } = CQ;

  const ENDPOINTS = {
    organizations: '/api/organizations',
    usage: (orgId) => `/api/organizations/${encodeURIComponent(orgId)}/usage`
  };

  const FIELD_ALIASES = {
    session: ['five_hour', 'fiveHour', 'session', 'five_hour_limit'],
    weekly: ['seven_day', 'sevenDay', 'weekly', 'seven_day_limit'],
    utilization: ['utilization', 'percent', 'percentage', 'used_percent'],
    resetsAt: ['resets_at', 'resetsAt', 'reset_at', 'resetAt']
  };

  const FULL_THRESHOLD = 100;

  // ───────────────────────── 端點存取 ─────────────────────────

  async function fetchJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMING.USAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: ctrl.signal
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${path.replace(/[0-9a-f-]{36}/gi, '<org>')}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  let memOrgId = null;

  async function getOrgId(forceRefresh = false) {
    if (!forceRefresh) {
      if (memOrgId) return memOrgId;
      const fromCookie = readCookie('lastActiveOrg');
      if (fromCookie && /^[0-9a-f-]{36}$/i.test(fromCookie)) {
        memOrgId = fromCookie;
        return memOrgId;
      }
      const stored = (await chrome.storage.local.get(STORAGE_KEYS.ORG_ID))[STORAGE_KEYS.ORG_ID];
      if (stored) {
        memOrgId = stored;
        return memOrgId;
      }
    }
    const orgs = await fetchJson(ENDPOINTS.organizations);
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('organizations: empty or unexpected format');
    const chatOrg =
      orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];
    if (!chatOrg || !chatOrg.uuid) throw new Error('organizations: missing uuid');
    memOrgId = chatOrg.uuid;
    await chrome.storage.local.set({ [STORAGE_KEYS.ORG_ID]: memOrgId });
    return memOrgId;
  }

  async function fetchUsageApi() {
    let orgId = await getOrgId();
    try {
      return parseUsageResponse(await fetchJson(ENDPOINTS.usage(orgId)));
    } catch (e) {
      // 快取的組織失效（切換帳號）→ 重抓一次
      if (e.status === 403 || e.status === 404) {
        log.warn('usage fetch failed with cached org, refreshing org id', { status: e.status });
        orgId = await getOrgId(true);
        return parseUsageResponse(await fetchJson(ENDPOINTS.usage(orgId)));
      }
      throw e;
    }
  }

  // ───────────────────────── 回應解析 ─────────────────────────

  function pick(obj, aliases) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of aliases) if (obj[k] !== undefined) return obj[k];
    return undefined;
  }

  function parseTimestamp(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }

  function parseBucket(b) {
    if (!b || typeof b !== 'object') return null;
    const pct = Number(pick(b, FIELD_ALIASES.utilization));
    return {
      pct: isNaN(pct) ? null : Math.max(0, Math.min(100, pct)),
      resetsAt: parseTimestamp(pick(b, FIELD_ALIASES.resetsAt))
    };
  }

  /**
   * @returns {{ session: Bucket|null, weekly: Bucket|null, extras: Array<{key, pct, resetsAt}> }}
   */
  function parseUsageResponse(json) {
    if (!json || typeof json !== 'object') throw new Error('usage: unexpected response');
    const session = parseBucket(pick(json, FIELD_ALIASES.session));
    const weekly = parseBucket(pick(json, FIELD_ALIASES.weekly));
    if (!session && !weekly) {
      throw new Error('usage: no five_hour/seven_day fields (format may have changed)');
    }
    // 其他模型別的週上限只顯示，不納入「已滿」判斷（無法得知你正在用哪個模型；
    // 若真的被擋，頁面會出現上限提示，由 DOM 備援偵測接手）
    const extras = [];
    for (const [key, val] of Object.entries(json)) {
      if (/^seven_day_/.test(key) && val && typeof val === 'object') {
        const b = parseBucket(val);
        if (b && b.pct != null) extras.push({ key, ...b });
      }
    }
    return { session, weekly, extras };
  }

  // ───────────────────────── DOM 備援 ─────────────────────────

  const LIMIT_PATTERNS = [
    /\b(usage|message|weekly|session|5-hour)\s+limit\b/i,
    /\bout of (free )?messages\b/i,
    /\breached (your|the)\b.{0,30}\blimit\b/i,
    /\blimit (reached|resets?)\b/i,
    /(已達|達到|到達).{0,12}(上限|限制|限額)/,
    /(用量|額度|訊息).{0,6}(上限|已滿|用完|用盡)/
  ];

  function isLimitText(text) {
    return LIMIT_PATTERNS.some((re) => re.test(text));
  }

  /**
   * 只檢查 selectors.limitBanner 指定的區域、且文字很短的元素，
   * 並排除輸入框與訊息氣泡，避免讀取聊天內容。
   */
  function detectLimitFromDom(now = Date.now()) {
    const editor = CQ.selectors.find('editor');
    const userMsgSel = CQ.selectors.SELECTORS.userMessage.join(',');
    const candidates = CQ.selectors.SELECTORS.limitBanner.flatMap((sel) => {
      try {
        return Array.from(document.querySelectorAll(sel));
      } catch (_) {
        return [];
      }
    });
    for (const el of candidates) {
      if (editor && (el.contains(editor) || editor.contains(el))) continue;
      try {
        if (el.closest(userMsgSel)) continue;
      } catch (_) {}
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 400) continue;
      if (isLimitText(text)) {
        const parsed = parseResetTimeFromText(text, now);
        return { limited: true, ...parsed };
      }
    }
    return { limited: false };
  }

  const WEEKDAYS_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

  /**
   * 從提示文字解析重置時間。支援：
   *   "resets at 3:00 PM" / "until 11 PM" / "resets Monday 9:00 AM" / "in 2 hours"
   *   "將於下午3:00重置" / "週一 上午 9:00" / "2 小時後" / "15:30"
   * 解析失敗時回傳「5 小時後」並標記 estimated=true。
   */
  function parseResetTimeFromText(text, now = Date.now()) {
    const s = String(text);

    // 相對時間
    let m = s.match(/\bin\s+(\d+)\s*(hours?|hrs?|h)\b(?:\s*(?:and\s*)?(\d+)\s*(minutes?|mins?|m)\b)?/i);
    if (m) return { resetAt: now + (+m[1] * 60 + (+m[3] || 0)) * 60000, estimated: false };
    m = s.match(/\bin\s+(\d+)\s*(minutes?|mins?)\b/i);
    if (m) return { resetAt: now + +m[1] * 60000, estimated: false };
    m = s.match(/(\d+)\s*小時(?:\s*(\d+)\s*分(?:鐘)?)?\s*後/);
    if (m) return { resetAt: now + (+m[1] * 60 + (+m[2] || 0)) * 60000, estimated: false };
    m = s.match(/(\d+)\s*分(?:鐘)?\s*後/);
    if (m) return { resetAt: now + +m[1] * 60000, estimated: false };

    // 星期
    let weekday = null;
    const wdEn = s.match(
      /\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|nesday|sday|urday|rsday|r|rs)?\b\.?/i
    );
    if (wdEn) weekday = WEEKDAYS_EN.indexOf(wdEn[1].toLowerCase());
    const wdZh = s.match(/(?:週|周|星期|禮拜)([日天一二三四五六])/);
    if (wdZh) weekday = WEEKDAYS_ZH.indexOf(wdZh[1] === '天' ? '日' : wdZh[1]);

    // 時刻
    let hour = null;
    let minute = 0;
    m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
    if (m) {
      hour = +m[1] % 12;
      minute = +(m[2] || 0);
      if (/^p/i.test(m[3])) hour += 12;
    } else {
      m = s.match(/(上午|早上|凌晨|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：點点時]\s*(\d{1,2})?/);
      if (m) {
        hour = +m[2];
        minute = +(m[3] || 0);
        const period = m[1];
        if (period && /下午|傍晚|晚上/.test(period) && hour < 12) hour += 12;
        if (period && /中午/.test(period) && hour < 11) hour += 12;
        if (period && /上午|早上|凌晨/.test(period) && hour === 12) hour = 0;
      } else {
        m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        if (m) {
          hour = +m[1];
          minute = +m[2];
        }
      }
    }

    if (hour == null || hour > 23 || minute > 59) {
      return { resetAt: now + TIMING.FALLBACK_RESET_MS, estimated: true };
    }

    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(hour, minute);
    if (weekday != null && weekday >= 0) {
      let diff = (weekday - d.getDay() + 7) % 7;
      if (diff === 0 && d.getTime() <= now) diff = 7;
      d.setDate(d.getDate() + diff);
    } else if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
    }
    return { resetAt: d.getTime(), estimated: false };
  }

  // ───────────────────────── Debug 模擬 ─────────────────────────

  function simulatedStatus(now = Date.now()) {
    const st = CQ.settings.get();
    if (!st.debugSimulate) return null;
    const full = now < st.debugSimulateUntil;
    return {
      source: 'simulated',
      full,
      fullReasons: full ? ['simulated'] : [],
      session: { pct: full ? 100 : 0, resetsAt: st.debugSimulateUntil || null },
      weekly: { pct: full ? 40 : 0, resetsAt: null },
      extras: [],
      resetAt: full ? st.debugSimulateUntil : null,
      estimated: false,
      fetchedAt: now,
      error: null
    };
  }

  // ───────────────────────── 組合 ─────────────────────────

  /**
   * UsageSnapshot:
   * {
   *   source: 'api'|'api+dom'|'dom'|'simulated'|'none',
   *   full: true|false|null   (null = 無法判斷),
   *   fullReasons: ('session'|'weekly'|'dom'|'simulated')[],
   *   session/weekly: { pct, resetsAt } | null, extras: [],
   *   resetAt: number|null    (若已滿：預計可再送出的時間),
   *   estimated: boolean, fetchedAt, error
   * }
   */
  function buildSnapshot(api, dom, error, now = Date.now()) {
    const reasons = [];
    const resetCandidates = [];
    let estimated = false;

    if (api) {
      for (const key of ['session', 'weekly']) {
        const b = api[key];
        if (b && b.pct != null && b.pct >= FULL_THRESHOLD) {
          reasons.push(key);
          if (b.resetsAt) resetCandidates.push(b.resetsAt);
        }
      }
    }
    if (dom && dom.limited) {
      reasons.push('dom');
      resetCandidates.push(dom.resetAt);
      if (dom.estimated && resetCandidates.length === 1) estimated = true;
    }

    const full = reasons.length ? true : api ? false : null;
    let resetAt = null;
    if (full) {
      // 多個上限同時滿時，要等最晚的那個重置
      resetAt = resetCandidates.length ? Math.max(...resetCandidates) : null;
      if (!resetAt) {
        resetAt = now + TIMING.FALLBACK_RESET_MS;
        estimated = true;
      }
    }

    return {
      source: api ? (dom && dom.limited ? 'api+dom' : 'api') : dom && dom.limited ? 'dom' : 'none',
      full,
      fullReasons: reasons,
      session: api ? api.session : null,
      weekly: api ? api.weekly : null,
      extras: api ? api.extras : [],
      resetAt,
      estimated,
      fetchedAt: now,
      error: error || null
    };
  }

  async function getStatus() {
    const now = Date.now();
    const sim = simulatedStatus(now);
    if (sim) return sim;

    let api = null;
    let error = null;
    try {
      api = await fetchUsageApi();
    } catch (e) {
      error = e.name === 'AbortError' ? 'timeout' : e.message;
      log.warn('usage endpoint failed, falling back to DOM detection', { error });
    }
    const dom = detectLimitFromDom(now);
    const snap = buildSnapshot(api, dom, error, now);
    log.debug('usage status', {
      source: snap.source,
      full: snap.full,
      reasons: snap.fullReasons,
      session: snap.session && snap.session.pct,
      weekly: snap.weekly && snap.weekly.pct,
      resetAt: snap.resetAt,
      estimated: snap.estimated
    });
    return snap;
  }

  CQ.usage = {
    ENDPOINTS,
    getStatus,
    fetchUsageApi,
    parseUsageResponse,
    detectLimitFromDom,
    parseResetTimeFromText,
    simulatedStatus,
    buildSnapshot,
    isLimitText
  };
})(globalThis);
