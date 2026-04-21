# Dev.to / Medium article draft

**Title:** Building a personal AI agent in 22 MB of RAM — the architecture

**Tags:** `#ai`, `#macos`, `#typescript`, `#anthropic`, `#opensource`

**Cover image suggestion:** Screenshot of the dashboard's "22.9 MB idle" stat card with the NEXUS logo.

---

## TL;DR

I open-sourced NEXUS today — a personal AI agent that lives on your Mac, messages you on Telegram, and remembers every conversation across sessions. The entire daemon runs in **22.9 MB of RAM**. This post walks through three architectural decisions that made that possible: the four-layer memory system, tiered model routing, and LLM-driven memory import from other AI tools.

Repo: [github.com/blazelucastaco-ai/nexus](https://github.com/blazelucastaco-ai/nexus)
Site: [blazelucastaco-ai.github.io/nexus](https://blazelucastaco-ai.github.io/nexus/)

---

## The problem

Every AI tool I loved had the same gap. Close the browser tab, close the terminal, close Cursor — it forgot everything. Claude Code didn't remember the project I was working on yesterday. Cursor didn't know preferences I'd explained ten times. Custom GPTs reset between conversations.

The tools that *do* remember (ChatGPT's memory feature, some commercial agents) all route through cloud-stored session context. I wanted local, auditable, durable memory — something I could `cat`, `grep`, and own.

So: NEXUS. A long-running service on my Mac with a real memory system underneath, messaged via Telegram from any device.

## Decision 1: Four-layer memory in SQLite

Most AI apps treat "memory" as a single vector store or a scrollback of chat messages. That misses the point: different kinds of knowledge need different lifetimes and retrieval strategies.

NEXUS splits memory into four layers, all in a single SQLite database at `~/.nexus/memory.db`:

- **Episodic** — every conversation as it happened. Raw material.
- **Semantic** — extracted facts about the user, their projects, their preferences. This is what gets injected into future prompts.
- **Procedural** — rules and patterns (e.g., "user prefers concise replies", "always run tests after code changes").
- **Short-term / working** — a rolling window of the last ~50 messages, always in context.

The schema:

```sql
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  layer           TEXT NOT NULL CHECK(layer IN ('buffer','episodic','semantic','procedural')),
  type            TEXT NOT NULL CHECK(type IN ('conversation','task','fact','preference','workflow','contact','opinion','mistake','procedure')),
  content         TEXT NOT NULL,
  summary         TEXT,
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed   TEXT NOT NULL DEFAULT (datetime('now')),
  access_count    INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL DEFAULT 'system',
  metadata        TEXT NOT NULL DEFAULT '{}'
);
```

The key insight: **a nightly dream cycle** consolidates episodic entries into semantic facts. At 2 AM local time, NEXUS reads the day's episodes, clusters related ones, promotes the durable insights to semantic memory, and drops the noise. This mirrors how human sleep consolidates short-term memory into long-term.

Running dream cycles only at night means users don't get random "insight" Telegram messages during the workday — something I learned the hard way when the feature first shipped with a 6-hour `setInterval`.

## Decision 2: Tiered model routing

Using Opus for everything is expensive. Using Haiku for everything is dumb. The trick is routing each sub-task to the right model:

- **Claude Opus 4.7** — task planning, Ultra mode review, Code Dreams per-project meta-review. High-stakes, low-frequency.
- **Claude Sonnet 4.6** — chat, task execution, memory synthesis, vision. The workhorse.
- **Claude Haiku 4.5** — fast readiness checks, summaries, fallbacks. Cheap.

This matters for two reasons. First, cost: a full day of chat might burn $2 of Haiku + $0.50 of Sonnet + $0.20 of Opus, instead of $15 of Opus-only. Second, latency: Haiku replies in 1–2 seconds; Opus takes 5–15. Routing matches the model to the need.

One gotcha I hit: **Opus 4.7 deprecated the `temperature` parameter**. Sending it returns HTTP 400. Every task planning call was hard-failing with `temperature is deprecated for this model` until I added a per-model param strip:

```typescript
const NO_TEMPERATURE_MODELS = /^claude-opus-4-[7-9]|^claude-opus-[5-9]/;
const supportsTemperature = !NO_TEMPERATURE_MODELS.test(model);

const params = {
  model,
  max_tokens: maxTokens,
  ...(supportsTemperature ? { temperature } : {}),
  messages,
};
```

Worth flagging if you're building on Opus 4.7+.

## Decision 3: LLM-driven memory import

This is the weirdest feature and the one I'm most proud of.

When a new user installs NEXUS, they've probably already been using Claude Code, Codex, Gemini CLI, or Cursor. They have accumulated context in those tools — project notes, preferences, rules. That context is gold for a new NEXUS install.

The naive approach is to parse those files and map them directly into NEXUS's memory table. I built that first. It produces a lot of rows but loses the *synthesis*.

The better approach: **let the LLM read the raw content and write NEXUS's own memories in its own voice.**

Here's the prompt skeleton:

```
You are NEXUS — a personal AI agent that lives on a user's Mac.
You are about to import context from another AI assistant.
Your job: read the raw content and write YOUR OWN memories and skills
IN YOUR OWN VOICE. Do not copy verbatim. Synthesize. Distill patterns.
Write in first-person NEXUS voice.

Output EXACTLY this JSON shape:
{
  "memories": [...],
  "skills": [...]
}
```

On my own machine, **41 Claude Code markdown notes + 198 Codex command-allowlist rules → 26 distilled memories + 7 auto-generated skill files**. Examples of what the LLM produced:

- `"Telegram is NEXUS's only chat surface — never add in-app chat anywhere"` (extracted from my feedback notes)
- `"Lucas is a hands-on developer building NEXUS AI agent OS and related personal tools"` (synthesized from multiple user-type notes)
- Skill file `nexus-deploy.md` — a step-by-step procedure the LLM derived from observing my workflow

If the LLM call fails (no API key, network error, parse error), a deterministic fallback kicks in so users always get *something* imported. Graceful degradation, not magic requirement.

## Why 22 MB?

The whole daemon — orchestrator, four-layer memory system, personality engine, emotional state, multi-agent router, browser bridge, Telegram gateway — runs at **22.9 MB resident memory**. By comparison, a typical Electron app sits at 100–300 MB idle.

How? A few choices compound:

- **No Electron for the daemon.** Electron is the installer + dashboard UI. The actual running service is pure Node with 17 production dependencies.
- **SQLite via better-sqlite3.** No ORM, no connection pool, no heavy query builder. Direct prepared statements.
- **Lazy module loading.** Agents and tools only instantiate when invoked. The full set exists as capabilities registered with a kernel, not instantiated singletons.
- **No in-memory caches you don't need.** Memory retrieval hits SQLite every time; LRU caches are added only when profiling shows a specific hot path.

Nothing exotic. Just consistent no to every "we might need this later" abstraction.

## Honest about the state

v0.1.0. Private alpha. This past week alone I shipped fixes for:

- The Opus temperature bug above
- A classifier that misread compliments as tasks (NEXUS saw "this website is amazing bro" and tried to rebuild the site)
- A self-protection path guard that blocked legitimate access to `~/nexus-workspace/` because the path shares a prefix with the NEXUS source directory
- A `config.yaml`/`config.json` drift where personality changes silently no-op'd

Not production-ready for strangers yet. Private beta is the next step. But the core works and the distinctive ideas are measurable.

## Links

- Site + benchmarks: [blazelucastaco-ai.github.io/nexus](https://blazelucastaco-ai.github.io/nexus/)
- Repo (MIT): [github.com/blazelucastaco-ai/nexus](https://github.com/blazelucastaco-ai/nexus)
- Download the Mac installer: [latest DMG](https://github.com/blazelucastaco-ai/nexus/releases/latest)

If you've built something in this space and want to compare notes on memory design, hit me up.
