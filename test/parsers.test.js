import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlamePorcelain, parseCommitLog, tallyBlameIncremental, trimPatch, nearestExactLine } from '../src/git.js';
import { parseTarget } from '../src/cli.js';
import { extractCitations } from '../src/medium.js';
import { keywords, pickaxeTerms } from '../src/crypt.js';
import { commentText, renderCommit } from '../src/evidence.js';
import { normalizeHost } from '../src/ollama.js';
import { ago, spiritStatus } from '../src/spirits.js';
import { Wrapper, center, wrapWords } from '../src/ui.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('parseTarget understands file:line, ranges and GitHub anchors', () => {
  assert.deepEqual(parseTarget('src/a.js:42'), { file: 'src/a.js', start: 42, end: 42 });
  assert.deepEqual(parseTarget('src/a.js:40-60'), { file: 'src/a.js', start: 40, end: 60 });
  assert.deepEqual(parseTarget('src/a.js:60,40'), { file: 'src/a.js', start: 40, end: 60 });
  assert.deepEqual(parseTarget('src/a.js#L10-L12'), { file: 'src/a.js', start: 10, end: 12 });
  assert.deepEqual(parseTarget('C:\\repo\\a.js:7'), { file: 'C:\\repo\\a.js', start: 7, end: 7 });
  assert.deepEqual(parseTarget('README.md'), { file: 'README.md' });
});

test('parseBlamePorcelain reads authors and content', () => {
  const out = [
    `${A} 5 6 1`,
    'author Marisol Vega',
    'author-mail <Marisol@Example.com>',
    'author-time 1520752407',
    'summary fix: keep one more retry',
    'filename src/settlement.js',
    '\tconst MAX_ATTEMPTS = 7;\r',
    `${'0'.repeat(40)} 7 7 1`,
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'filename src/settlement.js',
    '\tconst BACKOFF_MS = 2000;',
  ].join('\n');
  const [first, second] = parseBlamePorcelain(out);
  assert.equal(first.sha, A);
  assert.equal(first.line, 6);
  assert.equal(first.origLine, 5);
  assert.equal(first.email, 'marisol@example.com');
  assert.equal(first.content, 'const MAX_ATTEMPTS = 7;');
  assert.equal(second.name, 'Not Committed Yet');
});

test('tallyBlameIncremental counts lines per author, headers only once', () => {
  const out = [
    `${A} 1 1 3`, 'author X', 'author-mail <x@e.com>', 'filename f.js',
    `${B} 4 4 2`, 'author Y', 'author-mail <y@e.com>', 'filename f.js',
    `${A} 9 6 4`, 'filename f.js',
  ].join('\n');
  const tally = tallyBlameIncremental(out);
  assert.equal(tally.get('x@e.com'), 7);
  assert.equal(tally.get('y@e.com'), 2);
});

test('parseCommitLog splits on git format separators', () => {
  const out = `\x1e${A}\x1fEzra Thorne\x1fEzra@E.com\x1f2018-07-19T16:40:22-04:00\x1ffix: throttle\x1fWe got 429'd.\nTwice.\n\x1d\n\nsrc/gateway.js\n`;
  const [c] = parseCommitLog(out);
  assert.equal(c.name, 'Ezra Thorne');
  assert.equal(c.email, 'ezra@e.com');
  assert.equal(c.body, "We got 429'd.\nTwice.");
  assert.match(c.rest, /src\/gateway\.js/);
});

test('trimPatch keeps only changed lines', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const A = 3;\n+const A = 7;\n context';
  assert.deepEqual(trimPatch(patch), ['-const A = 3;', '+const A = 7;']);
  assert.equal(trimPatch(Array.from({ length: 20 }, (_, i) => `+line ${i}`).join('\n'), { maxLines: 3 }).length, 4);
});

test('nearestExactLine prefers the match closest to the hint', () => {
  assert.equal(nearestExactLine(['x', 'a', 'x', 'x', 'a'], 'a', 5), 4);
  assert.equal(nearestExactLine(['x'], 'a', 1), -1);
});

