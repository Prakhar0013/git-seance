// Gathers what a ghost is allowed to remember: blame, line history, the
// comments they left, and the commits that answer a question. The medium
// sees this text and nothing else.
import {
  blameLines, lineHistory, showFile, commitPatch, loadCommit, seeThroughReverts, isUncommitted, shortSha,
} from './git.js';
import { spiritFromBlame, spiritStatus, ago, nightShare, topFiles, findSpirit } from './spirits.js';

export class SeanceError extends Error {}

// Roughly 1,300 tokens: about 40 seconds of reading for Gemma 4 E2B on a laptop CPU.
export const EVIDENCE_BUDGET = 4600;

const LEVELS = [
  { body: 600, patch: 10, commits: 5 },
  { body: 320, patch: 6, commits: 4 },
  { body: 180, patch: 3, commits: 3 },
];

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function commentText(line) {
  const t = line.trim();
  if (/^(\/\/|\/\*|\*\s|#\s|#$|--\s|<!--)/.test(t) && !t.startsWith('#!')) return t;
  return /\s(\/\/|#)\s+\S/.test(line) ? t : null;
}

export function renderCommit(c, { body = 600, patch = 10, files = false, note = '' } = {}) {
  const out = [`[${shortSha(c.sha)}] ${c.date.slice(0, 10)} ${c.name}: ${c.subject}${note ? ` (${note})` : ''}`];
  const text = (c.body ?? '').replace(/\b([0-9a-f]{40})\b/g, (m) => m.slice(0, 7)).replace(/\s+/g, ' ').trim();
  // Saying so outright keeps a small model from inventing the missing reason.
  if (!text) out.push('    (no explanation was written in this commit message)');
  else if (body > 0) out.push(`    ${clip(text, body)}`);
  if (files && c.files?.length) out.push(`    files: ${c.files.slice(0, 6).join(', ')}${c.files.length > 6 ? ', …' : ''}`);
  for (const l of (c.patch ?? []).slice(0, patch)) out.push(`    ${l}`);
  return out.join('\n');
}

function renderSpirit(spirit, status) {
  const n = spirit.commits.length;
  const when = status.kind === 'living'
    ? `Your last commit was ${ago(status.days)}: you are still alive and working here.`
    : `Your last commit was ${ago(status.days)}; you have ${status.kind === 'departed' ? 'departed this repository' : 'drifted away from this repository'}.`;
  const night = nightShare(spirit);
  const files = topFiles(spirit).map(([f, k]) => `${f} (${k})`).join(', ');
  return [
    `You are ${spirit.name} <${spirit.email}>. ${n} commit${n === 1 ? '' : 's'} here, from ${spirit.first.slice(0, 10)} to ${spirit.last.slice(0, 10)}. ${when}`,
    night >= 30 ? `${night}% of your commits landed between 22:00 and 05:00, your local time.` : null,
    files ? `Files you touched most: ${files}.` : null,
    `Your own commit messages, newest first: ${spirit.commits.slice(0, 6).map((c) => `"${clip(c.subject, 80)}"`).join(' · ')}.`,
  ].filter(Boolean).join('\n');
}

export function renderEvidence(ev, budget = EVIDENCE_BUDGET) {
  let text = '';
  for (const level of LEVELS) {
    text = ev.sections(level).filter((s) => s.body).map((s) => `== ${s.title} ==\n${s.body}`).join('\n\n');
    if (text.length <= budget) return text;
  }
  return `${text.slice(0, budget)}\n…`;
}

const byDateDesc = (a, b) => Date.parse(b.date) - Date.parse(a.date);

// summon file:line — the author of those lines, seen through any reverts.
export async function lineEvidence({ repo, spirits, file, start, end, opts }) {
  const blamed = await blameLines(repo, file, { start, end });
  if (!blamed.length) throw new SeanceError(`${file}:${start} is empty. No spirit dwells there.`);
  const msgCache = new Map();
  const resolved = [];
  for (const line of blamed) {
    resolved.push(isUncommitted(line) ? { line, hops: [] } : await seeThroughReverts(repo, line, { msgCache }));
  }

  const tally = new Map();
  for (const { line } of resolved) if (!isUncommitted(line)) tally.set(line.email, (tally.get(line.email) ?? 0) + 1);
  if (!tally.size) throw new SeanceError(`${file}:${start} has never been committed. No spirit dwells there yet.`);
  const email = [...tally].sort((a, b) => b[1] - a[1])[0][0];
  const mine = resolved.filter((r) => r.line.email === email);
  const spirit = spirits.get(email) ?? spiritFromBlame(mine[0].line);
  const status = spiritStatus(spirit, opts);
  const hops = resolved.flatMap((r) => r.hops);

  // Which commits to show: theirs for these lines, any revert dance, then the newest.
  const history = await lineHistory(repo, file, start, end);
  const must = new Set([...new Set(mine.map((r) => r.line.sha))].slice(0, 2));
  for (const h of hops) must.add(h.revertSha).add(h.revertedSha);
  for (const sha of must) {
    if (history.some((c) => c.sha === sha)) continue;
    const c = await loadCommit(repo, sha);
    if (c) history.push({ ...c, patch: await commitPatch(repo, sha, file) });
  }
  const notes = new Map();
  for (const h of hops) {
    notes.set(h.revertSha, `reverted [${shortSha(h.revertedSha)}]`);
    notes.set(h.revertedSha, `later undone by [${shortSha(h.revertSha)}]`);
  }

  const source = (await showFile(repo, 'HEAD', file)) ?? '';
  const all = source.split('\n');
  const whole = await blameLines(repo, file);
  const owned = whole.filter((l) => l.email === email).length;
  const comments = whole
    .filter((l) => l.email === email && (l.line < start || l.line > end) && commentText(l.content))
    .sort((a, b) => Math.abs(a.line - start) - Math.abs(b.line - start))
    .slice(0, 5)
    .sort((a, b) => a.line - b.line)
    .map((l) => `line ${l.line}: ${clip(l.content.trim(), 140)}`);

  const origin = history.find((c) => c.sha === mine[0].line.sha) ?? null;
  const others = [...tally].filter(([e]) => e !== email).map(([e]) => spirits.get(e)?.name ?? e);
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
  const ownership = others.length
    ? `${mine.length} of these ${resolved.length} lines are yours; the rest belong to ${others.join(', ')}.`
    : `${resolved.length === 1 ? 'This line is' : 'These lines are'} yours.`;
  // Spelled out as numbered steps: "undid that change" alone confuses a small model about who did what.
  const revertNote = hops.map((h) => {
    const undone = history.find((c) => c.sha === h.revertedSha);
    return [
      'What happened to your line after you wrote it:',
      `1. In [${shortSha(h.revertedSha)}]${undone ? `, ${undone.name} replaced it ("${undone.subject}")` : ' it was replaced'}.`,
      `2. In [${shortSha(h.revertSha)}], ${h.revertAuthor} reverted [${shortSha(h.revertedSha)}] and restored your original line.`,
      'So today the line is exactly as you wrote it.',
    ].join('\n');
  });

  const known = new Map(history.map((c) => [c.sha, c]));
  return {
    kind: 'line',
    spirit,
    status,
    hops,
    origin,
    target: { file, start, end },
    owned,
    known,
    exampleSha: origin?.sha ?? mine[0].line.sha,
    sections: (lv) => {
      const picked = history.filter((c) => must.has(c.sha));
      for (const c of history) {
        if (picked.length >= lv.commits) break;
        if (!picked.includes(c)) picked.push(c);
      }
      picked.sort(byDateDesc);
      const ctx = [];
      for (let n = Math.max(1, start - 6); n <= Math.min(all.length, end + 6); n++) {
        ctx.push(`${n >= start && n <= end ? '>' : ' '} ${String(n).padStart(4)} | ${clip(all[n - 1] ?? '', 140)}`);
      }
      return [
        { title: 'Who you were', body: renderSpirit(spirit, status) },
        { title: `The code you were summoned for: ${file}, ${range} (marked >)`, body: [ownership, ...revertNote, ctx.join('\n')].join('\n') },
        { title: 'Every change to these lines, newest first', body: picked.map((c) => renderCommit(c, { body: lv.body, patch: lv.patch, note: notes.get(c.sha) })).join('\n') },
        { title: `Comments you left elsewhere in ${file}`, body: comments.join('\n') },
      ];
    },
  };
}

// summon file — whoever owns most of the file now.
export async function fileEvidence({ repo, spirits, file, opts }) {
  const whole = await blameLines(repo, file);
  const tally = new Map();
  for (const l of whole) if (!isUncommitted(l)) tally.set(l.email, (tally.get(l.email) ?? 0) + 1);
  if (!tally.size) throw new SeanceError(`${file} has never been committed. No spirit dwells there yet.`);
  const [email, owned] = [...tally].sort((a, b) => b[1] - a[1])[0];
  const spirit = spirits.get(email) ?? spiritFromBlame(whole.find((l) => l.email === email));
  const status = spiritStatus(spirit, opts);

  const touched = spirit.commits.filter((c) => c.files.includes(file)).slice(0, 5);
  const history = [];
  for (const c of touched) history.push({ ...c, patch: await commitPatch(repo, c.sha, file) });
  const comments = whole
    .filter((l) => l.email === email && commentText(l.content))
    .slice(0, 6)
    .map((l) => `line ${l.line}: ${clip(l.content.trim(), 140)}`);

  return {
    kind: 'file',
    spirit,
    status,
    target: { file },
    owned,
    totalLines: whole.length,
    known: new Map(history.map((c) => [c.sha, c])),
    exampleSha: history[0]?.sha ?? spirit.commits[0].sha,
    sections: (lv) => [
      { title: 'Who you were', body: renderSpirit(spirit, status) },
      { title: `The file you were summoned for: ${file}`, body: `You still own ${owned} of its ${whole.length} lines.` },
      { title: `Your changes to ${file}, newest first`, body: history.slice(0, lv.commits).map((c) => renderCommit(c, { body: lv.body, patch: lv.patch })).join('\n') },
      { title: `Comments you left in ${file}`, body: comments.join('\n') },
    ],
  };
}

// summon --author — the commits where they explained themselves best.
export async function authorEvidence({ repo, spirits, who, opts }) {
  const { spirit, others } = findSpirit(spirits, who);
  if (!spirit) throw new SeanceError(`no spirit named "${who}" has ever committed here. Try: git seance graveyard`);
  const status = spiritStatus(spirit, opts);
  const telling = [...spirit.commits].sort((a, b) => b.body.length - a.body.length || byDateDesc(a, b)).slice(0, 5);
  const history = [];
  for (const [i, c] of telling.entries()) history.push(i < 2 ? { ...c, patch: await commitPatch(repo, c.sha) } : c);
  history.sort(byDateDesc);
  return {
    kind: 'author',
    spirit,
    status,
    others,
    known: new Map(history.map((c) => [c.sha, c])),
    exampleSha: history[0].sha,
    sections: (lv) => [
      { title: 'Who you were', body: renderSpirit(spirit, status) },
      { title: 'Commits where you explained yourself', body: history.slice(0, lv.commits).map((c) => renderCommit(c, { body: lv.body, patch: lv.patch, files: true })).join('\n') },
    ],
  };
}

// ask — whoever's memories best answer the question steps forward.
export async function questionEvidence({ repo, spirits, ranked, opts }) {
  const top = ranked.slice(0, 8);
  // Only the margin above the weakest of the top eight counts, so one sharp
  // match outweighs a crowd of vaguely related commits.
  const floor = top.at(-1).s;
  const weight = new Map();
  top.forEach((r, i) => weight.set(r.c.email, (weight.get(r.c.email) ?? 0) + (r.s - floor + 1e-3) / (1 + i * 0.25)));
  const email = [...weight].sort((a, b) => b[1] - a[1])[0][0];
  const spirit = spirits.get(email);
  const status = spiritStatus(spirit, opts);
  const memories = [];
  for (const [i, r] of top.slice(0, 5).entries()) memories.push(i < 2 ? { ...r.c, patch: await commitPatch(repo, r.c.sha) } : r.c);
  return {
    kind: 'question',
    spirit,
    status,
    closest: top.find((r) => r.c.email === email).c,
    known: new Map(memories.map((c) => [c.sha, c])),
    exampleSha: memories.find((c) => c.email === email)?.sha ?? memories[0].sha,
    sections: (lv) => [
      { title: 'Who you were', body: renderSpirit(spirit, status) },
      {
        title: 'Memories from this repository that touch the question, most relevant first (not all are yours)',
        body: memories.slice(0, lv.commits + 1).map((c) => renderCommit(c, { body: lv.body, patch: lv.patch, files: true })).join('\n'),
      },
    ],
  };
}
