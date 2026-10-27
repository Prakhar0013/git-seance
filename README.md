# git séance 🕯

**Summon the ghost of whoever wrote that line, and ask them why.**

Every codebase has a comment like `// don't touch. ask ezra.` and Ezra left years ago.
`git séance` reads the history Ezra left behind (blame, diffs, commit messages, the comments
they wrote) and lets you ask them, through an open-weight model running on your own machine.

```text
$ git seance src/settlement.js:6 -q "Why is MAX_ATTEMPTS 7? Dana wants to lower it again."

  👻 The spirit of Marisol Vega answers.
     7 commits · 2017–2019 · departed 7 years ago · a night owl: 86% after dark
     wrote src/settlement.js:6 on 2018-03-11: "fix: keep one more retry than FirstPacific's breaker"
     seen through a revert: Dana Kim restored these words in 4d194b5

  👻 The cold always settles deep into the bones when you ask about old
     decisions. I set it to 7 because FirstPacific's gateway trips its circuit
     breaker after six consecutive failures during the 02:00 batch window, and
     you needed one clean attempt to find it half-open again. Measured over
     nine nights, zero settlements were abandoned [16d6516]. Dana Kim later
     undid that change, lowering it to 3 [d18b0da] …

  📜 16d6516 2018-03-11 · Marisol Vega · fix: keep one more retry than FirstPacific's breaker
  📜 d18b0da 2024-02-06 · Dana Kim · perf: lower MAX_ATTEMPTS to 3
  gemma4:e2b-it-qat · on this machine · 1203 tokens of memory in 27.1s · spoke 121 at 9.3 tok/s
```

Nothing leaves your machine. There is no API key, and once the models are pulled no network connection is needed.

## Install

You need [Node.js](https://nodejs.org) 20+, git, and [Ollama](https://ollama.com).

```bash
ollama pull gemma4:e2b          # the medium: who the spirits speak through
ollama pull nomic-embed-text    # the librarian: finds memories for `ask` (embeddinggemma is supported too)

git clone https://github.com/<you>/git-seance
cd git-seance && npm link       # puts `git-seance` on your PATH, so `git seance` just works
```

There are no npm dependencies. It's plain Node, `git`, and `fetch` to `localhost:11434`.

## Use

```bash
git seance summon src/settlement.js:6          # talk to whoever wrote line 6
git seance src/settlement.js:40-52             # "summon" is the default; ranges and #L40-L52 work too
git seance summon src/ledger.js                # whoever owns most of the file today
git seance summon --author "Ezra"              # call a spirit by name
git seance ask "why do we sleep 1300ms before every call?"   # whoever remembers best steps forward
git seance graveyard --epitaphs                # the authors who left, and what of theirs still runs
```

Useful flags: `-q "<question>"` asks once and leaves; `-i` keeps an `ask` séance open;
`--show-evidence` prints exactly what the model is shown; `-m <model>` swaps the medium for any
Ollama model; `--plain` drops colour and emoji. Run `git seance --help` for the rest.

### Try it on a haunted repository

`hollow-creek-ledger` is a small, entirely fictional payments service with nine years of history,
four developers, a revert, an unexplained hotfix, and a comment that says `ask ezra`:

```bash
node scripts/make-haunted-repo.js ~/hollow-creek-ledger
cd ~/hollow-creek-ledger
git seance graveyard --epitaphs
git seance src/gateway.js:8 -q "The comment just says ask ezra. So: why 1300?"
git seance src/settlement.js:9 -q "Why do we skip merchant HC-0013?"   # nobody ever wrote that one down
```

## How it works

```text
 file:line ─► git blame -w -M ─► see through reverts ─► the spirit (author)
                                                          │
   git log -L (every change to those lines + diffs) ──────┤
   comments they left in the file ────────────────────────┤
   their habits: dates, hours, files, commit voice ───────┤
   ask: embeddings + git log -S pickaxe + keywords ───────┘
                                                          ▼
                                 evidence (≤ 4,600 chars) ─► Gemma 4 via Ollama ─► streamed answer
                                                                                       │
                                     every [hash] it cites is checked against git ◄────┘
```

* **Seeing through reverts.** If a line was last touched by `Revert "…"`, blame would credit
  whoever reverted. git séance re-blames the line as it stood before the reverted commit, so it
  summons the person who actually wrote the words, and tells them what happened to them since.
* **The dead cannot lie.** The model only sees evidence pulled from git, and every commit hash it
  cites is verified afterwards: 📜 for evidence, a dim note for real commits outside the evidence,
  and a red ⚠ for a *phantom* hash that doesn't exist. Commits with an empty message body are
  marked "(no explanation was written)", so the ghost admits a lost memory instead of inventing one.
* **Living spirits.** If the author committed in the last 90 days, the ghost is told it isn't
  dead and may suggest you just ask in person.

## Built for an 8 GB laptop

Development happened on a CPU-only laptop (Intel UHD graphics, 7.7 GB RAM) running
`gemma4:e2b-it-qat`. Measured there:

| | |
|---|---|
| Generation | ~9–10 tokens/s |
| Prompt reading | ~30–40 tokens/s, so a 4,000-token prompt takes about 2 minutes |
| First answer, evidence of ~800–1,200 tokens | 20–60 s, mostly spent reading |
| Answer once evidence is cached | first words in ~3 s (prompt time 0.5 s instead of ~30 s) |

That shaped the design:

* **A hard evidence budget.** About 1,300 tokens, trimmed in three passes (shorter bodies,
  fewer diff lines, fewer commits) before anything is cut.
* **Warm while you type.** When an interactive séance opens, git séance sends the evidence to
  Ollama with `num_predict: 1`. Ollama keeps the prefix in its KV cache, so your actual question
  only costs its own few tokens.
* **One model in memory.** With `OLLAMA_MAX_LOADED_MODELS=1`, swapping between the embedder and
  Gemma costs ~20 s each way, so `ask` embeds first and then loads Gemma once. Follow-up questions
  use keyword retrieval rather than the embedder.
* **Thinking off.** Gemma 4 can reason before answering; on a CPU that's the whole budget, so it
  is disabled when the model supports it.

## Privacy

Everything runs locally: git subprocesses, Ollama on `127.0.0.1`, and an embedding index stored in
`.git/seance/` (inside `.git`, so it's never committed). Point `--host` / `OLLAMA_HOST` at another
machine only if you're comfortable sending your history there.

## A note on summoning people

The ghost is a reconstruction from what someone wrote down, not the person. It can only repeat
their commit messages and comments back to you in a spooky voice. Be kind to it, and if the
spirit is still among the living, ask them instead.

## Tests

```bash
npm test
```

There are 23 tests: parsers, plus integration tests that build the haunted repository and check
blame, revert-seeing, evidence, retrieval and citation checks. No model is needed.

## License

MIT
