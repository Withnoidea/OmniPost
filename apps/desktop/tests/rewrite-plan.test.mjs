import test from 'node:test';
import assert from 'node:assert/strict';
import { planRewrite, REWRITE_PLATFORMS } from '../src/renderer/rewrite-plan.ts';
const copy = { title: '人工微调', body: '正文', tags: ['创作'] };
test('all-platform action fills only gaps and keeps saved copies and unsaved drafts', () => {
  const saved = { xiaohongshu: copy }; const drafts = { bilibili: copy };
  assert.deepEqual(planRewrite(true, 'xiaohongshu', saved, drafts), { targets: ['douyin', 'kuaishou'], mode: 'missing', confirm: false, blocked: false });
  assert.equal(saved.xiaohongshu, copy); assert.equal(drafts.bilibili, copy);
});
test('empty task generates all, complete task requires replacement confirmation', () => {
  assert.deepEqual(planRewrite(true, 'douyin', {}, {}), { targets: REWRITE_PLATFORMS, mode: 'missing', confirm: false, blocked: false });
  const saved = Object.fromEntries(REWRITE_PLATFORMS.map(p => [p, copy]));
  assert.deepEqual(planRewrite(true, 'douyin', saved, {}), { targets: REWRITE_PLATFORMS, mode: 'replace', confirm: true, blocked: false });
  assert.equal(planRewrite(true, 'douyin', saved, { bilibili: copy }).blocked, true);
});
test('single-platform rewrite preserves unrelated drafts and blocks its own unsaved draft', () => {
  assert.equal(planRewrite(false, 'douyin', {}, { bilibili: copy }).blocked, false);
  assert.equal(planRewrite(false, 'douyin', {}, { douyin: copy }).blocked, true);
});
