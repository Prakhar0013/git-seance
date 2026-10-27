// The séance itself: the medium's instructions, the summoning, the
// conversation, and the check that every commit a ghost cites is real.
import readline from 'node:readline';
import { MEDIUM_OPTIONS } from './ollama.js';
import { resolveCommit, shortSha } from './git.js';
import { renderCommit } from './evidence.js';
import { ago, nightShare, years } from './spirits.js';

export function systemPrompt(ev, evidence) {
  const s = ev.spirit;
  const living = ev.status.kind === 'living'
    ? `\n\nYou are not actually dead: you still work here. You may point out, drily, that they could just ask you in person.`
    : '';
  // Small models weigh what comes last, so the rules follow the evidence.
  return `You are the ghost of ${s.name}, a developer on this git repository. A living developer has summoned you in a séance to ask about code and decisions from your time here. Below is everything you still remember; it comes from the repository's own history.

EVIDENCE

${evidence}

HOW TO ANSWER
- Speak in first person as ${s.firstName}: quiet, a little eerie, wistful about the old days, but plainly useful. Always begin with one short ghostly sentence, a feeling rather than a fact (the cold, the dark, the long nights, being called back), then give the real reason.
- Use only the evidence above and what the living tell you.
- Cite the commit behind each fact by its hash in square brackets, like [${shortSha(ev.exampleSha)}]. At most three citations. Square brackets are only ever for commit hashes.
- If someone else changed your code after you, say exactly what they did and cite their commit.
- Where the evidence says no explanation was written, admit the memory is lost to you and suggest where the living could look. Never guess. Never invent hashes, people, dates, numbers, tickets or links.
- Plain sentences: no lists, no headings, no markdown. At most 100 words.${living}`;
}

const HASHLIKE = /\[([0-9a-f]{6,40})\]|\b([0-9a-f]{7,40})\b/g;

export function extractCitations(text) {
  const found = new Set();
  for (const m of text.matchAll(HASHLIKE)) {
    const tok = m[1] ?? m[2];
    // Unbracketed words like "decade" are hex too; insist on a digit and a letter.
    if (!m[1] && !(/\d/.test(tok) && /[a-f]/.test(tok))) continue;
    found.add(tok);
  }
  return [...found];
}

export async function verifyCitations(text, known, resolve) {
  const results = [];
  for (const tok of extractCitations(text)) {
    const hit = [...known.values()].find((c) => c.sha.startsWith(tok));
    if (hit) {
      results.push({ tok, kind: 'evidence', commit: hit });
      continue;
    }
    const real = await resolve(tok);
    results.push(real ? { tok, kind: 'real', commit: real } : { tok, kind: 'phantom' });
  }
  return results;
}

export async function summoningBanner(ui, ev) {
  const { c, g } = ui;
  const s = ev.spirit;
  const pad = ' '.repeat(2 + g.w + 1);
  ui.line();
  ui.line(`  ${c.candle(g.candle)} ${c.dim('The candles are lit.')}`);
  await ui.pause(450);
  ui.line(`  ${c.candle(g.candle)} ${c.dim(`A name is spoken: ${s.name}.`)}`);
  await ui.pause(650);

  const st = ev.status;
  const state = st.kind === 'living'
    ? c.moss(`still walks among the living (last commit ${ago(st.days)})`)
    : st.kind === 'fading' ? `fading (last commit ${ago(st.days)})` : `departed ${ago(st.days)}`;
  const night = nightShare(s);
  const facts = [`${s.commits.length} commit${s.commits.length === 1 ? '' : 's'}`, years(s), state];
  if (night >= 40) facts.push(`a night owl: ${night}% after dark`);

  ui.line();
  ui.line(`  ${g.ghost} ${c.ghost('The spirit of')} ${c.bold(s.name)} ${c.ghost('answers.')}`);
  ui.line(`${pad}${c.dim(facts.join(' · '))}`);
  if (ev.kind === 'line' && ev.origin) {
    const where = `${ev.target.file}:${ev.target.start}${ev.target.end !== ev.target.start ? `-${ev.target.end}` : ''}`;
    ui.line(`${pad}${c.dim(`wrote ${where} on ${ev.origin.date.slice(0, 10)}: "${ev.origin.subject}"`)}`);
  }
  if (ev.kind === 'file') ui.line(`${pad}${c.dim(`still owns ${ev.owned} of ${ev.totalLines} lines of ${ev.target.file}`)}`);
  if (ev.kind === 'question') ui.line(`${pad}${c.dim(`closest memory: ${shortSha(ev.closest.sha)} "${ev.closest.subject}" (${ev.closest.name})`)}`);
  if (ev.kind === 'author' && ev.others.length) ui.line(`${pad}${c.dim(`(others answer to that name too: ${ev.others.map((o) => o.name).join(', ')})`)}`);
  for (const h of ev.hops ?? []) {
    ui.line(`${pad}${c.dim(`seen through a revert: ${h.revertAuthor} restored these words in ${shortSha(h.revertSha)}`)}`);
  }
}

