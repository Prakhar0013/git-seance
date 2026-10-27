#!/usr/bin/env node
// Builds hollow-creek-ledger: a small, entirely fictional payments service with
// nine years of history and four developers, three of whom have moved on.
// It exists so git séance has someone to summon in demos and tests.
//
//   node scripts/make-haunted-repo.js [dir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PEOPLE = {
  marisol: { name: 'Marisol Vega', email: 'marisol@hollowcreek.example' },
  ezra: { name: 'Ezra Thorne', email: 'ezra.thorne@hollowcreek.example' },
  priya: { name: 'Priya Raman', email: 'priya@hollowcreek.example' },
  dana: { name: 'Dana Kim', email: 'dana@hollowcreek.example' },
};

function settlementJs(f) {
  const L = ["'use strict';", "const gateway = require('./gateway');"];
  if (f.idem) L.push("const { settlementKey } = require('./idempotency');");
  L.push('');
  if (f.comment) L.push("// one more than FirstPacific's breaker. don't lower. see commit message.");
  L.push(`const MAX_ATTEMPTS = ${f.attempts};`);
  if (f.backoff) L.push('const BACKOFF_MS = 2000;');
  if (f.skip) L.push('', "const SKIP_MERCHANTS = new Set(['HC-0013']);");
  L.push('');
  if (f.idem) {
    L.push('async function settle(merchant, batchDate) {', '  const key = settlementKey(merchant.id, batchDate, merchant.balanceCents);');
  } else {
    L.push('async function settle(merchant) {');
  }
  L.push('  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {', '    try {');
  L.push(f.idem
    ? '      return await gateway.settle({ merchantId: merchant.id, amountCents: merchant.balanceCents, idempotencyKey: key });'
    : '      return await gateway.settle({ merchantId: merchant.id, amountCents: merchant.balanceCents });');
  L.push('    } catch (err) {', '      if (attempt === MAX_ATTEMPTS) throw err;');
  if (f.backoff) L.push('      await sleep(BACKOFF_MS * attempt);');
  L.push('    }', '  }', '}');
  if (f.batch) {
    L.push('', f.idem ? 'async function runBatch(merchants, batchDate = new Date()) {' : 'async function runBatch(merchants) {');
    if (f.maint) L.push('  if (inMaintenanceWindow(batchDate)) await sleep(untilWindowEnds(batchDate));');
    L.push('  const results = [];', '  for (const merchant of merchants) {');
    if (f.skip) L.push('    if (SKIP_MERCHANTS.has(merchant.id)) continue;');
    L.push(f.idem ? '    results.push(await settle(merchant, batchDate));' : '    results.push(await settle(merchant));');
    L.push('  }', '  return results;', '}');
  }
  if (f.maint) {
    L.push(
      '',
      '// FirstPacific freezes settlement 02:00-02:30 UTC on the first Tuesday of the month.',
      'function inMaintenanceWindow(d) {',
      '  const firstTuesday = d.getUTCDay() === 2 && d.getUTCDate() <= 7;',
      '  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();',
      '  return firstTuesday && minutes >= 120 && minutes < 150;',
      '}',
      '',
      'function untilWindowEnds(d) {',
      '  return (150 - (d.getUTCHours() * 60 + d.getUTCMinutes())) * 60 * 1000;',
      '}',
    );
  }
  if (f.backoff) L.push('', 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));');
  L.push('', `module.exports = { settle, ${f.batch ? 'runBatch, ' : ''}MAX_ATTEMPTS };`, '');
  return L.join('\n');
}

function gatewayJs(f) {
  const L = [
    "'use strict';",
    "const fetch = require('node-fetch');",
    '',
    "const FIRSTPACIFIC_URL = process.env.FIRSTPACIFIC_URL || 'https://api.firstpacific.example/v2';",
  ];
  if (f.timeout) L.push('const TIMEOUT_MS = 30000;');
  L.push('', 'async function settle(payload) {');
  if (f.throttle) L.push("  await sleep(1300); // don't touch. ask ezra.");
  L.push('  const res = await fetch(`${FIRSTPACIFIC_URL}/settlements`, {', "    method: 'POST',");
  if (f.auth) {
    L.push('    headers: {', "      'content-type': 'application/json',", '      authorization: `Bearer ${merchantKey(payload.merchantId)}`,', '    },');
  } else {
    L.push("    headers: { 'content-type': 'application/json' },");
  }
  L.push('    body: JSON.stringify(payload),');
  if (f.timeout) L.push('    timeout: TIMEOUT_MS,');
  L.push('  });', '  if (!res.ok) throw new Error(`FirstPacific ${res.status}`);', '  return res.json();', '}');
  if (f.auth) L.push('', 'function merchantKey(merchantId) {', "  return process.env[`FP_KEY_${merchantId.replace(/-/g, '_')}`];", '}');
  if (f.throttle) L.push('', 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));');
  L.push('', 'module.exports = { settle };', '');
  return L.join('\n');
}

