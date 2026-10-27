import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openRepo, loadHistory, pickaxe, isDirty, git, GitError } from './git.js';
import { gatherSpirits } from './spirits.js';
import { Ollama, chooseModels, MEDIUM_OPTIONS, SpiritBoardError } from './ollama.js';
import { ensureIndex, divine, pickaxeTerms } from './crypt.js';
import { lineEvidence, fileEvidence, authorEvidence, questionEvidence, renderEvidence, SeanceError } from './evidence.js';
import { holdSeance, summoningBanner } from './medium.js';
import { graveyard } from './graveyard.js';
import { createUI } from './ui.js';

const HELP = `
  git séance: summon the ghost of whoever wrote that line.
  Runs entirely on your machine with an open-weight model through Ollama.

  Usage
    git seance summon <file>:<line>[-<end>]   talk to whoever wrote those lines
    git seance summon <file>                  talk to whoever owns most of a file
    git seance summon --author "<name>"       call a spirit by name
    git seance ask "<question>"               whoever remembers best steps forward
    git seance graveyard                      the authors who left, and what they left behind
    git seance index                          embed commit history for \`ask\` (cached in .git/seance)

  Options
    -q, --ask <question>    summon, ask one question, and leave
    -i, --interactive       keep talking after \`ask\` answers
    -a, --author <name>     who to summon (name or email, partial is fine)
    -m, --model <name>      the medium (default: the first Gemma you have installed)
        --embed-model <m>   the librarian (default: embeddinggemma or nomic-embed-text)
        --host <url>        Ollama address (default: $OLLAMA_HOST or 127.0.0.1:11434)
    -C, --cwd <dir>         run as if started in <dir>
        --days <n>          departed = no commit in n days (default 365)
        --max-files <n>     graveyard: files to count lines in (default 400)
        --max-commits <n>   history to consider (default 5000)
        --epitaphs          graveyard: let the medium carve epitaphs
        --show-evidence     print exactly what the medium is shown
        --plain             no colour, emoji or animation
        --no-fx             no animation
    -h, --help              this
    -v, --version

  Examples
    git seance src/settlement.js:6
    git seance summon src/gateway.js:8 -q "why the 1300ms sleep?"
    git seance ask "why is MAX_ATTEMPTS 7?" -i
    git seance graveyard --epitaphs
`;

