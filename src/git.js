// Everything git séance knows about the past comes through here: plain `git`
// subprocesses and small parsers for their output. Nothing leaves the machine.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {}

const ZERO_SHA = /^0{40}$/;
const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/;

// %x1e / %x1f / %x1d are record, field and group separators, so commit bodies
// can contain anything except those three bytes.
export const COMMIT_FORMAT = '%x1e%H%x1f%aN%x1f%aE%x1f%aI%x1f%s%x1f%b%x1d';

export function git(cwd, args, { allowFail = false, timeout = 0, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, maxBuffer, timeout, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          if (allowFail) return resolve(null);
          const why = (stderr || err.message).trim().split('\n')[0];
          return reject(new GitError(`git ${args[0]} failed: ${why}`));
        }
        resolve(stdout.replace(/\r\n/g, '\n'));
      },
    );
  });
}

export async function openRepo(cwd) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true }))?.trim();
  if (!root) throw new GitError(`no git repository at ${cwd}. The dead only haunt repositories.`);
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }))?.trim();
  if (!head) throw new GitError('this repository has no commits yet. Nobody has died here.');
  const ignoreRevs = path.join(root, '.git-blame-ignore-revs');
  return { root, gitDir, head, name: path.basename(root), ignoreRevs: fs.existsSync(ignoreRevs) ? ignoreRevs : null };
}

export const shortSha = (sha) => sha.slice(0, 7);

export function parseCommitLog(out) {
  const commits = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const end = chunk.indexOf('\x1d');
    const header = end >= 0 ? chunk.slice(0, end) : chunk;
    const rest = end >= 0 ? chunk.slice(end + 1) : '';
    const [sha, name, email, date, subject, body = ''] = header.split('\x1f');
    commits.push({ sha, name, email: email.toLowerCase(), date, subject, body: body.trim(), rest });
  }
  return commits;
}

const withFiles = ({ rest, ...c }) => ({ ...c, files: rest.split('\n').map((f) => f.trim()).filter(Boolean) });

// Newest first, merges skipped: one record per commit with the files it touched.
export async function loadHistory(repo, { max = 5000 } = {}) {
  const out = await git(repo.root, ['log', '--no-merges', `--max-count=${max}`, `--format=${COMMIT_FORMAT}`, '--name-only', 'HEAD']);
  return parseCommitLog(out).map(withFiles);
}

export async function loadCommit(repo, sha) {
  const out = await git(repo.root, ['log', '-1', `--format=${COMMIT_FORMAT}`, '--name-only', sha], { allowFail: true });
  const [entry] = out ? parseCommitLog(out) : [];
  return entry ? withFiles(entry) : null;
}

export function parseBlamePorcelain(out) {
  const lines = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    if (cur === null) {
      const m = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(raw);
      if (m) cur = { sha: m[1], origLine: Number(m[2]), line: Number(m[3]) };
      continue;
    }
    if (raw.startsWith('\t')) {
      cur.content = raw.slice(1).replace(/\r$/, '');
      lines.push(cur);
      cur = null;
      continue;
    }
    const sp = raw.indexOf(' ');
    const key = sp < 0 ? raw : raw.slice(0, sp);
    const val = sp < 0 ? '' : raw.slice(sp + 1);
    if (key === 'author') cur.name = val;
    else if (key === 'author-mail') cur.email = val.replace(/^<|>$/g, '').toLowerCase();
    else if (key === 'author-time') cur.time = Number(val);
    else if (key === 'summary') cur.summary = val;
    else if (key === 'filename') cur.filename = val;
    else if (key === 'boundary') cur.boundary = true;
  }
  return lines;
}

export const isUncommitted = (line) => ZERO_SHA.test(line.sha);

export async function blameLines(repo, file, { start, end, rev = 'HEAD' } = {}) {
  const args = ['blame', '--line-porcelain', '-w', '-M'];
  if (repo.ignoreRevs) args.push('--ignore-revs-file', repo.ignoreRevs);
  if (start) args.push('-L', `${start},${end ?? start}`);
  args.push(rev, '--', file);
  return parseBlamePorcelain(await git(repo.root, args));
}

