/*
 * 自動重設（keepalive）測試：用 vm 載入真正的 service-worker.js 與 usage.js，chrome API 以記憶體 stub 取代。
 *
 *   node --test test/
 *
 * 快照都用真正的 CQ.usage.buildSnapshot() 從「API 回應＋頁面提示」組出來，
 * 這樣工作階段結束後的各種實際狀態（API 回 null、停在 100%、頁面殘留上限提示）都會被涵蓋。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/zh_TW/messages.json'), 'utf8'));
const H = 3600 * 1000;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 12, 18, 0, 0); // 台灣時間凌晨 2 點

function mkEvent() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (...a) => ls.map((f) => f(...a)), ls };
}

function createEnv({ autoReset = true, autoSend = false, now = T0 } = {}) {
  const clock = { now };
  const store = {};
  const onChanged = mkEvent();
  const alarms = {};
  const calls = { created: [], notified: [], sent: [] };
  let tabs = [];
  let nextTab = 100;
  let responder = null;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const FakeDate = class extends Date {
    constructor(...a) {
      super(...(a.length ? a : [clock.now]));
    }
    static now() {
      return clock.now;
    }
  };
  const chrome = {
    runtime: {
      id: 'ext',
      onMessage: mkEvent(),
      onInstalled: mkEvent(),
      onStartup: mkEvent(),
      getURL: (p) => 'chrome-extension://ext/' + p,
      sendMessage: async () => ({})
    },
    i18n: { getMessage: (k) => (zh[k] ? zh[k].message : '') },
    storage: {
      onChanged,
      local: {
        async get(keys) {
          const ks = keys == null ? Object.keys(store) : [].concat(keys);
          const out = {};
          for (const k of ks) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
            store[k] = clone(v);
          }
          onChanged.fire(changes, 'local');
        },
        async remove(k) {
          for (const key of [].concat(k)) delete store[key];
        },
        async clear() {
          for (const k of Object.keys(store)) delete store[k];
        }
      }
    },
    alarms: {
      onAlarm: mkEvent(),
      async create(name, o) {
        alarms[name] = { name, scheduledTime: o.when };
      },
      async get(name) {
        return alarms[name];
      },
      async clear(name) {
        delete alarms[name];
        return true;
      },
      async clearAll() {
        for (const k of Object.keys(alarms)) delete alarms[k];
      }
    },
    notifications: {
      onClicked: mkEvent(),
      async clear() {},
      async create(id, o) {
        calls.notified.push({ id, ...o });
      }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      onRemoved: mkEvent(),
      async query() {
        return tabs;
      },
      async create(o) {
        const tab = { id: nextTab++, url: o.url, windowId: 1, active: true };
        tabs.push(tab);
        calls.created.push(o.url);
        return tab;
      },
      async update() {},
      async reload() {},
      async sendMessage(id, msg) {
        calls.sent.push({ id, msg });
        if (!responder) throw new Error('no receiver');
        return responder(id, msg);
      }
    },
    windows: { get: async () => ({ state: 'normal' }), update: async () => {} }
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, Date: FakeDate, crypto: globalThis.crypto };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'), ctx, {
    filename: 'service-worker.js'
  });
  // usage.js 只用來組快照（buildSnapshot 是純函式）
  ctx.document = { cookie: '' };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/usage.js'), 'utf8'), ctx, { filename: 'usage.js' });

  const send = (msg, tabId = 100) =>
    new Promise((resolve) => {
      const r = chrome.runtime.onMessage.ls[0](msg, { id: 'ext', tab: { id: tabId } }, resolve);
      if (r !== true) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const MSG = ctx.CQ.MSG;

  /** 依「API 回應 JSON」與「頁面上限提示」組出真正的快照 */
  function snap(apiJson, domText = null) {
    const api = apiJson ? ctx.CQ.usage.parseUsageResponse(apiJson) : null;
    const dom = domText
      ? { limited: true, ...ctx.CQ.usage.parseResetTimeFromText(domText, clock.now) }
      : { limited: false };
    return ctx.CQ.usage.buildSnapshot(api, dom, apiJson ? null : 'HTTP 500', clock.now);
  }
  async function pushSnapshot(s) {
    await send({ type: MSG.USAGE_SNAPSHOT, snapshot: s });
    await settle();
  }
  const keepaliveItems = () => (store.queue || []).filter((i) => i.keepalive);

  const ready = (async () => {
    await settle();
    await chrome.storage.local.set({ settings: { autoReset, autoSend, notifications: true } });
    await settle();
    calls.created.length = 0;
  })();

  return {
    ctx, chrome, store, alarms, calls, clock, send, settle, MSG, snap, pushSnapshot, keepaliveItems, ready,
    setTabs: (t) => (tabs = t),
    setResponder: (f) => (responder = f)
  };
}

