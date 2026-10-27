// Turns commit history into spirits: one per author, carrying only what the
// record shows about them (when they worked, what they touched, how they wrote).
const DAY = 86_400_000;

export function gatherSpirits(commits) {
  const spirits = new Map();
  for (const c of commits) {
    let s = spirits.get(c.email);
    if (!s) {
      s = { email: c.email, name: c.name, firstName: c.name.split(/\s+/)[0], commits: [], files: new Map(), night: 0 };
      spirits.set(c.email, s);
    }
    s.commits.push(c);
    // %aI keeps the author's own UTC offset, so this is their wall-clock hour.
    const hour = Number(c.date.slice(11, 13));
    if (hour >= 22 || hour < 5) s.night++;
    for (const f of c.files ?? []) s.files.set(f, (s.files.get(f) ?? 0) + 1);
  }
  for (const s of spirits.values()) {
    s.first = s.last = s.commits[0].date;
    for (const c of s.commits) {
      if (Date.parse(c.date) < Date.parse(s.first)) s.first = c.date;
      if (Date.parse(c.date) > Date.parse(s.last)) s.last = c.date;
    }
  }
  return spirits;
}

// For an author we only know from a single blamed line (older than the loaded history).
export function spiritFromBlame(line) {
  const date = new Date(line.time * 1000).toISOString();
  const commit = { sha: line.sha, name: line.name, email: line.email, date, subject: line.summary ?? '', body: '', files: [] };
  return { email: line.email, name: line.name, firstName: line.name.split(/\s+/)[0], commits: [commit], files: new Map(), night: 0, first: date, last: date };
}

export function spiritStatus(spirit, { now = Date.now(), departedAfterDays = 365 } = {}) {
  const days = Math.max(0, Math.floor((now - Date.parse(spirit.last)) / DAY));
  const kind = days < Math.min(90, departedAfterDays) ? 'living' : days < departedAfterDays ? 'fading' : 'departed';
  return { kind, days };
}

export function ago(days) {
  if (days < 1) return 'today';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function nightShare(spirit) {
  return spirit.commits.length ? Math.round((spirit.night / spirit.commits.length) * 100) : 0;
}

export function topFiles(spirit, n = 3) {
  return [...spirit.files].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function years(spirit) {
  const a = spirit.first.slice(0, 4);
  const b = spirit.last.slice(0, 4);
  return a === b ? a : `${a}–${b}`;
}

export function findSpirit(spirits, query) {
  const q = query.toLowerCase().trim();
  const all = [...spirits.values()];
  const exact = all.filter((s) => s.email === q || s.name.toLowerCase() === q);
  const pool = exact.length ? exact : all.filter((s) => s.email.includes(q) || s.name.toLowerCase().includes(q));
  pool.sort((a, b) => b.commits.length - a.commits.length);
  return { spirit: pool[0] ?? null, others: pool.slice(1) };
}
