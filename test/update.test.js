/*
 * 新版本檢查與安裝／更新事件：用 vm 載入真正的 service-worker.js，fetch 與 chrome.management 以 stub 取代。
 *
 *   node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEnv } = require('./helpers/sw-env');

const GUIDE = 'https://me.asdtw.org/articles/claude-queue-guide.html';

function manifestFetch(version, log = []) {
  return async (url, opts) => {
    log.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ manifest_version: 3, version }) };
  };
}

function loadVersion() {
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/shared/version.js'), 'utf8'), ctx);
  return ctx.CQ.version;
}

const waitAsync = () => new Promise((r) => setTimeout(r, 60));

test('version.compare: numeric per segment, missing segments are 0, invalid compares equal', () => {
  const V = loadVersion();
  assert.equal(V.compare('0.10.0', '0.9.0'), 1);
  assert.equal(V.compare('0.3.0', '0.3.1'), -1);
  assert.equal(V.compare('1.0', '1.0.0'), 0);
  assert.equal(V.compare('1.0.0.1', '1.0'), 1);
  assert.equal(V.compare('abc', '1.0'), 0);
  assert.equal(V.isValid(' 0.4.0 '), true);
  assert.equal(V.isValid('0.4.0-beta'), false);
  assert.equal(V.isValid('1.2.3.4.5'), false);
});

test('update check: newer version on GitHub notifies once, later checks do not repeat', async () => {
  const requests = [];
  const env = createEnv({ fetch: manifestFetch('0.4.0', requests) });
  assert.equal(await env.ctx.checkForUpdate('test'), 'newer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://raw.githubusercontent.com/ivantw829/claude-queue/main/manifest.json');
  assert.equal(requests[0].opts.credentials, 'omit');
  assert.equal(env.store.update.latest, '0.4.0');
  assert.equal(env.store.update.notifiedVersion, '0.4.0');
  const notes = env.calls.notified.filter((n) => n.id === 'cq-update');
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /v0\.4\.0/);

  assert.equal(await env.ctx.checkForUpdate('test'), 'newer');
  assert.equal(env.calls.notified.filter((n) => n.id === 'cq-update').length, 1);
});

test('update check: same or older version on GitHub does not notify', async () => {
  for (const remote of ['0.3.0', '0.2.0']) {
    const env = createEnv({ fetch: manifestFetch(remote) });
    assert.equal(await env.ctx.checkForUpdate('test'), 'up-to-date');
    assert.equal(env.store.update.latest, remote);
    assert.equal(env.calls.notified.length, 0);
  }
});

test('update check: network failure or bad response is recorded, not notified', async () => {
  let env = createEnv(); // 預設 fetch 會丟錯
  assert.equal(await env.ctx.checkForUpdate('test'), 'error');
  assert.ok(env.store.update.error);
  assert.ok(env.store.update.checkedAt > 0);
  assert.equal(env.calls.notified.length, 0);

  env = createEnv({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(await env.ctx.checkForUpdate('test'), 'error');
  assert.equal(env.store.update.error, 'http 404');

  env = createEnv({ fetch: manifestFetch('not-a-version') });
  assert.equal(await env.ctx.checkForUpdate('test'), 'error');
  assert.equal(env.calls.notified.length, 0);
});

test('update check: skipped for store installs and when turned off', async () => {
  const requests = [];
  let env = createEnv({ installType: 'normal', fetch: manifestFetch('0.4.0', requests) });
  assert.equal(await env.ctx.checkForUpdate('test'), 'not-dev');

  env = createEnv({ fetch: manifestFetch('0.4.0', requests) });
  env.store.settings.updateCheck = false;
  assert.equal(await env.ctx.checkForUpdate('test'), 'disabled');
  assert.equal(requests.length, 0);
  assert.equal(env.calls.notified.length, 0);
});

test('startup: schedules a daily alarm and checks right away when the last check is over a day old', async () => {
  const requests = [];
  const env = createEnv({ fetch: manifestFetch('0.3.0', requests) });
  env.listeners.startup[0]();
  await waitAsync();
  const alarm = env.chrome.alarms._a['cq-update-check'];
  assert.ok(alarm);
  assert.equal(alarm.periodInMinutes, 24 * 60);
  assert.equal(requests.length, 1);

  // 一天內再啟動 → 不重查
  env.listeners.startup[0]();
  await waitAsync();
  assert.equal(requests.length, 1);
});

test('startup: store install clears the alarm and never fetches', async () => {
  const requests = [];
  const env = createEnv({ installType: 'normal', fetch: manifestFetch('0.4.0', requests) });
  env.chrome.alarms._a['cq-update-check'] = { name: 'cq-update-check' };
  env.listeners.startup[0]();
  await waitAsync();
  assert.equal(env.chrome.alarms._a['cq-update-check'], undefined);
  assert.equal(requests.length, 0);
});

test('onInstalled: first install opens the guide; update records the previous version', async () => {
  let env = createEnv({ fetch: manifestFetch('0.3.0') });
  env.listeners.installed[0]({ reason: 'install' });
  await waitAsync();
  assert.deepEqual(
    env.calls.created.map((t) => t.url),
    [GUIDE]
  );

  env = createEnv({ fetch: manifestFetch('0.3.0') });
  env.listeners.installed[0]({ reason: 'update', previousVersion: '0.2.0' });
  await waitAsync();
  assert.equal(env.store.update.updatedFrom, '0.2.0');
  assert.equal(env.calls.created.length, 0);

  // 開發人員模式按「重新載入」：版本沒變 → 不提示
  env = createEnv({ fetch: manifestFetch('0.3.0') });
  env.listeners.installed[0]({ reason: 'update', previousVersion: '0.3.0' });
  await waitAsync();
  assert.equal((env.store.update || {}).updatedFrom || null, null);
});

test('popup dismiss: hides this new version only, and clears the "updated" notice', async () => {
  const env = createEnv({ fetch: manifestFetch('0.4.0') });
  await env.ctx.checkForUpdate('test');
  env.store.update.updatedFrom = '0.2.0';
  await env.send({ type: env.MSG.UPDATE_DISMISS, kind: 'newer' });
  assert.equal(env.store.update.dismissedVersion, '0.4.0');
  await env.send({ type: env.MSG.UPDATE_DISMISS, kind: 'updated' });
  assert.equal(env.store.update.updatedFrom, null);
});

test('notification click opens the update section of the guide', async () => {
  const env = createEnv();
  await env.listeners.notifClick[0]('cq-update');
  assert.deepEqual(
    env.calls.created.map((t) => t.url),
    [GUIDE + '#s12']
  );
});