const OPTIONS = {
  ask: { type: 'string', short: 'q' },
  interactive: { type: 'boolean', short: 'i' },
  author: { type: 'string', short: 'a' },
  model: { type: 'string', short: 'm' },
  'embed-model': { type: 'string' },
  host: { type: 'string' },
  cwd: { type: 'string', short: 'C' },
  days: { type: 'string', default: '365' },
  'max-files': { type: 'string', default: '400' },
  'max-commits': { type: 'string', default: '5000' },
  epitaphs: { type: 'boolean' },
  'show-evidence': { type: 'boolean' },
  plain: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const COMMANDS = new Set(['summon', 'ask', 'graveyard', 'index', 'help']);

export function parseTarget(arg) {
  const m = /^(.*?)(?::|#L)(\d+)(?:(?:-L|-|,)(\d+))?$/.exec(arg);
  if (!m) return { file: arg };
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  return { file: m[1], start: Math.min(a, b), end: Math.max(a, b) };
}

function repoPath(repo, cwd, file) {
  const rel = path.relative(path.resolve(repo.root), path.resolve(cwd, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new SeanceError(`${file} is not inside this repository.`);
  return rel.split(path.sep).join('/');
}

const int = (v, name) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) throw new SeanceError(`--${name} wants a positive number, got "${v}".`);
  return n;
};

async function connect(values) {
  const ollama = new Ollama(values.host);
  const models = await chooseModels(ollama, { model: values.model, embedModel: values['embed-model'] });
  return { ollama, ...models };
}

// summon/ask both end the same way: show the evidence if asked, light the candles, talk.
async function seance(ctx, ev, { retrieve, question, interactive }) {
  const { ui, repo, values, ollama, medium, think } = ctx;
  const evidence = renderEvidence(ev);
  if (values['show-evidence']) {
    ui.line();
    ui.line(ui.c.dim(evidence.split('\n').map((l) => `  │ ${l}`).join('\n')));
  }
  await summoningBanner(ui, ev);
  await holdSeance({ ui, ollama, model: medium, think, repo, ev, evidence, retrieve, question, interactive });
}

// Follow-up questions use keyword retrieval only. On an 8 GB laptop Ollama
// holds one model at a time, and swapping to the embedder mid-séance costs ~20s.
const lexicalRetriever = (pool, k = 3) => async (q, known) => {
  const ranked = await divine({ question: q, pool });
  const top = ranked[0]?.s ?? 0;
  return ranked.filter((r) => !known.has(r.c.sha) && r.s >= top * 0.75).slice(0, k).map((r) => r.c);
};

async function summonCmd(ctx, targetArg) {
  const { ui, repo, values, cwd, ollama, medium, opts } = ctx;
  ollama.load(medium, MEDIUM_OPTIONS).catch(() => {});
  const history = await loadHistory(repo, { max: ctx.maxCommits });
  const spirits = gatherSpirits(history);

  let ev;
  if (values.author) {
    ev = await authorEvidence({ repo, spirits, who: values.author, opts });
  } else {
    if (!targetArg) throw new SeanceError('summon whom? Give a file:line, a file, or --author "<name>".');
    const t = parseTarget(targetArg);
    const file = repoPath(repo, cwd, t.file);
    const committed = await git(repo.root, ['show', `HEAD:${file}`], { allowFail: true });
    if (committed === null) throw new SeanceError(`${file} isn't in HEAD. The dead only remember what was committed.`);
    const length = committed.split('\n').length - (committed.endsWith('\n') ? 1 : 0);
    if (t.start > length) throw new SeanceError(`${file} has only ${length} lines. Nobody ever wrote line ${t.start}.`);
    if (await isDirty(repo, file)) ui.line(ui.c.dim(`  (reading ${file} as of HEAD; uncommitted changes are invisible to the dead)`));
    ev = t.start
      ? await lineEvidence({ repo, spirits, file, start: t.start, end: Math.min(t.end, t.start + 39), opts })
      : await fileEvidence({ repo, spirits, file, opts });
  }
  const pool = history.filter((c) => c.email === ev.spirit.email);
  await seance(ctx, ev, { retrieve: lexicalRetriever(pool), question: values.ask, interactive: !values.ask });
}

async function askCmd(ctx, question) {
  const { ui, repo, values, ollama, librarian, medium, opts } = ctx;
  if (!question) throw new SeanceError('ask what? e.g. git seance ask "why do we sleep 1300ms before every call?"');
  const history = await loadHistory(repo, { max: ctx.maxCommits });
  const spirits = gatherSpirits(history);

  // The librarian works first, then the medium, so they never share the room.
  const bar = ui.progress('laying the history to rest in the crypt');
  const index = await ensureIndex({ repo, ollama, librarian, commits: history, onProgress: (n, total) => bar.update(n, total) });
  bar.done(index?.added ? `embedded ${index.added} commits with ${librarian}` : '');
  const boost = new Set();
  for (const term of pickaxeTerms(question)) for (const sha of await pickaxe(repo, term)) boost.add(sha);
  const ranked = await divine({ question, pool: history, index, ollama, boost });
  if (!ranked.length) throw new SeanceError('the house is silent. No commit remembers anything like that.');
  ollama.load(medium, MEDIUM_OPTIONS).catch(() => {});

  const ev = await questionEvidence({ repo, spirits, ranked, opts });
  await seance(ctx, ev, { retrieve: lexicalRetriever(history), question, interactive: Boolean(values.interactive) });
}

async function indexCmd(ctx) {
  const { ui, repo, ollama, librarian } = ctx;
  if (!librarian) throw new SeanceError('no embedding model installed. Try: ollama pull embeddinggemma');
  const history = await loadHistory(repo, { max: ctx.maxCommits });
  const bar = ui.progress(`embedding commits with ${librarian}`);
  const index = await ensureIndex({ repo, ollama, librarian, commits: history, onProgress: (n, total) => bar.update(n, total) });
  bar.done();
  ui.line(`  ${ui.g.candle} ${index.vec.size} commits rest in the crypt (${index.added} new), in ${path.join(repo.gitDir, 'seance')}`);
}

export async function main(argv) {
  let fx = true;
  const args = argv.filter((a) => (a === '--no-fx' ? ((fx = false), false) : true));
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`git seance: ${err.message}\nTry: git seance --help\n`);
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = parsed;
  const ui = createUI({ plain: values.plain, fx });

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    ui.line(pkg.version);
    return;
  }
  let [cmd, ...rest] = positionals;
  if (cmd && !COMMANDS.has(cmd)) {
    rest = [cmd, ...rest];
    cmd = 'summon';
  }
  if (!cmd && values.author) cmd = 'summon';
  if (values.help || !cmd || cmd === 'help') {
    ui.line(HELP);
    return;
  }

  try {
    const cwd = path.resolve(values.cwd ?? process.cwd());
    const repo = await openRepo(cwd);
    const ctx = {
      ui,
      repo,
      values,
      cwd,
      maxCommits: int(values['max-commits'], 'max-commits'),
      opts: { departedAfterDays: int(values.days, 'days') },
    };
    if (cmd === 'graveyard') {
      const spirits = gatherSpirits(await loadHistory(repo, { max: ctx.maxCommits }));
      const medium = values.epitaphs ? await connect(values) : null;
      await graveyard({
        ui,
        repo,
        spirits,
        opts: ctx.opts,
        maxFiles: int(values['max-files'], 'max-files'),
        medium: medium && { ollama: medium.ollama, model: medium.medium, think: medium.think },
      });
      return;
    }
    Object.assign(ctx, await connect(values));
    if (cmd === 'summon') await summonCmd(ctx, rest[0]);
    else if (cmd === 'ask') await askCmd(ctx, rest.join(' ').trim());
    else if (cmd === 'index') await indexCmd(ctx);
  } catch (err) {
    if (err instanceof GitError || err instanceof SpiritBoardError || err instanceof SeanceError) {
      ui.line(`\n  ${ui.c.blood(`${ui.g.warn} ${err.message}`)}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
