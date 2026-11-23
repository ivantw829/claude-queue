/*
 * 自動重設的模型設定：設定值驗證，以及 SW 記錄 content 回報的切換結果。
 * 實際操作模型選單的部分在 test/harness/index.html（需要 DOM）。
 *
 *   node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/sw-env');

test('settings: auto reset model defaults to haiku / medium and rejects unknown values', () => {
  const env = createEnv();
  const S = env.ctx.CQ.settings;
  const d = S.normalize({});
  assert.equal(d.autoResetModel, 'haiku');
  assert.equal(d.autoResetEffort, 'medium');
  const bad = S.normalize({ autoResetModel: 'gpt', autoResetEffort: 'ultra' });
  assert.equal(bad.autoResetModel, 'haiku');
  assert.equal(bad.autoResetEffort, 'medium');
  const ok = S.normalize({ autoResetModel: 'none', autoResetEffort: 'xhigh' });
  assert.equal(ok.autoResetModel, 'none');
  assert.equal(ok.autoResetEffort, 'xhigh');
});

test('KEEPALIVE_MODEL_RESULT stores lastModelSwitch without touching other keepalive state', async () => {
  const env = createEnv();
  await env.settle();
  env.store.keepalive = { conversationUrl: 'https://claude.ai/chat/k', failCount: 1, lastSentAt: 5 };
  const res = await env.send({
    type: env.MSG.KEEPALIVE_MODEL_RESULT,
    ok: false,
    reason: 'model-not-found',
    model: '模型：Opus 5.5 高'
  });
  assert.equal(res.ok, true);
  const st = env.store.keepalive;
  assert.equal(st.conversationUrl, 'https://claude.ai/chat/k');
  assert.equal(st.failCount, 1);
  assert.equal(st.lastModelSwitch.ok, false);
  assert.equal(st.lastModelSwitch.reason, 'model-not-found');
  assert.equal(st.lastModelSwitch.model, '模型：Opus 5.5 高');
  assert.equal(typeof st.lastModelSwitch.at, 'number');
});