function ledgerJs(f) {
  const round = f.halfEven ? 'roundHalfEven' : 'Math.round';
  const L = [
    "'use strict';",
    '// All money is integer cents. Never floats.',
    '',
    'function toCents(amount) {',
    `  return ${round}(amount * 100);`,
    '}',
    '',
    'function fee(cents, rate) {',
    `  return ${round}(cents * rate);`,
    '}',
  ];
  if (f.halfEven) {
    L.push(
      '',
      '// FirstPacific settles with round-half-to-even, so we do too.',
      'function roundHalfEven(x) {',
      '  const r = Math.round(x);',
      '  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;',
      '}',
    );
  }
  L.push('', 'module.exports = { toCents, fee };', '');
  return L.join('\n');
}

const pkg = (node) => `${JSON.stringify({
  name: 'hollow-creek-ledger',
  version: '1.0.0',
  private: true,
  description: 'Nightly merchant settlement for Hollow Creek Payments.',
  main: 'src/settlement.js',
  engines: { node: `>=${node}` },
  dependencies: { 'node-fetch': '^1.7.3' },
}, null, 2)}\n`;

const README = `# hollow-creek-ledger

Nightly merchant settlement for Hollow Creek Payments. Talks to the FirstPacific gateway.

    npm install
    node -e "require('./src/settlement').runBatch(require('./merchants.json'))"
`;

const FAQ = `
## FAQ

**Why is MAX_ATTEMPTS 7?** Don't lower it. We tried (Feb 2024).

**Why does gateway.js say "ask ezra"?** Ezra left in 2020. Nobody knows. Don't touch it.
`;

const NOTES = `# Notes for whoever comes next

- Settlement runs at 02:00 server time. FirstPacific is the only gateway.
- MAX_ATTEMPTS is 7 on purpose. Read the commit before you touch it.
- Backoff is linear. Don't make it exponential, the batch window is short.
- Ledger amounts are integer cents. Never floats.
`;

const EZRA_NOTES = `- Rounding is half-to-even because FirstPacific does it. Lorraine in accounting can tell you more.
- gateway.js is mine. It's in better shape than it looks.
`;

const RUNBOOK = `# On-call runbook

- Batch failed between 02:00 and 02:30 UTC on a first Tuesday? That's the FirstPacific freeze. It retries after.
- Duplicate settlement reported? Check the idempotency key in the gateway logs before refunding anything.
`;

const S = { attempts: 3 };
const G = {};

