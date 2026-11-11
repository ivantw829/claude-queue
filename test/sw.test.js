/*
 * Service worker 自動送出流程測試（Node 內建 test runner，不需安裝套件）。
 * 用 vm 載入真正的 service-worker.js，chrome API 以記憶體 stub 取代。
 *
 *   node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/zh_TW/messages.json'), 'utf8'));

function createEnv({ tabs = [], autoSend = true, contentReply = { ok: true } } = {}) {
  const store = {};
  const listeners = {};
  const calls = { created: [], reloaded: [], sent: [], notified: [], focused: [] };
  let nextTabId = 100;
  const on = (name) => ({ addListener: (fn) => ((listeners[name] = listeners[name] || []).push(fn)) });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const chrome = {
    runtime: {
      id: 'ext',
      getURL: (p) => 'chrome-extension://ext/' + p,
      onMessage: on('message'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
      sendMessage: async () => ({})
    },
    i18n: { getMessage: (k) => (zh[k] ? zh[k].message : '') },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(store);
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          Object.assign(store, clone(obj));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        },
        async clear() {
          for (const k of Object.keys(store)) delete store[k];
        }
      },
      onChanged: on('storageChanged')
    },
    alarms: {
      _a: {},
      async create(name, o) {
        this._a[name] = { name, scheduledTime: o.when };
      },
      async get(name) {
        return this._a[name];
      },
      async clear(name) {
        delete this._a[name];
      },
      async clearAll() {
        this._a = {};
      },
      onAlarm: on('alarm')
    },
    notifications: {
      async create(id, o) {
        calls.notified.push({ id, ...o });
      },
      async clear() {},
      onClicked: on('notifClick')
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      async query() {
        return clone(tabs);
      },
      async update(id) {
        calls.focused.push(id);
      },
      async create({ url }) {
        const tab = { id: nextTabId++, url, windowId: 1, active: true };
        tabs.push(tab);
        calls.created.push(tab);
        return tab;
      },
      async reload(id) {
        calls.reloaded.push(id);
      },
      async sendMessage(id, msg) {
        calls.sent.push({ id, msg });
        if (typeof contentReply === 'function') return contentReply(id, msg);
        return contentReply;
      },
      onRemoved: on('tabRemoved')
    },
    windows: { get: async () => ({ state: 'normal' }), update: async () => {} }
  };

  const ctx = { chrome, console, setTimeout, clearTimeout, crypto: globalThis.crypto, URL };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  vm.createContext(ctx);
  store.settings = { autoSend, notifications: true, pollMinutes: 2 };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'), ctx, {
    filename: 'service-worker.js'
  });

  const MSG = ctx.CQ.MSG;
  function send(msg, tabId = 1) {
    return new Promise((resolve) => {
      const handled = listeners.message[0](msg, { id: 'ext', tab: tabId == null ? undefined : { id: tabId } }, resolve);
      if (!handled) resolve(undefined);
    });
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { chrome, store, calls, listeners, send, MSG, settle, tabs, ctx };
}

function item(over = {}) {
  return {
    id: over.id || 'i' + Math.random().toString(36).slice(2, 8),
    text: 'hello',
    url: 'https://claude.ai/chat/aaa',
    createdAt: over.createdAt || Date.now(),
    resetAt: Date.now() - 1000,
    status: 'ready',
    claim: null,
    ...over
  };
}

test('busy tab keeps pendingRestore so the item is picked up later', async () => {
  const env = createEnv({
    tabs: [{ id: 1, url: 'https://claude.ai/chat/aaa', windowId: 1 }],
    contentReply: { ok: false, busy: true }
  });
  await env.settle();
  const it = item({ id: 'a' });
  env.store.queue = [it];
  await env.send({ type: env.MSG.QUEUE_TRY_NOW, id: 'a' }, null);
  assert.equal(env.store.pendingRestore.itemId, 'a');
  assert.equal(env.store.pendingRestore.tabId, 1);
  const res = await env.send({ type: env.MSG.RESTORE_CHECK }, 1);
  assert.equal(res.item.id, 'a');
  assert.equal(env.store.pendingRestore, undefined, 'claimed only once');
});

test('accepted RESTORE_START clears pendingRestore and marks item as restoring', async () => {
  const env = createEnv({ tabs: [{ id: 1, url: 'https://claude.ai/chat/aaa', windowId: 1 }] });
  await env.settle();
  env.store.queue = [item({ id: 'a' })];
  await env.send({ type: env.MSG.QUEUE_TRY_NOW, id: 'a' }, null);
  assert.equal(env.store.pendingRestore, undefined);
  assert.equal(env.store.queue[0].restoring.tabId, 1);
});

test('RESTORE_RETRY reloads the tab, carries retry count, and gives up with a notification after the limit', async () => {
  const env = createEnv();
  await env.settle();
  env.store.queue = [item({ id: 'a' })];
  const claim = await env.send({ type: env.MSG.QUEUE_CLAIM, id: 'a' }, 7);
  let r = await env.send(
    { type: env.MSG.RESTORE_RETRY, id: 'a', token: claim.token, reason: 'not-sent', mode: 'auto', attempt: {} },
    7
  );
  assert.equal(r.ok, true);
  assert.deepEqual(env.calls.reloaded, [7]);
  assert.equal(env.store.pendingRestore.retries, 1);
  assert.equal(env.store.queue[0].claim, null);
  assert.equal(env.store.queue[0].status, 'ready');

  r = await env.send({ type: env.MSG.RESTORE_RETRY, id: 'a', reason: 'not-sent', mode: 'auto', attempt: { retries: 1 } }, 7);
  assert.equal(r.ok, true);
  assert.equal(env.store.pendingRestore.retries, 2);

  r = await env.send({ type: env.MSG.RESTORE_RETRY, id: 'a', reason: 'not-sent', mode: 'auto', attempt: { retries: 2 } }, 7);
  assert.equal(r.ok, false);
  assert.equal(env.store.queue[0].status, 'failed');
  assert.equal(env.store.queue[0].lastError, 'not-sent');
  const n = env.calls.notified.find((x) => x.id === 'cq-auto-failed:a');
  assert.ok(n, 'failure notification sent');
  assert.match(n.message, /按下送出後沒有反應/);
});

test('RESTORE_RETRY refuses when another tab holds the claim', async () => {
  const env = createEnv();
  await env.settle();
  env.store.queue = [item({ id: 'a' })];
  await env.send({ type: env.MSG.QUEUE_CLAIM, id: 'a' }, 7);
  const r = await env.send({ type: env.MSG.RESTORE_RETRY, id: 'a', token: 'wrong', reason: 'x', attempt: {} }, 8);
  assert.equal(r.ok, false);
  assert.deepEqual(env.calls.reloaded, []);
});

test('RESTORE_REOPEN opens the correct conversation once, then gives up (never sends elsewhere)', async () => {
  const env = createEnv({ tabs: [{ id: 1, url: 'https://claude.ai/chat/other', windowId: 1 }] });
  await env.settle();
  env.store.queue = [item({ id: 'a', url: 'https://claude.ai/chat/aaa' })];
  let r = await env.send({ type: env.MSG.RESTORE_REOPEN, id: 'a', mode: 'auto', attempt: {} }, 1);
  assert.equal(r.ok, true);
  assert.equal(env.calls.created.length, 1);
  assert.equal(env.calls.created[0].url, 'https://claude.ai/chat/aaa', 'opened original chat, not tab 1');
  assert.equal(env.store.pendingRestore.reopened, 1);

  r = await env.send({ type: env.MSG.RESTORE_REOPEN, id: 'a', mode: 'auto', attempt: { reopened: 1 } }, 100);
  assert.equal(r.ok, false);
  assert.equal(env.store.queue[0].status, 'failed');
  assert.equal(env.store.queue[0].lastError, 'conversation-missing');
});

test('drafts are never auto-opened; RESTORE_DONE moves on to the next conversation', async () => {
  const env = createEnv({ tabs: [] });
  await env.settle();
  const now = Date.now();
  env.store.queue = [
    item({ id: 'draft', draft: true, createdAt: now - 3000, url: 'https://claude.ai/chat/d' }),
    item({ id: 'b', createdAt: now - 2000, url: 'https://claude.ai/chat/bbb' })
  ];
  await env.send({ type: env.MSG.RESTORE_DONE }, 1);
  assert.equal(env.calls.created.length, 1);
  assert.equal(env.calls.created[0].url, 'https://claude.ai/chat/bbb');
  // b is now marked restoring → a second RESTORE_DONE must not open it again
  await env.send({ type: env.MSG.RESTORE_DONE }, 1);
  assert.equal(env.calls.created.length, 1);
});

test('RESTORE_DONE does nothing when auto-send is off', async () => {
  const env = createEnv({ autoSend: false });
  await env.settle();
  env.store.queue = [item({ id: 'b' })];
  await env.send({ type: env.MSG.RESTORE_DONE }, 1);
  assert.equal(env.calls.created.length, 0);
});

test('QUEUE_ADD with draft flag stores a ready draft', async () => {
  const env = createEnv();
  await env.settle();
  const r = await env.send({ type: env.MSG.QUEUE_ADD, item: { text: 'my draft', url: 'https://claude.ai/chat/aaa', draft: true } });
  assert.equal(r.ok, true);
  assert.equal(r.item.draft, true);
  assert.equal(r.item.status, 'ready');
});

test('new-chat group: followers wait for the first message, then go into the same new conversation', async () => {
  const env = createEnv({ tabs: [] });
  await env.settle();
  const now = Date.now();
  env.store.queue = [
    item({ id: 'g1', url: 'https://claude.ai/new', newChatGroup: 'G', createdAt: now - 2000 }),
    item({ id: 'g2', url: 'https://claude.ai/new', newChatGroup: 'G', createdAt: now - 1000 })
  ];
  // only g1 is eligible at first
  await env.send({ type: env.MSG.RESTORE_DONE }, 1);
  assert.equal(env.calls.created.length, 1);
  const next = await env.send({ type: env.MSG.RESTORE_NEXT, url: 'https://claude.ai/new', peek: true }, 1);
  assert.equal(next.item.id, 'g1', 'g2 is not offered before g1');

  // g1 sent
  const claim = await env.send({ type: env.MSG.QUEUE_CLAIM, id: 'g1' }, 100);
  await env.send({ type: env.MSG.QUEUE_MARK_SENT, id: 'g1', token: claim.token }, 100);
  const g2 = env.store.queue.find((i) => i.id === 'g2');
  assert.ok(g2.awaitRebind, 'g2 waits for the new chat url');
  let peek = await env.send({ type: env.MSG.RESTORE_NEXT, url: 'https://claude.ai/new', peek: true }, 100);
  assert.equal(peek.item, null, 'g2 must not be sent to /new (would create a different chat)');

  await env.send({ type: env.MSG.QUEUE_REBIND, group: 'G', url: 'https://claude.ai/chat/newid' }, 100);
  peek = await env.send({ type: env.MSG.RESTORE_NEXT, url: 'https://claude.ai/chat/newid', peek: true }, 100);
  assert.equal(peek.item.id, 'g2');
  assert.equal(env.store.queue.find((i) => i.id === 'g2').url, 'https://claude.ai/chat/newid');
});

test('new-chat group: unknown new chat url fails followers instead of guessing', async () => {
  const env = createEnv();
  await env.settle();
  env.store.queue = [item({ id: 'g2', url: 'https://claude.ai/new', newChatGroup: 'G', awaitRebind: Date.now() })];
  const r = await env.send({ type: env.MSG.QUEUE_REBIND, group: 'G', url: null }, 1);
  assert.equal(r.ok, false);
  assert.equal(env.store.queue[0].status, 'failed');
  assert.equal(env.store.queue[0].lastError, 'new-chat-url-unknown');
  assert.ok(env.calls.notified.some((n) => n.id === 'cq-auto-failed:g2'));
});

test('markReady in auto mode opens the original conversation', async () => {
  const env = createEnv({ tabs: [{ id: 5, url: 'https://claude.ai/chat/aaa', windowId: 1 }] });
  await env.settle();
  env.store.queue = [item({ id: 'w', status: 'waiting', reasons: ['session'] })];
  await env.send({ type: env.MSG.USAGE_SNAPSHOT, snapshot: { source: 'api', full: false } }, 5);
  await env.settle();
  const start = env.calls.sent.find((s) => s.msg.type === env.MSG.RESTORE_START);
  assert.ok(start, 'restore started');
  assert.equal(start.id, 5, 'sent to the tab of the original conversation');
  assert.equal(start.msg.mode, 'auto');
});