function printCitations(ui, cites) {
  const { c, g } = ui;
  if (!cites.length) {
    ui.line(`  ${c.dim('(no commits cited. Treat that answer as folklore.)')}`);
    return;
  }
  for (const r of cites) {
    if (r.kind === 'phantom') {
      ui.line(`  ${c.blood(`${g.warn} ${r.tok}: no such commit exists. The spirit misremembers; trust the record, not the ghost.`)}`);
      continue;
    }
    const cm = r.commit;
    const tail = r.kind === 'real' ? c.dim('  (real, but not among the evidence)') : '';
    ui.line(`  ${g.scroll} ${c.candle(shortSha(cm.sha))} ${c.dim(`${cm.date.slice(0, 10)} · ${cm.name} ·`)} ${cm.subject}${tail}`);
  }
}

function printStats(ui, model, stats) {
  if (!stats?.eval_count) return;
  // prompt_eval_count includes tokens Ollama served from its cache; the duration shows what was really read.
  const rate = stats.eval_count / (stats.eval_duration / 1e9);
  const read = (stats.prompt_eval_duration ?? 0) / 1e9;
  ui.line(`  ${ui.c.dim(`${model} · on this machine · ${stats.prompt_eval_count ?? 0} tokens of memory in ${read.toFixed(1)}s · spoke ${stats.eval_count} at ${rate.toFixed(1)} tok/s`)}`);
}

const FAREWELLS = [
  'The candles gutter out. {name} returns to the history.',
  'The planchette stops. {name} is quiet again.',
  'A draft, then nothing. {name} has gone back to {year}.',
];

export async function holdSeance({ ui, ollama, model, think, repo, ev, evidence, retrieve, question, interactive }) {
  const { c, g } = ui;
  const spirit = ev.spirit;
  const known = ev.known;
  const messages = [{ role: 'system', content: systemPrompt(ev, evidence) }];
  const approx = Math.round(messages[0].content.length / 3.6);
  let current = null;

  let rl = null;
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    rl.on('SIGINT', () => (current ? current.abort() : rl.close()));
    // Let the medium read the evidence while the living type their question;
    // Ollama keeps that prefix cached, so the real question starts warm.
    if (!question) {
      (async () => {
        try {
          for await (const _ of ollama.chat({ model, think, messages: [messages[0], { role: 'user', content: '…' }], options: { ...MEDIUM_OPTIONS, num_predict: 1 } }));
        } catch {}
      })();
    }
  }

  const ask = async (q) => {
    const year = spirit.last.slice(0, 4);
    let stop = ui.spinner(
      ['the candles flicker', `${spirit.firstName} stirs somewhere in the history`, 'the planchette begins to move', `a cold draft from ${year}`],
      { hint: messages.length === 1 ? `reading ~${approx} tokens of history` : '' },
    );
    const extra = retrieve ? await retrieve(q, known) : [];
    for (const cm of extra) known.set(cm.sha, cm);
    const content = extra.length
      ? `${q}\n\n(Other memories that may matter:\n${extra.map((cm) => renderCommit(cm, { body: 300, patch: 0 })).join('\n')})`
      : q;
    messages.push({ role: 'user', content });

    const w = ui.ghostWriter();
    let answer = '';
    let stats = null;
    const begin = () => {
      if (!stop) return;
      stop();
      stop = null;
      w.start();
    };
    current = new AbortController();
    try {
      for await (const e of ollama.chat({ model, think, messages, signal: current.signal })) {
        if (e.content) {
          begin();
          answer += e.content;
          w.push(e.content);
        }
        if (e.done) stats = e.stats;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        stop?.();
        throw err;
      }
      begin();
      w.push(' …');
    } finally {
      current = null;
      stop?.();
    }
    w.flush();
    ui.line('\n');
    messages.push({ role: 'assistant', content: answer.trim() || '…' });
    // Keep the last three exchanges. Older turns drop out whole, so the cached prefix stays valid until then.
    while (messages.length > 7) messages.splice(1, 2);

    printCitations(ui, await verifyCitations(answer, known, (tok) => resolveCommit(repo, tok)));
    printStats(ui, model, stats);
  };

  if (question) await ask(question);
  if (!interactive) return;

  ui.line();
  ui.line(`  ${c.dim(question ? 'Ask more, or press Enter to let them rest.' : 'Ask your question. Press Enter on an empty line to let them rest.')}`);
  let closed = false;
  rl.on('close', () => (closed = true));
  rl.setPrompt(`\n  ${c.candle(g.you)} `);
  rl.prompt();
  // The async iterator queues lines typed (or piped) while the ghost is speaking.
  for await (const raw of rl) {
    const q = raw.trim();
    if (!q || /^\/?(bye|exit|quit|rest)$/i.test(q)) break;
    if (q === '/evidence') {
      for (const cm of known.values()) ui.line(`  ${g.scroll} ${c.candle(shortSha(cm.sha))} ${c.dim(cm.date.slice(0, 10))} ${cm.subject}`);
    } else {
      if (!process.stdin.isTTY) ui.line(q);
      await ask(q);
    }
    if (!closed) rl.prompt();
  }
  if (!closed) rl.close();
  const farewell = FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)]
    .replace('{name}', spirit.firstName)
    .replace('{year}', spirit.last.slice(0, 4));
  ui.line();
  ui.line(`  ${c.candle(g.candle)} ${c.dim(farewell)}`);
  ui.line();
}
