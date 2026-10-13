'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { QuestionBank, lookupQuestionBank } = require('../ai-literacy-search/scripts/question-bank.cjs');

function entry(overrides = {}) {
  return {
    id: 'sample-1', base_id: 'sample', stem: '查全率的计算公式是什么？',
    type: 'single', options: { A: '检出相关文献数 / 全部相关文献数', B: '检出相关文献数 / 检出文献数', C: '全部文献数 / 检出文献数' },
    answer_labels: ['A'], answer_texts: ['检出相关文献数 / 全部相关文献数'],
    reuse_policy: 'stable', source_kind: 'user_supplied_official_sample',
    issues: [], line_start: 1, explanation: '查全率衡量相关文献的检出程度。', urls: [],
    ...overrides
  };
}

function fixture(t, entries = [entry()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'question-bank-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'references'));
  const file = path.join(root, 'references', 'question-bank.json');
  const data = {
    version: 1, provenance: { file: 'synthetic-test-fixture.md', sha256: '0'.repeat(64) },
    entries_sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries
  };
  fs.writeFileSync(file, JSON.stringify(data));
  return { root, file, data, bank: new QuestionBank(root) };
}

function query(overrides = {}) {
  const sample = entry();
  return { question: sample.stem, type: sample.type, options: sample.options, ...overrides };
}

function assertNoAnswer(result) {
  assert.equal(Object.hasOwn(result, 'answer_labels'), false);
  assert.equal(Object.hasOwn(result, 'answer_texts'), false);
  assert.equal(Object.hasOwn(result, 'judge_answer'), false);
}

test('public lookup remaps a single answer to the current option label', t => {
  const { root } = fixture(t);
  const options = { A: entry().options.B, B: entry().options.C, C: entry().options.A };
  const result = lookupQuestionBank(query({ options }), { root });
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.answer_labels, ['C']);
  assert.deepEqual(result.answer_texts, [options.C]);
  assert.equal(result.candidates[0].match_kind, 'exact');
});

test('multiple answers follow current option order and arbitrary labels', t => {
  const sample = entry({ type: 'multiple', answer_labels: ['A', 'C'], answer_texts: [entry().options.A, entry().options.C] });
  const { bank } = fixture(t, [sample]);
  const options = { X: sample.options.C, Y: sample.options.B, Z: sample.options.A };
  const result = bank.lookup(query({ type: 'multiple', options }));
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.answer_labels, ['X', 'Z']);
  assert.deepEqual(result.answer_texts, [options.X, options.Z]);
});

for (const [positive, negative] of [['正确', '错误'], ['对', '错'], ['是', '否'], ['TRUE', 'false'], ['√', '×'], ['✔', '✘']]) {
  for (const answer of [true, false]) {
    test(`judgment normalizes ${positive}/${negative} with answer ${answer}`, t => {
      const sample = entry({ type: 'judge', options: { A: '正确', B: '错误' },
        answer_labels: [answer ? 'A' : 'B'], answer_texts: [answer ? '正确' : '错误'], judge_answer: answer });
      const { bank } = fixture(t, [sample]);
      const result = bank.lookup(query({ type: 'judge', options: { A: negative, B: positive } }));
      assert.equal(result.status, 'matched');
      assert.equal(result.judge_answer, answer);
      assert.deepEqual(result.answer_labels, [answer ? 'B' : 'A']);
      assert.deepEqual(result.answer_texts, [answer ? positive : negative]);
    });
  }
}

test('judgment can match without option labels', t => {
  const { bank } = fixture(t, [entry({ type: 'judge', options: {}, answer_labels: [], answer_texts: ['正确'], judge_answer: true })]);
  const result = bank.lookup({ question: entry().stem, type: 'judge' });
  assert.equal(result.status, 'matched');
  assert.equal(result.judge_answer, true);
  assert.deepEqual(result.answer_labels, []);
});

test('stem and option normalization accepts width, whitespace and final punctuation', t => {
  const sample = entry({ stem: 'ＡＩ  检索是什么？', options: { A: 'ＡＩ  检索', B: '人工检索' }, answer_texts: ['ＡＩ  检索'] });
  const { bank } = fixture(t, [sample]);
  for (const suffix of ['', '。', '.', '?', '？']) {
    const result = bank.lookup(query({ question: `  AI\n检索是什么${suffix}  `, options: { A: '人工检索', B: ' AI\t检索 ' } }));
    assert.equal(result.status, 'matched');
    assert.deepEqual(result.answer_labels, ['B']);
  }
});

test('normalization preserves negation, numbers, operators and quoted whitespace', t => {
  const sample = entry({ stem: '值为 10 且 x > 1，不包含 "a  b"？' });
  const { bank } = fixture(t, [sample]);
  for (const question of ['值为 11 且 x > 1，不包含 "a  b"？', '值为 10 且 x < 1，不包含 "a  b"？',
    '值为 10 且 x > 1，包含 "a  b"？', '值为 10 且 x > 1，不包含 "a b"？']) {
    const result = bank.lookup(query({ question }));
    assert.notEqual(result.status, 'matched');
    assertNoAnswer(result);
  }
});

