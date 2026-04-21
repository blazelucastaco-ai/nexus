# Reddit drafts — per subreddit

Each subreddit has a distinct tone. Copy/paste and adjust. Post at local peak hours (usually 8-10am ET for US-heavy subs).

---

## r/LocalLLaMA

Tone: technical, skeptical, respect earned through numbers.

**Title:** Built an open-source personal AI agent in 22 MB of RAM — four-layer memory, nightly consolidation, Claude-powered

**Body:**

Spent a few months on this and shipped v0.1.0 today. NEXUS is a personal AI agent for Mac that runs as a service, remembers everything across sessions, and is messaged via Telegram.

**Why it might interest r/LocalLLaMA:**

- Full transparency on architecture — repo is MIT at [github.com/blazelucastaco-ai/nexus](https://github.com/blazelucastaco-ai/nexus), 847 tests passing
- **22.9 MB RSS at idle** — the entire daemon (orchestrator, 4-layer memory, personality engine, agents, browser bridge). Comparable Electron tools sit at 100–300 MB
- Four-layer memory in SQLite: episodic / semantic / procedural / short-term working
- Nightly dream cycle (2–5am local) that consolidates episodic into semantic, drops noise, generates reflections
- Tiered model routing: Opus 4.7 planning, Sonnet 4.6 execution, Haiku 4.5 fast checks
- Benchmark battery: 25/25 on hard prompts (multi-step math, adversarial facts, executable code, LLM-judged quality)

Not local models — this runs on Anthropic's API. But the agent infrastructure around it is all local (SQLite, filesystem), and the architecture is swappable if someone wants to wire in Ollama/LM Studio.

The distinctive bit: **LLM-driven memory import**. On install it detects Claude Code, Codex, Gemini CLI, Cursor on your machine, hands the raw content to Sonnet, and the LLM writes NEXUS's own memories and skills in first-person voice. Not a mechanical copy — a real synthesis. 41 Claude Code notes + 198 Codex rules → 26 distilled memories + 7 auto-generated skill files on my own machine.

Happy to take questions on the memory design or the trade-offs.

**Caveats**: macOS only, requires Anthropic API key, private alpha.

---

## r/SideProject

Tone: personal, honest, story-driven.

**Title:** Spent 3 months building my own personal AI agent because every existing tool forgets everything

**Body:**

Every AI tool I used had the same gap: it forgot everything the moment I closed the tab. Claude Code didn't remember what we'd worked on yesterday. Cursor didn't know preferences I'd explained ten times. Custom GPTs reset between chats.

So I built NEXUS. It runs as a service on my Mac, has a real memory system (four layers in SQLite), consolidates context during a nightly dream cycle between 2 and 5 AM, and talks to me on Telegram from wherever I am.

I message it from my phone on the subway. It remembers the project I was working on last week. It has a personality that drifts as we interact — it literally gets warmer the more we talk.

Full source: [github.com/blazelucastaco-ai/nexus](https://github.com/blazelucastaco-ai/nexus)

Site: [blazelucastaco-ai.github.io/nexus](https://blazelucastaco-ai.github.io/nexus/)

Totally honest — this week alone I found half a dozen real bugs. v0.1.0. Private alpha. But the core works and is the most satisfying thing I've built.

MIT licensed, macOS only for now.

---

## r/MacApps

Tone: Mac-focused, design-conscious, user-facing.

**Title:** NEXUS — an open-source personal AI agent for Mac (Telegram-first, 22 MB idle, MIT)

**Body:**

Just shipped v0.1.0 of NEXUS — a personal AI agent that lives as a service on your Mac and talks to you on Telegram.

**What makes it Mac-native:**

- Native installer app with a wizard (not a terminal script)
- macOS menu bar companion that shows daemon status + lets you start/stop/restart without a terminal
- Integrates with Contacts, Calendar, Reminders, Screen Recording, Accessibility via proper TCC prompts
- Uses `launchd` for the background service — survives reboots cleanly
- Takes screenshots, analyses the screen, runs shell commands, opens apps

**Design:** Cream + terracotta palette, Libre Baskerville + Plus Jakarta Sans + JetBrains Mono. Clean.

Download: [DMG from GitHub releases](https://github.com/blazelucastaco-ai/nexus/releases/latest) (unsigned — right-click → Open on first launch). Requires Anthropic API key + Telegram bot.

Honest about limits: v0.1.0, unsigned, private alpha, Apple Silicon primary.

---

## r/ChatGPTCoding (or r/ClaudeAI)

Tone: dev-focused, tool-comparison vibe.

**Title:** Built a personal AI agent with persistent memory — thought people here might find the architecture interesting

**Body:**

Open-sourced NEXUS today, curious what people think of the architecture choices.

**Key picks:**

- **Interface: Telegram, not a desktop UI.** Forces brevity and works from any device. Also lets me work with NEXUS from my phone without needing a mobile app.
- **Memory: SQLite + 4 layers** — episodic (every conversation), semantic (extracted facts), procedural (patterns/rules), working (rolling window). Consolidation happens nightly in a dream cycle job.
- **Model tiering: Opus 4.7 for planning, Sonnet 4.6 for execution, Haiku 4.5 for fast checks.** Ultra mode for long-running work that can't be interrupted.
- **Personality: real emotional state** (valence, arousal, confidence, engagement, patience) that drifts with interactions. Four presets plus custom traits.
- **LLM-driven memory import on install** — detects Claude Code / Codex / Gemini / Cursor on your Mac, hands the raw content to Sonnet, and the LLM writes NEXUS's own memories + skills in first-person voice.

Repo: [github.com/blazelucastaco-ai/nexus](https://github.com/blazelucastaco-ai/nexus) (MIT)

Site with benchmarks: [blazelucastaco-ai.github.io/nexus](https://blazelucastaco-ai.github.io/nexus/)

Happy to dig into any of the design decisions.

---

## Rules for posting

1. **Don't crosspost all four the same day** — Reddit flags repeat-poster behavior. Space them out: one per day over a week.
2. **Respond to every comment in the first 24h.** Engagement is the biggest ranking signal on Reddit.
3. **Don't be defensive.** Someone will say "just use X" or "why not local models" — engage honestly, don't argue. "Fair — NEXUS is Claude-only right now, wiring Ollama is on the roadmap. The SQLite memory stack would work with any backend."
4. **Never mention r/LocalLLaMA rules** — they ban self-promotion that reads as marketing. Frame every post as sharing the build process, not selling.
5. **Read each sub's sidebar before posting.** Some require the `[SHOW]` or `[OC]` prefix. r/SideProject requires a "Days spent" line.
