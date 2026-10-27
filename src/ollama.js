// A small client for a local Ollama server: the open-weight medium the
// spirits speak through, and the embedding model that finds their memories.
export class SpiritBoardError extends Error {}

// Gemma 4 E2B on a laptop CPU reads prompts at ~30 tokens/s, so the context
// stays small and fixed. Changing num_ctx between calls forces a model reload.
export const MEDIUM_OPTIONS = { temperature: 0.6, top_p: 0.9, num_ctx: 8192, num_predict: 400 };

export function normalizeHost(host) {
  let h = (host || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  const url = new URL(h);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (!url.port && url.protocol === 'http:') url.port = '11434';
  return url.origin;
}

export class Ollama {
  constructor(host = process.env.OLLAMA_HOST) {
    this.base = normalizeHost(host);
    this.caps = new Map();
  }

  async #request(pathname, body, { signal } = {}) {
    let res;
    try {
      res = await fetch(this.base + pathname, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new SpiritBoardError(`the spirit board is silent: nothing answers at ${this.base}. Is Ollama running? (ollama serve)`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let why = text;
      try {
        why = JSON.parse(text).error ?? text;
      } catch {}
      throw new SpiritBoardError(`Ollama said ${res.status}: ${why}`);
    }
    return res;
  }

  async models() {
    const res = await this.#request('/api/tags');
    return (await res.json()).models.map((m) => m.name);
  }

  async capabilities(model) {
    if (!this.caps.has(model)) {
      const res = await this.#request('/api/show', { model });
      this.caps.set(model, (await res.json()).capabilities ?? []);
    }
    return this.caps.get(model);
  }

  // Loads the model into memory without generating anything.
  async load(model, options = MEDIUM_OPTIONS) {
    await (await this.#request('/api/generate', { model, keep_alive: '30m', options })).text();
  }

  async *chat({ model, messages, options = MEDIUM_OPTIONS, think, format, signal }) {
    const body = { model, messages, stream: true, options, keep_alive: '30m' };
    if (think !== undefined) body.think = think;
    if (format) body.format = format;
    const res = await this.#request('/api/chat', body, { signal });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new SpiritBoardError(msg.error);
        if (msg.message?.content) yield { content: msg.message.content };
        if (msg.done) yield { done: true, stats: msg };
      }
    }
  }

  async complete(args) {
    let text = '';
    for await (const ev of this.chat(args)) if (ev.content) text += ev.content;
    return text;
  }

  async embed(model, input) {
    const res = await this.#request('/api/embed', { model, input, keep_alive: '30m' });
    return (await res.json()).embeddings;
  }
}

const MEDIUMS = ['gemma4', 'gemma3n', 'gemma3', 'gemma'];
const LIBRARIANS = ['embeddinggemma', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm'];

const installedAs = (installed, name) =>
  installed.find((n) => n === name || n === `${name}:latest`) ?? null;

export async function chooseModels(ollama, { model, embedModel } = {}) {
  const installed = await ollama.models();
  const firstMatch = (prefixes) => {
    for (const p of prefixes) {
      const hit = installed.find((n) => n.startsWith(p));
      if (hit) return hit;
    }
    return null;
  };

  const askedMedium = model || process.env.SEANCE_MODEL;
  const medium = askedMedium ? installedAs(installed, askedMedium) : firstMatch(MEDIUMS);
  if (!medium) {
    throw new SpiritBoardError(askedMedium
      ? `${askedMedium} isn't installed. Pull it first: ollama pull ${askedMedium}`
      : 'no open-weight medium found. Pull one first: ollama pull gemma4:e2b  (or pass --model <any ollama model>)');
  }

  const askedLibrarian = embedModel || process.env.SEANCE_EMBED_MODEL;
  const librarian = askedLibrarian ? installedAs(installed, askedLibrarian) : firstMatch(LIBRARIANS);
  if (askedLibrarian && !librarian) {
    throw new SpiritBoardError(`${askedLibrarian} isn't installed. Pull it first: ollama pull ${askedLibrarian}`);
  }

  // Thinking models (Gemma 4 included) would spend the whole budget musing.
  const think = (await ollama.capabilities(medium)).includes('thinking') ? false : undefined;
  return { medium, librarian, think };
}
