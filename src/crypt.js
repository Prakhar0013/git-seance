// The crypt: commit embeddings kept inside .git/seance, plus the divination
// that ranks commits against a question. Vectors never leave the repository.
import fs from 'node:fs';
import path from 'node:path';

const STOPWORDS = new Set(
  'the and for are was were why what who how does did this that these those with from into our your their its it\'s you we they them there here when then than have has had not but can could should would will just like about some any all ever still been being only also very much more most such'.split(' '),
);

export function keywords(text) {
  const words = text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

// Terms worth an exact `git log -S` search: quoted strings, numbers, identifiers.
export function pickaxeTerms(question) {
  const terms = new Set();
  for (const m of question.matchAll(/`([^`]{2,60})`|"([^"]{2,60})"/g)) terms.add(m[1] ?? m[2]);
  for (const m of question.matchAll(/(?<![\w.])(\d{3,})(?!\d)|\b([A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}-\d+)\b/g)) {
    terms.add(m[1] ?? m[2]);
  }
  return [...terms].slice(0, 3);
}

function prefixes(model) {
  if (/embeddinggemma/.test(model)) return { doc: 'title: none | text: ', query: 'task: search result | query: ' };
  if (/nomic/.test(model)) return { doc: 'search_document: ', query: 'search_query: ' };
  if (/mxbai/.test(model)) return { doc: '', query: 'Represent this sentence for searching relevant passages: ' };
  return { doc: '', query: '' };
}

const docText = (c) => `${c.subject}\n${c.body.slice(0, 600)}\nfiles: ${(c.files ?? []).slice(0, 12).join(', ')}`;

function normalize(v) {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class Crypt {
  constructor(gitDir, model) {
    const slug = model.replace(/[^a-z0-9._-]+/gi, '_');
    this.dir = path.join(gitDir, 'seance');
    this.meta = path.join(this.dir, `crypt-${slug}.json`);
    this.bin = path.join(this.dir, `crypt-${slug}.f32`);
    this.model = model;
  }

  load() {
    const vec = new Map();
    try {
      const { shas, dims } = JSON.parse(fs.readFileSync(this.meta, 'utf8'));
      const buf = fs.readFileSync(this.bin);
      if (buf.byteLength !== shas.length * dims * 4) return vec;
      const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      shas.forEach((sha, i) => vec.set(sha, all.subarray(i * dims, (i + 1) * dims)));
    } catch {}
    return vec;
  }

  save(vec) {
    const shas = [...vec.keys()];
    const dims = shas.length ? vec.get(shas[0]).length : 0;
    const all = new Float32Array(shas.length * dims);
    shas.forEach((sha, i) => all.set(vec.get(sha), i * dims));
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.bin, Buffer.from(all.buffer));
    fs.writeFileSync(this.meta, JSON.stringify({ version: 1, model: this.model, dims, shas }));
  }
}

// Embeds any commits the crypt hasn't seen yet. Returns null without a librarian.
export async function ensureIndex({ repo, ollama, librarian, commits, onProgress = () => {} }) {
  if (!librarian) return null;
  const crypt = new Crypt(repo.gitDir, librarian);
  const vec = crypt.load();
  const missing = commits.filter((c) => !vec.has(c.sha));
  const { doc } = prefixes(librarian);
  for (let i = 0; i < missing.length; i += 24) {
    const batch = missing.slice(i, i + 24);
    const vectors = await ollama.embed(librarian, batch.map((c) => doc + docText(c)));
    batch.forEach((c, j) => vec.set(c.sha, normalize(vectors[j])));
    onProgress(Math.min(i + 24, missing.length), missing.length);
  }
  if (missing.length) crypt.save(vec);
  return { model: librarian, vec, added: missing.length };
}

// Ranks commits for a question: cosine similarity when the crypt is open,
// keyword overlap always, and a strong boost for exact pickaxe hits.
export async function divine({ question, pool, index = null, ollama = null, boost = new Set() }) {
  const terms = keywords(question);
  let q = null;
  if (index && ollama) {
    const [v] = await ollama.embed(index.model, [prefixes(index.model).query + question]);
    q = normalize(v);
  }
  const ranked = [];
  for (const c of pool) {
    let s = 0;
    const v = q && index.vec.get(c.sha);
    if (v) s += dot(q, v);
    const hay = `${c.subject}\n${c.body}\n${(c.files ?? []).join(' ')}`.toLowerCase();
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits++;
    s += Math.min(hits, 4) * (q ? 0.04 : 0.25);
    if (boost.has(c.sha)) s += 0.5;
    if (s > 0) ranked.push({ c, s });
  }
  return ranked.sort((a, b) => b.s - a.s);
}
