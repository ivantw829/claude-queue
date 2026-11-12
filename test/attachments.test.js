/*
 * 附件排隊：service worker 端的暫存、連結、取回與清理。
 *
 *   node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/sw-env');

const B64 = Buffer.from('hello file').toString('base64');

async function setup() {
  const env = createEnv({ autoSend: false });
  await env.settle();
  return env;
}

async function stage(env, over = {}) {
  return env.send({
    type: env.MSG.FILE_STAGE,
    file: { name: 'a.png', type: 'image/png', size: 10, lastModified: 1, data: B64, ...over }
  });
}

async function addWithFiles(env, n = 2, over = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await stage(env, { name: `f${i}.png` })).id);
  const res = await env.send({
    type: env.MSG.QUEUE_ADD,
    item: { text: 'with files', url: 'https://claude.ai/chat/aaa', resetAt: Date.now() + 60000, attachments: ids, ...over }
  });
  return { res, ids };
}

test('FILE_STAGE + QUEUE_ADD links files and stores only metadata on the item', async () => {
  const env = await setup();
  const { res, ids } = await addWithFiles(env, 2);
  assert.equal(res.ok, true);
  const item = env.store.queue[0];
  assert.equal(item.attachments.length, 2);
  assert.deepEqual(
    item.attachments.map((a) => a.fileId),
    ids
  );
  assert.equal(item.attachments[0].name, 'f0.png');
  assert.equal(item.attachments[0].data, undefined, 'file content is not in chrome.storage');
  assert.equal(JSON.stringify(env.store).includes(B64), false);
  for (const id of ids) assert.equal(env.files.get(id).itemId, item.id);
});

test('FILE_GET returns the stored content only for the owning item', async () => {
  const env = await setup();
  await addWithFiles(env, 1);
  const item = env.store.queue[0];
  const fileId = item.attachments[0].fileId;
  const ok = await env.send({ type: env.MSG.FILE_GET, id: item.id, fileId });
  assert.equal(ok.ok, true);
  assert.equal(ok.file.data, B64);
  assert.equal(ok.file.type, 'image/png');
  const wrong = await env.send({ type: env.MSG.FILE_GET, id: 'other', fileId });
  assert.equal(wrong.ok, false);
});

test('QUEUE_ADD fails (and does not queue) when a staged file is missing or already used', async () => {
  const env = await setup();
  const res = await env.send({
    type: env.MSG.QUEUE_ADD,
    item: { text: 'x', url: 'https://claude.ai/chat/aaa', attachments: ['nope'] }
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'attachment-missing');
  assert.equal((env.store.queue || []).length, 0);

  const { ids } = await addWithFiles(env, 1);
  const again = await env.send({
    type: env.MSG.QUEUE_ADD,
    item: { text: 'y', url: 'https://claude.ai/chat/aaa', attachments: ids }
  });
  assert.equal(again.ok, false, 'a staged file cannot be linked to two items');
  assert.equal(env.store.queue.length, 1);
});

test('FILE_STAGE rejects files over the size limit and when total storage is full', async () => {
  const env = await setup();
  const L = env.ctx.CQ.LIMITS;
  const big = await stage(env, { size: L.MAX_FILE_BYTES + 1 });
  assert.equal(big.ok, false);
  assert.equal(big.error, 'file-too-large');
  // 模擬已存滿
  env.files.set('x', { id: 'x', itemId: 'someone', stagedAt: Date.now(), size: L.MAX_TOTAL_FILE_BYTES, data: '' });
  const full = await stage(env);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'storage-full');
});

test('QUEUE_ADD rejects more than MAX_FILES_PER_ITEM attachments', async () => {
  const env = await setup();
  const ids = Array.from({ length: env.ctx.CQ.LIMITS.MAX_FILES_PER_ITEM + 1 }, (_, i) => 's' + i);
  const res = await env.send({ type: env.MSG.QUEUE_ADD, item: { text: 'x', attachments: ids } });
  assert.equal(res.ok, false);
});

test('files are deleted when the item is deleted', async () => {
  const env = await setup();
  await addWithFiles(env, 2);
  const id = env.store.queue[0].id;
  await env.send({ type: env.MSG.QUEUE_DELETE, id });
  assert.equal(env.files.size, 0);
});

test('files are deleted after a confirmed send, but kept when the send fails', async () => {
  const env = await setup();
  await addWithFiles(env, 1);
  await addWithFiles(env, 1);
  const [a, b] = env.store.queue;

  const ca = await env.send({ type: env.MSG.QUEUE_CLAIM, id: a.id }, 3);
  await env.send({ type: env.MSG.QUEUE_MARK_SENT, id: a.id, token: ca.token, confidence: 'strong' }, 3);

  const cb = await env.send({ type: env.MSG.QUEUE_CLAIM, id: b.id }, 3);
  await env.send({ type: env.MSG.QUEUE_MARK_FAILED, id: b.id, token: cb.token, error: 'attach-failed' }, 3);

  const left = Array.from(env.files.values());
  assert.equal(left.length, 1, 'only the failed item keeps its file');
  assert.equal(left[0].itemId, b.id);
  assert.equal(env.store.queue[0].status, 'failed');
  assert.equal(env.store.queue[0].attachments.length, 1);
});

test('stale staged files (never linked) are cleaned up; fresh ones are kept', async () => {
  const env = await setup();
  const fresh = await stage(env);
  const old = await stage(env);
  env.files.get(old.id).stagedAt = Date.now() - env.ctx.CQ.fileStore.STAGE_TTL_MS - 1000;
  // 任何一次佇列寫入都會觸發清理
  await env.send({ type: env.MSG.QUEUE_ADD, item: { text: 'plain', url: 'https://claude.ai/chat/aaa' } });
  assert.equal(env.files.has(old.id), false);
  assert.equal(env.files.has(fresh.id), true);
});

test('files whose item disappeared from the queue are removed on the next queue write', async () => {
  const env = await setup();
  await addWithFiles(env, 1);
  env.store.queue = []; // 例如舊版或手動清掉佇列
  await env.send({ type: env.MSG.QUEUE_ADD, item: { text: 'plain', url: 'https://claude.ai/chat/aaa' } });
  assert.equal(env.files.size, 0);
});

test('CLEAR_ALL also clears stored attachments', async () => {
  const env = await setup();
  await addWithFiles(env, 2);
  await env.send({ type: env.MSG.CLEAR_ALL });
  assert.equal(env.files.size, 0);
});

test('logs never contain attachment names or content', async () => {
  const env = await setup();
  await addWithFiles(env, 2);
  await new Promise((r) => setTimeout(r, 600)); // logger flush
  const logs = JSON.stringify(env.store.logs || []);
  assert.equal(logs.includes('f0.png'), false);
  assert.equal(logs.includes(B64), false);
});