test('conflicting answers require verification even when candidate limit hides one', t => {
  const other = entry({ id: 'sample-2', options: { A: entry().options.C, B: entry().options.A, C: entry().options.B },
    answer_labels: ['C'], answer_texts: [entry().options.B] });
  const { bank } = fixture(t, [entry(), other]);
  const result = bank.lookup(query(), { limit: 1 });
  assert.equal(result.status, 'needs_verification');
  assert.match(result.reason, /conflicting_answer_keys/);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].needs_review.includes('conflicting_answer_keys'));
  assertNoAnswer(result);
});

test('duplicate records with consistent answers remain reusable', t => {
  const { bank } = fixture(t, [entry(), entry({ id: 'sample-2' })]);
  const result = bank.lookup(query());
  assert.equal(result.status, 'matched');
  assert.equal(result.sources.length, 2);
});

for (const [reuse_policy, reason] of [['dynamic', 'dynamic_lookup_requires_current_evidence'], ['product', 'product_feature_requires_applicable_version_evidence']]) {
  test(`${reuse_policy} answers require applicable evidence`, t => {
    const { bank } = fixture(t, [entry({ reuse_policy })]);
    const result = bank.lookup(query());
    assert.equal(result.status, 'needs_verification');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.candidates[0].needs_review, [reason]);
    assertNoAnswer(result);
  });
}

test('duplicate current option text cannot produce an answer mapping', t => {
  const { bank } = fixture(t);
  const result = bank.lookup(query({ options: { A: entry().options.A, B: entry().options.B, C: entry().options.A } }));
  assert.equal(result.status, 'candidates');
  assert.equal(result.candidates[0].match_kind, 'similar');
  assertNoAnswer(result);
});

test('duplicate stored option text is marked for review', t => {
  const sample = entry({ options: { A: '相同', B: '相同' }, answer_texts: ['相同'] });
  const { bank } = fixture(t, [sample]);
  const result = bank.lookup(query({ options: sample.options }));
  assert.equal(result.status, 'candidates');
  assert.ok(result.candidates[0].needs_review.includes('duplicate_option_text'));
  assertNoAnswer(result);
});

test('changed or missing options and unknown type cannot reuse a stable answer', t => {
  const { bank } = fixture(t);
  for (const overrides of [{ options: { ...entry().options, C: '新选项' } }, { options: { A: entry().options.A } }, { type: 'unknown' }]) {
    const result = bank.lookup(query(overrides));
    assert.equal(result.status, 'candidates');
    assertNoAnswer(result);
  }
});

test('invalid judgment alternatives cannot map an answer', t => {
  const { bank } = fixture(t, [entry({ type: 'judge', options: {}, answer_labels: [], answer_texts: ['正确'], judge_answer: true })]);
  for (const options of [{ A: '正确', B: '对' }, { A: '正确', B: '未知' }, { A: '正确' }]) {
    const result = bank.lookup(query({ type: 'judge', options }));
    assert.equal(result.status, 'candidates');
    assertNoAnswer(result);
  }
});

test('invalid questions and options throw descriptive validation errors', t => {
  const { bank } = fixture(t);
  for (const value of [null, undefined, {}, { question: '' }, { question: '  ' }, { question: 123 }]) {
    assert.throws(() => bank.lookup(value), /Supply the complete question stem/);
  }
  assert.throws(() => bank.lookup(query({ type: 'essay' })), /Use single, multiple, judge or unknown/);
  for (const options of [[], 'text', { '': 'text' }, { A: 123 }, { A: ' ' }]) {
    assert.throws(() => bank.lookup(query({ options })), /Options must map current labels to complete text/);
  }
  for (const limit of [0, 6, 1.5, '3', null]) {
    assert.throws(() => bank.lookup(query(), { limit }), /candidate limit from 1 to 5/);
  }
});

test('unrelated question returns a miss without answer fields', t => {
  const { bank } = fixture(t);
  const result = bank.lookup(query({ question: 'zzzz' }));
  assert.equal(result.status, 'miss');
  assert.deepEqual(result.candidates, []);
  assertNoAnswer(result);
});

test('missing, malformed and digest-invalid banks require verification', async t => {
  for (const mode of ['missing', 'malformed', 'digest']) {
    await t.test(mode, t => {
      const { bank, file, data } = fixture(t);
      if (mode === 'missing') fs.unlinkSync(file);
      else if (mode === 'malformed') fs.writeFileSync(file, '{');
      else fs.writeFileSync(file, JSON.stringify({ ...data, entries_sha256: '0'.repeat(64) }));
      const result = bank.lookup(query());
      assert.equal(result.status, 'needs_verification');
      assert.deepEqual(result.candidates, []);
      assertNoAnswer(result);
      assert.equal(bank.preload().failures.length, 1);
    });
  }
});
