// The graveyard: every author who stopped committing, ranked by how much of
// their code is still running. Optional epitaphs come from the local medium.
import { git, textFiles, tallyBlameIncremental } from './git.js';
import { spiritStatus, ago, years } from './spirits.js';
import { tombstones } from './ui.js';

async function survivingLines(repo, ui, maxFiles) {
  const files = await textFiles(repo);
  const sample = files.slice(0, maxFiles);
  const tally = new Map();
  const bar = ui.progress('counting the lines the dead left behind');
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < sample.length) {
      const file = sample[next++];
      const args = ['blame', '--incremental', '-w', 'HEAD', '--', file];
      if (repo.ignoreRevs) args.splice(3, 0, '--ignore-revs-file', repo.ignoreRevs);
      const out = await git(repo.root, args, { allowFail: true });
      if (out) tallyBlameIncremental(out, tally);
      bar.update(++done, sample.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  bar.done();
  return { tally, sampled: sample.length, total: files.length };
}

async function writeEpitaphs({ ollama, model, think, dead }) {
  const people = dead.map((s) => `${s.name}: ${s.commits.slice(0, 6).map((c) => `"${c.subject}"`).join('; ')}`).join('\n');
  const format = {
    type: 'object',
    properties: {
      epitaphs: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, epitaph: { type: 'string' } }, required: ['name', 'epitaph'] },
      },
    },
    required: ['epitaphs'],
  };
  const text = await ollama.complete({
    model,
    think,
    format,
    messages: [{
      role: 'user',
      content: `Write a tombstone epitaph for each of these departed developers, judging only by their commit messages. At most 7 words each. Wry, gentle, a little eerie. Do not use their names in the epitaph.\n\n${people}`,
    }],
  });
  const map = new Map();
  try {
    for (const e of JSON.parse(text).epitaphs ?? []) map.set(e.name, String(e.epitaph).replace(/^["']|["']$/g, ''));
  } catch {}
  return map;
}

export async function graveyard({ ui, repo, spirits, opts, maxFiles, medium }) {
  const { c, g } = ui;
  const all = [...spirits.values()].map((s) => ({ s, st: spiritStatus(s, opts) }));
  const dead = all.filter((x) => x.st.kind === 'departed');
  const fading = all.filter((x) => x.st.kind === 'fading');
  const living = all.filter((x) => x.st.kind === 'living');

  ui.line();
  ui.line(`  ${g.grave}  ${c.bold(`THE GRAVEYARD OF ${repo.name.toUpperCase()}`)}`);
  ui.line(`     ${c.dim(`${all.length} spirit${all.length === 1 ? ' has' : 's have'} committed here. ${dead.length} ha${dead.length === 1 ? 's' : 've'} departed (no commit in ${opts.departedAfterDays} days).`)}`);
  ui.line();
  if (!dead.length) {
    ui.line(`  ${c.moss('No graves yet. Everyone who ever committed here is still around.')}`);
    ui.line();
    return;
  }

  const { tally, sampled, total } = await survivingLines(repo, ui, maxFiles);
  dead.sort((a, b) => (tally.get(b.s.email) ?? 0) - (tally.get(a.s.email) ?? 0) || b.s.commits.length - a.s.commits.length);
  const shown = dead.slice(0, 9);

  let epitaphs = new Map();
  if (medium) {
    const stop = ui.spinner(['the stonemason is carving', 'choosing the words carefully', 'chiselling']);
    try {
      epitaphs = await writeEpitaphs({ ...medium, dead: shown.slice(0, 6).map((x) => x.s) });
    } finally {
      stop();
    }
  }

  const stones = shown.map(({ s }) => ({ name: s.name, years: years(s), lines: tally.get(s.email) ?? 0, epitaph: epitaphs.get(s.name) }));
  for (const row of tombstones(stones, { ui, columns: ui.width() })) {
    ui.line(row.split('\n').map((l) => `  ${l}`).join('\n'));
    ui.line();
  }
  if (dead.length > shown.length) ui.line(`  ${c.dim(`…and ${dead.length - shown.length} more beneath the grass.`)}`);
  if (sampled < total) ui.line(`  ${c.dim(`(line counts from ${sampled} of ${total} files; raise --max-files to dig deeper)`)}`);

  if (fading.length) {
    ui.line(`  ${c.bold('Fading')}  ${c.dim(fading.map(({ s, st }) => `${s.name} (${ago(st.days)})`).join(' · '))}`);
  }
  if (living.length) {
    const names = living.sort((a, b) => a.st.days - b.st.days).slice(0, 8).map(({ s, st }) => `${s.name} (${ago(st.days)})`);
    ui.line(`  ${c.moss('Among the living')}  ${c.dim(names.join(' · '))}${living.length > 8 ? c.dim(` +${living.length - 8}`) : ''}`);
  }
  ui.line();
  ui.line(`  ${c.dim('Summon one:')} git seance summon --author "${shown[0].s.name}"`);
  ui.line();
}