// `git blame --incremental` is the cheapest way to count surviving lines per
// author across a whole tree. Headers only appear the first time a commit does.
export function tallyBlameIncremental(out, tally = new Map()) {
  const emails = new Map();
  let cur = null;
  for (const l of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ \d+ (\d+)$/.exec(l);
    if (m) {
      cur = { sha: m[1], n: Number(m[2]) };
    } else if (cur && l.startsWith('author-mail ')) {
      emails.set(cur.sha, l.slice(12).replace(/^<|>$/g, '').toLowerCase());
    } else if (cur && l.startsWith('filename ')) {
      const email = emails.get(cur.sha);
      if (email && !ZERO_SHA.test(cur.sha)) tally.set(email, (tally.get(email) ?? 0) + cur.n);
      cur = null;
    }
  }
  return tally;
}

export async function showFile(repo, rev, file) {
  return git(repo.root, ['show', `${rev}:${file}`], { allowFail: true });
}

export function nearestExactLine(lines, content, hint) {
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') !== content) continue;
    if (best < 0 || Math.abs(i + 1 - hint) < Math.abs(best + 1 - hint)) best = i;
  }
  return best;
}

// If a line was last touched by a revert, the words belong to whoever wrote
// them before the reverted change. Follow reverts back (a few hops at most).
export async function seeThroughReverts(repo, line, { msgCache = new Map(), maxHops = 3 } = {}) {
  const hops = [];
  let cur = line;
  for (let i = 0; i < maxHops; i++) {
    if (!msgCache.has(cur.sha)) msgCache.set(cur.sha, await git(repo.root, ['log', '-1', '--format=%B', cur.sha]));
    const m = REVERT_RE.exec(msgCache.get(cur.sha));
    if (!m) break;
    const before = `${m[1]}^`;
    const text = await showFile(repo, before, cur.filename);
    if (text == null) break;
    const idx = nearestExactLine(text.split('\n'), cur.content, cur.origLine);
    if (idx < 0) break;
    const [prev] = await blameLines(repo, cur.filename, { start: idx + 1, rev: before });
    if (!prev || prev.sha === cur.sha) break;
    const revertedSha = (await git(repo.root, ['rev-parse', m[1]])).trim();
    hops.push({ revertSha: cur.sha, revertAuthor: cur.name, revertedSha });
    cur = { ...prev, line: line.line };
  }
  return { line: cur, hops };
}

export function trimPatch(patch, { maxLines = 12, width = 140 } = {}) {
  const out = [];
  for (const l of patch.split('\n')) {
    if (/^(\+\+\+|---) /.test(l) || !/^[+-]/.test(l)) continue;
    if (out.length >= maxLines) {
      out.push('…');
      break;
    }
    out.push(l.length > width ? `${l.slice(0, width)}…` : l);
  }
  return out;
}

// Every commit that touched lines start..end of file, newest first, with the
// slice of the diff that touched them.
export async function lineHistory(repo, file, start, end, { max = 25 } = {}) {
  const out = await git(repo.root, ['log', `-L${start},${end}:${file}`, `--max-count=${max}`, `--format=${COMMIT_FORMAT}`, 'HEAD'], { allowFail: true });
  if (!out) return [];
  return parseCommitLog(out).map(({ rest, ...c }) => ({ ...c, patch: trimPatch(rest) }));
}

const NOISE = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '*.lock', 'go.sum', '*.min.js', '*.min.css', '*.map'];

export async function commitPatch(repo, sha, file) {
  const spec = file ? [file] : ['.', ...NOISE.map((p) => `:(exclude,glob)**/${p}`)];
  const out = await git(repo.root, ['show', '--format=', '-U0', sha, '--', ...spec], { allowFail: true });
  return out ? trimPatch(out) : [];
}

export async function pickaxe(repo, term, { max = 6 } = {}) {
  const out = await git(repo.root, ['log', '--no-merges', `-S${term}`, `--max-count=${max}`, '--format=%H', 'HEAD'], { allowFail: true, timeout: 30_000 });
  return out ? out.split('\n').filter(Boolean) : [];
}

export async function resolveCommit(repo, ref) {
  const sha = (await git(repo.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }))?.trim();
  return sha ? loadCommit(repo, sha) : null;
}

export async function textFiles(repo) {
  const out = await git(repo.root, ['grep', '-I', '--name-only', '-e', '.', 'HEAD'], { allowFail: true });
  return out ? out.split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, '')) : [];
}

export async function isDirty(repo, file) {
  const out = await git(repo.root, ['status', '--porcelain', '--', file], { allowFail: true });
  return Boolean(out?.trim());
}
