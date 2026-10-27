// Terminal presentation: colour, the candle spinner, word-wrapping a ghost's
// streamed words, and tombstones.
const ESC = '\x1b[';

export class Wrapper {
  constructor(write, { width = 80, prefix = '', indent = '  ', paint = (s) => s } = {}) {
    Object.assign(this, { write, width, prefix, indent, paint });
    this.col = 0;
    this.partial = '';
    this.pendingSpace = false;
    this.wrote = false;
    this.newlines = 0;
  }

  start() {
    this.write(this.prefix);
    this.col = this.indent.length;
  }

  // Holds back a trailing half-word until the next chunk shows where it ends.
  push(text) {
    let s = this.partial + text;
    const tail = /\S+$/.exec(s);
    this.partial = tail ? tail[0] : '';
    if (tail) s = s.slice(0, tail.index);
    this.#emit(s);
  }

  flush() {
    const rest = this.partial;
    this.partial = '';
    this.#emit(rest);
  }

  #emit(s) {
    for (const tok of s.split(/(\n|[ \t]+)/)) {
      if (!tok) continue;
      if (tok === '\n') {
        if (this.wrote && this.newlines < 2) {
          this.newlines++;
          this.#newline();
        }
        continue;
      }
      if (/^[ \t]+$/.test(tok)) {
        this.pendingSpace = this.col > this.indent.length;
        continue;
      }
      const word = tok.replace(/\*\*|__/g, '').replace(/^#+$/, '');
      if (!word) continue;
      if (this.col + word.length + (this.pendingSpace ? 1 : 0) > this.width && this.col > this.indent.length) {
        this.#newline();
      } else if (this.pendingSpace) {
        this.write(' ');
        this.col++;
      }
      this.pendingSpace = false;
      this.write(this.paint(word));
      this.col += word.length;
      this.wrote = true;
      this.newlines = 0;
    }
  }

  #newline() {
    this.write(`\n${this.indent}`);
    this.col = this.indent.length;
    this.pendingSpace = false;
  }
}

export function createUI({ plain = false, fx = true, out = process.stdout } = {}) {
  const tty = Boolean(out.isTTY);
  const color = !plain && tty && !process.env.NO_COLOR;
  const animate = fx && !plain && tty;
  const paint = (code) => (s) => (color ? `${ESC}${code}m${s}${ESC}0m` : String(s));
  const c = {
    ghost: paint('38;5;153'),
    candle: paint('38;5;214'),
    bone: paint('38;5;250'),
    moss: paint('38;5;108'),
    blood: paint('38;5;203'),
    dim: paint('2'),
    bold: paint('1'),
    italic: paint('3'),
  };
  // Emoji are two cells wide; `w` keeps the hanging indents lined up.
  const g = plain
    ? { candle: '*', ghost: '~', scroll: '#', warn: '!', grave: '+', you: '>', w: 1 }
    : { candle: '🕯', ghost: '👻', scroll: '📜', warn: '⚠', grave: '⚰', you: '›', w: 2 };

  const write = (s) => out.write(s);
  const line = (s = '') => out.write(`${s}\n`);
  const width = () => Math.max(40, Math.min((out.columns || 80) - 2, 86));
  const pause = (ms) => (animate ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  // A candle that burns while the medium reads; returns a function that snuffs it.
  function spinner(phrases, { hint = '' } = {}) {
    const started = Date.now();
    if (!animate) {
      line(c.dim(`  ${g.candle} ${phrases[0]}...`));
      return () => {};
    }
    let i = 0;
    const tick = () => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const phrase = phrases[Math.floor(secs / 6) % phrases.length];
      const dots = '.'.repeat(i++ % 4).padEnd(3);
      write(`\r${ESC}K  ${c.candle(g.candle)} ${c.dim(phrase + dots)} ${c.dim(`${secs}s`)}${hint ? c.dim(`  · ${hint}`) : ''}`);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => {
      clearInterval(timer);
      write(`\r${ESC}K`);
    };
  }

  function progress(label) {
    if (!animate) return { update() {}, done: (msg) => msg && line(c.dim(`  ${msg}`)) };
    return {
      update: (n, total) => write(`\r${ESC}K  ${c.dim(`${label} ${n}/${total}`)}`),
      done: (msg) => write(`\r${ESC}K${msg ? `  ${c.dim(msg)}\n` : ''}`),
    };
  }

  function ghostWriter() {
    const pad = 2 + g.w + 1;
    return new Wrapper(write, {
      width: width(),
      prefix: `\n  ${g.ghost} `,
      indent: ' '.repeat(pad),
      paint: c.ghost,
    });
  }

  return { c, g, write, line, width, pause, spinner, progress, ghostWriter, animate, color };
}

export function center(text, width) {
  const t = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  const left = Math.floor((width - t.length) / 2);
  return ' '.repeat(left) + t + ' '.repeat(width - t.length - left);
}

export function wrapWords(text, width) {
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const INNER = 17;

// Each stone: { name, years, lines?, epitaph? }. Returns printable rows.
export function tombstones(stones, { ui, columns = 80 }) {
  const { c } = ui;
  const rendered = stones.map((s) => {
    const body = [
      [' ', null],
      ['R . I . P', c.dim],
      [' ', null],
      [s.name, c.bold],
      [s.years, c.bone],
    ];
    if (s.lines != null) body.push([' ', null], [`${s.lines} line${s.lines === 1 ? '' : 's'}`, c.bone], ['still linger', c.dim]);
    if (s.epitaph) {
      body.push([' ', null]);
      for (const l of wrapWords(`"${s.epitaph}"`, INNER - 2).slice(0, 3)) body.push([l, c.ghost]);
    }
    return body;
  });
  const height = Math.max(...rendered.map((b) => b.length));
  const perRow = Math.max(1, Math.floor((columns + 3) / (INNER + 2 + 3)));
  const rows = [];
  for (let i = 0; i < rendered.length; i += perRow) {
    const group = rendered.slice(i, i + perRow);
    const lines = [];
    lines.push(group.map(() => c.bone(`  .${'-'.repeat(INNER - 4)}.  `)).join('   '));
    lines.push(group.map(() => c.bone(` /${' '.repeat(INNER - 2)}\\ `)).join('   '));
    for (let r = 0; r < height; r++) {
      lines.push(group.map((b) => {
        const [text, paint] = b[r] ?? [' ', null];
        const cell = center(text, INNER);
        return c.bone('|') + (paint ? paint(cell) : cell) + c.bone('|');
      }).join('   '));
    }
    lines.push(group.map(() => c.bone(`|${'_'.repeat(INNER)}|`)).join('   '));
    lines.push(group.map(() => c.moss('\\|/,'.repeat(5).slice(0, INNER + 2))).join('   '));
    rows.push(lines.join('\n'));
  }
  return rows;
}