// [who, date, utc offset, subject, body, files]
const HISTORY = [
  ['marisol', '2017-06-02 01:47:12', '-0500', 'init: settlement service skeleton', '', () => ({
    'package.json': pkg(6), 'README.md': README, 'src/gateway.js': gatewayJs(G), 'src/settlement.js': settlementJs(S),
  })],
  ['marisol', '2017-06-09 02:31:40', '-0500', 'feat: nightly settlement batch', '', () => ({ 'src/settlement.js': settlementJs(Object.assign(S, { batch: true })) })],
  ['marisol', '2017-09-14 23:58:03', '-0500', 'feat: ledger in integer cents',
    'Floats were losing pennies on refunds. Everything is cents now.', () => ({ 'src/ledger.js': ledgerJs({}) })],
  ['marisol', '2018-01-22 03:05:51', '-0500', 'fix: back off between settlement retries',
    'Hammering FirstPacific right after a connection reset just gets us reset again. Linear backoff, 2s per attempt.',
    () => ({ 'src/settlement.js': settlementJs(Object.assign(S, { backoff: true })) })],
  ['marisol', '2018-03-11 02:13:27', '-0500', "fix: keep one more retry than FirstPacific's breaker",
    "FirstPacific's gateway trips its circuit breaker after six consecutive failures during the 02:00 batch window, then needs one clean attempt to half-open again. With 3 attempts we were abandoning about 4% of settlements every night.\n\nSeven is six to trip the breaker plus one to find it half-open. Measured over 9 nights: zero abandoned. Do not lower this without talking to FirstPacific.",
    () => ({ 'src/settlement.js': settlementJs(Object.assign(S, { attempts: 7, comment: true })) })],
  ['ezra', '2018-05-03 10:15:00', '-0400', 'feat: authenticate gateway calls with merchant keys', '',
    () => ({ 'src/gateway.js': gatewayJs(Object.assign(G, { auth: true })) })],
  ['ezra', '2018-07-19 16:40:22', '-0400', 'fix: throttle FirstPacific calls',
    "We got 429'd at 02:04 three nights running. FirstPacific allows 50 requests per minute per merchant key, which is one every 1200ms. The extra 100ms is headroom for clock drift between our box and theirs. They have no burst allowance; I asked their support (ticket FP-88213).",
    () => ({ 'src/gateway.js': gatewayJs(Object.assign(G, { throttle: true })) })],
  ['ezra', '2018-10-02 11:02:09', '-0400', 'fix: round half to even in the ledger',
    "Lorraine in accounting confirmed FirstPacific settles with banker's rounding. Math.round was drifting us one cent on roughly 1 in 300 batches.",
    () => ({ 'src/ledger.js': ledgerJs({ halfEven: true }) })],
  ['marisol', '2019-02-14 03:22:45', '-0500', 'fix: hc-0013', '',
    () => ({ 'src/settlement.js': settlementJs(Object.assign(S, { skip: true })) })],
  ['marisol', '2019-04-30 18:05:31', '-0400', 'chore: hand settlement over to ezra',
    "My last day. The batch is Ezra's now. I wrote down what I could in NOTES.md.", () => ({ 'NOTES.md': NOTES })],
  ['priya', '2019-08-12 11:20:05', '+0530', 'feat: idempotency keys for settlement',
    'With seven attempts per merchant we can double-settle if FirstPacific accepts a request but the response is lost on the way back. The key is sha256(merchant, batch date, amount), so a retry of the same settlement is a no-op on their side.',
    () => ({
      'src/idempotency.js': "'use strict';\nconst crypto = require('crypto');\n\n// Same merchant, same batch date, same amount: same key. FirstPacific drops duplicates.\nfunction settlementKey(merchantId, batchDate, amountCents) {\n  const day = batchDate.toISOString().slice(0, 10);\n  return crypto.createHash('sha256').update(`${merchantId}|${day}|${amountCents}`).digest('hex');\n}\n\nmodule.exports = { settlementKey };\n",
      'src/settlement.js': settlementJs(Object.assign(S, { idem: true })),
    })],
  ['priya', '2019-11-05 14:48:10', '+0530', "fix: wait out FirstPacific's monthly maintenance freeze",
    'FirstPacific freezes settlement 02:00-02:30 UTC on the first Tuesday of each month. Requests during the freeze return 503 and burn through all seven retries. We now sleep until the window closes.',
    () => ({ 'src/settlement.js': settlementJs(Object.assign(S, { maint: true })) })],
  ['ezra', '2020-03-17 09:30:00', '-0400', 'chore: move to node 12', '', () => ({ 'package.json': pkg(12) })],
  ['ezra', '2020-08-28 17:55:42', '-0400', 'docs: notes for whoever comes next', 'Leaving Friday.',
    () => ({ 'NOTES.md': NOTES + EZRA_NOTES })],
  ['priya', '2021-01-08 13:12:00', '+0530', 'refactor: name the gateway timeout', '',
    () => ({ 'src/gateway.js': gatewayJs(Object.assign(G, { timeout: true })) })],
  ['priya', '2021-06-30 17:40:00', '+0530', 'chore: on-call runbook', '', () => ({ 'RUNBOOK.md': RUNBOOK })],
  ['dana', '2021-09-13 10:05:00', '-0700', 'chore: adopt eslint', '',
    () => ({ '.eslintrc.json': '{\n  "extends": "eslint:recommended",\n  "env": { "node": true, "es2020": true }\n}\n' })],
  ['dana', '2024-02-06 15:20:11', '-0800', 'perf: lower MAX_ATTEMPTS to 3',
    "The nightly batch takes 41 minutes and most of it is retry backoff. Nobody here remembers why it's 7.",
    () => ({ 'src/settlement.js': settlementJs({ ...S, attempts: 3 }) })],
  ['dana', '2024-02-07 08:12:40', '-0800', 'Revert "perf: lower MAX_ATTEMPTS to 3"',
    'This reverts commit {{previous}}.\n\n212 settlements were abandoned overnight, all inside the 02:00 window. Putting it back and leaving it alone.',
    () => ({ 'src/settlement.js': settlementJs(S) })],
  ['dana', '2025-05-20 11:00:00', '-0700', 'docs: FAQ', '', () => ({ 'README.md': README + FAQ })],
  ['dana', '2026-10-19 16:44:00', '-0700', 'chore: move to node 22', '', () => ({ 'package.json': pkg(22) })],
];

export function makeHauntedRepo(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (args, env, input) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, input, encoding: 'utf8' }).trim();
  run(['init', '-q', '-b', 'main']);
  run(['config', 'core.autocrlf', 'false']);
  // A throwaway fixture: don't ask for a signing key.
  run(['config', 'commit.gpgsign', 'false']);

  let previous = '';
  for (const [who, when, tz, subject, body, files] of HISTORY) {
    for (const [file, content] of Object.entries(files())) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    run(['add', '-A']);
    const p = PEOPLE[who];
    const date = `${when} ${tz}`;
    const message = body ? `${subject}\n\n${body.replace('{{previous}}', previous)}\n` : `${subject}\n`;
    run(['commit', '-q', '-F', '-'], {
      GIT_AUTHOR_NAME: p.name, GIT_AUTHOR_EMAIL: p.email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: p.name, GIT_COMMITTER_EMAIL: p.email, GIT_COMMITTER_DATE: date,
    }, message);
    previous = run(['rev-parse', 'HEAD']);
  }
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? 'hollow-creek-ledger');
  makeHauntedRepo(dir);
  console.log(`Haunted ${dir}\nTry: cd "${dir}" && git seance graveyard`);
}
