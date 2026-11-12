/*
 * 測試用：用 vm 載入真正的 service-worker.js，chrome API 以記憶體 stub 取代。
 * （內容與 sw.test.js 的 createEnv 相同，另外把附件存放換成可檢查的記憶體後端）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/zh_TW/messages.json'), 'utf8'));

function createEnv({
  tabs = [],
  autoSend = true,
  contentReply = { ok: true },
  version = '0.3.0',
  installType = 'development',
  fetch = async () => {
    throw new Error('network disabled in tests');
  }
} = {}) {
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
      getManifest: () => ({ version }),
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
        this._a[name] = { name, scheduledTime: o.when, periodInMinutes: o.periodInMinutes };
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
    windows: { get: async () => ({ state: 'normal' }), update: async () => {} },
    management: { getSelf: async () => ({ installType }) }
  };

  const ctx = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    URL,
    AbortController,
    fetch: (...a) => fetch(...a)
  };
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
  const files = ctx.CQ.fileStore._backend()._map;
  return { chrome, store, calls, listeners, send, MSG, settle, tabs, ctx, files };
}

module.exports = { createEnv };