const iso = (ms) => new Date(ms).toISOString();
const weekly = (now) => ({ utilization: 30, resets_at: iso(now + 50 * H) });

// ─────────────── 工作階段結束後 API 可能的樣子 ───────────────

test('session ended: five_hour {0, null} → sends', async () => {
  const env = createEnv();
  await env.ready;
  await env.pushSnapshot(env.snap({ five_hour: { utilization: 0, resets_at: null }, seven_day: weekly(T0) }));
  assert.equal(env.keepaliveItems().length, 1);
  assert.deepEqual(env.calls.created, ['https://claude.ai/new']);
});

test('session ended: five_hour is null → sends', async () => {
  const env = createEnv();
  await env.ready;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(T0) }));
  assert.equal(env.keepaliveItems().length, 1, 'five_hour: null means no active session');
});

test('session ended: five_hour still 100% with resets_at in the past → sends', async () => {
  const env = createEnv();
  await env.ready;
  await env.pushSnapshot(
    env.snap({ five_hour: { utilization: 100, resets_at: iso(T0 - 10 * MIN) }, seven_day: weekly(T0) })
  );
  assert.equal(env.keepaliveItems().length, 1, 'a limit whose reset time has passed is not blocking');
});

test('session ended but the open page still shows the old limit banner → sends', async () => {
  const env = createEnv();
  await env.ready;
  // 睡前碰到上限，頁面一直顯示「resets at 1:00 AM」沒有重新整理；現在已過了那個時間
  const s = env.snap(
    { five_hour: { utilization: 0, resets_at: null }, seven_day: weekly(T0) },
    'You have reached your usage limit. Your limit resets at 1:00 AM'
  );
  assert.equal(s.full, true, 'precondition: stale banner makes the snapshot look full');
  await env.pushSnapshot(s);
  assert.equal(env.keepaliveItems().length, 1, 'API data wins over a stale page banner');
});

test('weekly limit full → does not send, alarm waits for weekly reset', async () => {
  const env = createEnv();
  await env.ready;
  const end = T0 + 20 * H;
  await env.pushSnapshot(
    env.snap({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 100, resets_at: iso(end) } })
  );
  assert.equal(env.keepaliveItems().length, 0);
  assert.equal(env.alarms['cq-keepalive'].scheduledTime, end + 90 * 1000);
});

test('usage endpoint failing (DOM only) → does not guess, records why', async () => {
  const env = createEnv();
  await env.ready;
  await env.pushSnapshot(env.snap(null));
  assert.equal(env.keepaliveItems().length, 0);
  assert.equal(env.store.keepalive.lastCheck.result, 'no-usage-data');
});

// ─────────────── 整晚的流程 ───────────────

