/*
 * src/shared/session.js 的純函式測試：快照過時判斷、popup 的自動重設狀態。
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
const ctx = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['src/shared/constants.js', 'src/shared/session.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const S = ctx.CQ.session;
const MIN = 60 * 1000;
const H = 60 * MIN;
const T = Date.UTC(2026, 10, 12, 7, 15, 0); // 15:15 台灣時間

// 截圖的情況：15:14 抓到模擬「100%，15:15 重置」，現在 15:16
const simFull = {
  source: 'simulated',
  full: true,
  session: { pct: 100, resetsAt: T },
  weekly: { pct: 40, resetsAt: null },
  resetAt: T,
  fetchedAt: T - 1 * MIN
};

test('staleAfterReset: reset time passed after the snapshot was taken → stale', () => {
  assert.equal(S.staleAfterReset(simFull, T - 10 * 1000), false, 'before reset');
  assert.equal(S.staleAfterReset(simFull, T + 1 * MIN), true, 'after reset');
});

test('staleAfterReset: API stuck at 100% with a past resets_at is not stale (no refetch loop)', () => {
  const snap = { full: false, session: { pct: 100, resetsAt: T - 10 * MIN }, weekly: null, fetchedAt: T };
  assert.equal(S.staleAfterReset(snap, T + 5 * MIN), false);
});

test('staleAfterReset: an active session whose end passed → stale', () => {
  const snap = { full: false, session: { pct: 40, resetsAt: T }, weekly: { pct: 10, resetsAt: T + 50 * H }, fetchedAt: T - 3 * MIN };
  assert.equal(S.staleAfterReset(snap, T + 30 * 1000), true);
  assert.equal(S.staleAfterReset(null, T), false);
});

test('popup status: right after a simulated session ends → "soon" at the alarm time, not "waiting"', () => {
  const now = T + 1 * MIN;
  const alarmAt = T + 90 * 1000;
  const s = S.keepaliveStatus(simFull, {}, { now, queue: [], alarmAt, pollMs: 2 * MIN });
  assert.equal(s.kind, 'soon');
  assert.equal(s.time, alarmAt, 'earliest of alarm (15:16:30) and next poll (15:16:00 is past)');
});

test('popup status: no alarm and next poll already due → soon with no time', () => {
  const s = S.keepaliveStatus(simFull, {}, { now: T + 5 * MIN, queue: [], alarmAt: null, pollMs: 2 * MIN });
  assert.deepEqual({ ...s }, { kind: 'soon', time: null });
});

test('popup status: tried within 10 minutes → cooldown with the retry time', () => {
  const now = T + 1 * MIN;
  const st = { lastAttemptAt: T - 5 * MIN };
  const s = S.keepaliveStatus(simFull, st, { now, queue: [], alarmAt: null, pollMs: 2 * MIN });
  assert.equal(s.kind, 'cooldown');
  assert.equal(s.time, T + 5 * MIN);
});

test('popup status: keepalive item in queue → sending; other item being sent → queue-busy', () => {
  const now = T + 1 * MIN;
  assert.equal(S.keepaliveStatus(simFull, {}, { now, queue: [{ keepalive: true }] }).kind, 'sending');
  assert.equal(S.keepaliveStatus(simFull, {}, { now, queue: [{ claim: { token: 'x' } }] }).kind, 'queue-busy');
});

test('popup status: active session → next at end + 90s; paused after 3 failures', () => {
  const snap = { full: false, session: { pct: 40, resetsAt: T + H }, weekly: { pct: 10, resetsAt: T + 50 * H }, fetchedAt: T };
  const s = S.keepaliveStatus(snap, {}, { now: T, queue: [] });
  assert.equal(s.kind, 'next');
  assert.equal(s.time, T + H + 90 * 1000);
  assert.equal(S.keepaliveStatus(snap, { failCount: 3 }, { now: T }).kind, 'paused');
});

test('popup status: no API data → no-data', () => {
  const dom = { source: 'dom', full: true, session: null, weekly: null, resetAt: T + H, fetchedAt: T };
  assert.equal(S.keepaliveStatus(dom, {}, { now: T }).kind, 'no-data');
});