test('extractCitations finds hashes but not hex-looking words', () => {
  assert.deepEqual(extractCitations('I set it [16d6516] and later [d18b0da].'), ['16d6516', 'd18b0da']);
  assert.deepEqual(extractCitations('commit 041938c fixed it'), ['041938c']);
  assert.deepEqual(extractCitations('a decade, a facade, 1234567 cents'), []);
  assert.deepEqual(extractCitations('see [1234567]'), ['1234567']);
});

test('pickaxeTerms picks numbers, identifiers and quoted strings', () => {
  assert.deepEqual(pickaxeTerms('why the 1300ms sleep?'), ['1300']);
  assert.deepEqual(pickaxeTerms('why is MAX_ATTEMPTS 7'), ['MAX_ATTEMPTS']);
  assert.deepEqual(pickaxeTerms('why skip HC-0013?'), ['HC-0013']);
  assert.deepEqual(pickaxeTerms('what does `retry storm` mean'), ['retry storm']);
  assert.deepEqual(pickaxeTerms("why don't we use v2.5"), []);
});

test('keywords drops stopwords and short words', () => {
  assert.deepEqual(keywords('Why do we round half to even?'), ['round', 'half', 'even']);
});

test('commentText recognises full-line and trailing comments', () => {
  assert.equal(commentText("  // one more than FirstPacific's breaker"), "// one more than FirstPacific's breaker");
  assert.equal(commentText("  await sleep(1300); // don't touch. ask ezra."), "await sleep(1300); // don't touch. ask ezra.");
  assert.equal(commentText('# settle at night'), '# settle at night');
  assert.equal(commentText('#!/usr/bin/env node'), null);
  assert.equal(commentText("const url = 'http://example.com';"), null);
});

test('renderCommit marks commits that never said why', () => {
  const c = { sha: A, date: '2019-02-14T03:22:45-05:00', name: 'Marisol Vega', subject: 'fix: hc-0013', body: '' };
  assert.match(renderCommit(c), /no explanation was written/);
  assert.match(renderCommit({ ...c, body: `This reverts commit ${B}.` }), /This reverts commit bbbbbbb\./);
});

test('normalizeHost accepts the forms OLLAMA_HOST takes', () => {
  assert.equal(normalizeHost(undefined), 'http://127.0.0.1:11434');
  assert.equal(normalizeHost('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(normalizeHost('localhost:9999'), 'http://localhost:9999');
  assert.equal(normalizeHost('https://ollama.example/'), 'https://ollama.example');
});

test('spirits are living, fading or departed', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const at = (d) => spiritStatus({ last: d }, { now, departedAfterDays: 365 }).kind;
  assert.equal(at('2026-10-19T16:44:00-07:00'), 'living');
  assert.equal(at('2026-03-01T00:00:00Z'), 'fading');
  assert.equal(at('2019-04-30T18:05:31-04:00'), 'departed');
  assert.equal(ago(0), 'today');
  assert.equal(ago(1), '1 day ago');
  assert.equal(ago(2700), '7 years ago');
});

test('Wrapper wraps streamed words without splitting them', () => {
  let out = '';
  const w = new Wrapper((s) => (out += s), { width: 20, prefix: '> ', indent: '  ' });
  w.start();
  for (const chunk of ['The **can', 'dles** flick', 'er in the old ', 'commits tonight.']) w.push(chunk);
  w.flush();
  assert.equal(out, '> The candles\n  flicker in the old\n  commits tonight.');
  for (const l of out.split('\n')) assert.ok(l.length <= 20, l);
});

test('center and wrapWords fit tombstones', () => {
  assert.equal(center('RIP', 7), '  RIP  ');
  assert.equal(center('a very long name indeed', 8).length, 8);
  assert.deepEqual(wrapWords('rests between the retries', 12), ['rests', 'between the', 'retries']);
});