test('overnight: active session → alarm at end + 90s → alarm fires → sends → next alarm ~5h later', async () => {
  const env = createEnv();
  await env.ready;
  const end = T0 + 1 * H;
  await env.pushSnapshot(env.snap({ five_hour: { utilization: 40, resets_at: iso(end) }, seven_day: weekly(T0) }));
  assert.equal(env.keepaliveItems().length, 0);
  assert.equal(env.alarms['cq-keepalive'].scheduledTime, end + 90 * 1000);
  assert.equal(env.store.keepalive.lastCheck.result, 'session-active');

  // 分頁被凍結或沒開，只剩 alarm
  env.clock.now = end + 90 * 1000;
  env.chrome.alarms.onAlarm.fire({ name: 'cq-keepalive' });
  await env.settle();
  await env.settle();
  assert.equal(env.keepaliveItems().length, 1, 'alarm without a usable tab triggers (page re-checks)');

  const it = env.keepaliveItems()[0];
  const claim = await env.send({ type: env.MSG.QUEUE_CLAIM, id: it.id });
  await env.send({ type: env.MSG.QUEUE_MARK_SENT, id: it.id, token: claim.token, confidence: 'strong' });
  await env.send({ type: env.MSG.KEEPALIVE_BOUND, url: 'https://claude.ai/chat/abc' });
  await env.settle();
  assert.equal(env.store.keepalive.conversationUrl, 'https://claude.ai/chat/abc');
  assert.equal(env.alarms['cq-keepalive'].scheduledTime, env.clock.now + 5 * H + 90 * 1000);
});

test('overnight with an open tab: alarm asks the tab, idle → sends', async () => {
  const env = createEnv();
  await env.ready;
  const end = T0 + 1 * H;
  await env.pushSnapshot(env.snap({ five_hour: { utilization: 40, resets_at: iso(end) }, seven_day: weekly(T0) }));
  env.clock.now = end + 90 * 1000;
  env.setTabs([{ id: 7, url: 'https://claude.ai/chat/zzz', windowId: 1, active: false }]);
  const idle = env.snap({ five_hour: null, seven_day: weekly(env.clock.now) });
  env.setResponder((id, msg) => (msg.type === env.MSG.USAGE_REFRESH ? { snapshot: idle } : { ok: true }));
  env.chrome.alarms.onAlarm.fire({ name: 'cq-keepalive' });
  await env.settle();
  await env.settle();
  assert.equal(env.keepaliveItems().length, 1);
});

test('after sending, resets_at still null → no resend for 5 hours', async () => {
  const env = createEnv();
  await env.ready;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(T0) }));
  const it = env.keepaliveItems()[0];
  const claim = await env.send({ type: env.MSG.QUEUE_CLAIM, id: it.id });
  await env.send({ type: env.MSG.QUEUE_MARK_SENT, id: it.id, token: claim.token, confidence: 'strong' });
  env.clock.now += 30 * MIN;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(env.clock.now) }));
  assert.equal(env.keepaliveItems().length, 0);
  env.clock.now = T0 + 5 * H + 2 * MIN;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(env.clock.now) }));
  assert.equal(env.keepaliveItems().length, 1);
});

test('disabled → nothing happens', async () => {
  const env = createEnv({ autoReset: false });
  await env.ready;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(T0) }));
  assert.equal(env.keepaliveItems().length, 0);
  assert.equal(env.alarms['cq-keepalive'], undefined);
});

test('three failures pause; seeing an active session resumes', async () => {
  const env = createEnv();
  await env.ready;
  for (let n = 1; n <= 3; n++) {
    env.clock.now += 11 * MIN;
    await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(env.clock.now) }));
    const it = env.keepaliveItems()[0];
    assert.ok(it, `attempt ${n} enqueued`);
    await env.send({ type: env.MSG.RESTORE_GIVE_UP, id: it.id, token: null, reason: 'fill-failed' });
    await env.settle();
  }
  assert.equal(env.store.keepalive.failCount, 3);
  env.clock.now += 11 * MIN;
  await env.pushSnapshot(env.snap({ five_hour: null, seven_day: weekly(env.clock.now) }));
  assert.equal(env.keepaliveItems().length, 0, 'paused');
  assert.equal(env.store.keepalive.lastCheck.result, 'paused');
  await env.pushSnapshot(env.snap({ five_hour: { utilization: 5, resets_at: iso(env.clock.now + H) }, seven_day: weekly(env.clock.now) }));
  assert.equal(env.store.keepalive.failCount, 0);
});
