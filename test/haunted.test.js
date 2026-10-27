// Integration tests against the fictional hollow-creek-ledger repository.
// Everything here is git and arithmetic; no model is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHauntedRepo } from '../scripts/make-haunted-repo.js';
import { openRepo, loadHistory, pickaxe, git, tallyBlameIncremental, resolveCommit } from '../src/git.js';
import { gatherSpirits, spiritStatus, nightShare } from '../src/spirits.js';
import { lineEvidence, fileEvidence, authorEvidence, questionEvidence, renderEvidence } from '../src/evidence.js';
import { divine } from '../src/crypt.js';
import { verifyCitations, systemPrompt } from '../src/medium.js';

const opts = { now: Date.parse('2026-10-27T12:00:00Z'), departedAfterDays: 365 };
let dir;
let repo;
let history;
let spirits;
const bySubject = (s) => history.find((c) => c.subject === s);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seance-'));
  makeHauntedRepo(path.join(dir, 'hollow-creek-ledger'));
  repo = await openRepo(path.join(dir, 'hollow-creek-ledger', 'src'));
  history = await loadHistory(repo);
  spirits = gatherSpirits(history);
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the haunted repo has four spirits and one of them is alive', () => {
  assert.equal(history.length, 21);
  assert.equal(repo.name, 'hollow-creek-ledger');
  const kinds = Object.fromEntries([...spirits.values()].map((s) => [s.firstName, spiritStatus(s, opts).kind]));
  assert.deepEqual(kinds, { Dana: 'living', Priya: 'departed', Ezra: 'departed', Marisol: 'departed' });
  assert.ok(nightShare(spirits.get('marisol@hollowcreek.example')) >= 80);
});

test('summoning MAX_ATTEMPTS sees through Dana\'s revert to Marisol', async () => {
  const ev = await lineEvidence({ repo, spirits, file: 'src/settlement.js', start: 6, end: 6, opts });
  assert.equal(ev.spirit.name, 'Marisol Vega');
  assert.equal(ev.hops.length, 1);
  assert.equal(ev.hops[0].revertSha, bySubject('Revert "perf: lower MAX_ATTEMPTS to 3"').sha);
  assert.equal(ev.hops[0].revertedSha, bySubject('perf: lower MAX_ATTEMPTS to 3').sha);
  assert.equal(ev.origin.subject, "fix: keep one more retry than FirstPacific's breaker");

  const text = renderEvidence(ev);
  assert.ok(text.length <= 4600);
  assert.match(text, /six to trip the breaker plus one/);
  assert.match(text, /1\. In \[[0-9a-f]{7}\], Dana Kim replaced it \("perf: lower MAX_ATTEMPTS to 3"\)/);
  assert.match(text, /2\. In \[[0-9a-f]{7}\], Dana Kim reverted \[[0-9a-f]{7}\] and restored your original line/);
  assert.match(text, />    6 \| const MAX_ATTEMPTS = 7;/);
  assert.match(systemPrompt(ev, text), new RegExp(`\\[${ev.origin.sha.slice(0, 7)}\\]`));
});

test('a line with no explanation is marked as such', async () => {
  const ev = await lineEvidence({ repo, spirits, file: 'src/settlement.js', start: 9, end: 9, opts });
  assert.equal(ev.spirit.name, 'Marisol Vega');
  assert.match(renderEvidence(ev), /fix: hc-0013\n {4}\(no explanation was written in this commit message\)/);
});

test('ask ezra: the 1300ms sleep belongs to Ezra, and his comment is found', async () => {
  const ev = await lineEvidence({ repo, spirits, file: 'src/gateway.js', start: 8, end: 8, opts });
  assert.equal(ev.spirit.name, 'Ezra Thorne');
  assert.match(renderEvidence(ev), /one every 1200ms/);
  assert.deepEqual(await pickaxe(repo, '1300'), [bySubject('fix: throttle FirstPacific calls').sha]);
});

test('file and author summons pick the right spirit', async () => {
  const file = await fileEvidence({ repo, spirits, file: 'src/idempotency.js', opts });
  assert.equal(file.spirit.name, 'Priya Raman');
  assert.equal(file.owned, file.totalLines);
  const author = await authorEvidence({ repo, spirits, who: 'priya', opts });
  assert.equal(author.spirit.name, 'Priya Raman');
  assert.match(renderEvidence(author), /maintenance freeze/);
});

test('keyword divination finds the rounding commit and its author steps forward', async () => {
  const ranked = await divine({ question: 'why do we round half to even in the ledger?', pool: history });
  assert.equal(ranked[0].c.subject, 'fix: round half to even in the ledger');
  const ev = await questionEvidence({ repo, spirits, ranked, opts });
  assert.equal(ev.spirit.name, 'Ezra Thorne');
});

test('citations are checked against the evidence and the repository', async () => {
  const ev = await lineEvidence({ repo, spirits, file: 'src/settlement.js', start: 6, end: 6, opts });
  const real = bySubject('chore: adopt eslint').sha.slice(0, 7);
  const answer = `I set it [${ev.origin.sha.slice(0, 7)}]. See also [${real}] and [deadbe1].`;
  const kinds = (await verifyCitations(answer, ev.known, (t) => resolveCommit(repo, t))).map((r) => r.kind);
  assert.deepEqual(kinds, ['evidence', 'real', 'phantom']);
});

test('surviving lines are tallied per author', async () => {
  const out = await git(repo.root, ['blame', '--incremental', '-w', 'HEAD', '--', 'src/settlement.js']);
  const tally = tallyBlameIncremental(out);
  const total = (await git(repo.root, ['show', 'HEAD:src/settlement.js'])).split('\n').length - 1;
  assert.equal([...tally.values()].reduce((a, b) => a + b, 0), total);
  assert.ok(tally.get('marisol@hollowcreek.example') > tally.get('priya@hollowcreek.example'));
});
