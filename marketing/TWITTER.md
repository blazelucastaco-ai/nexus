# X / Twitter — launch thread + single variants

## Main launch thread (7 tweets)

**1 / hook**

I spent three months building a personal AI agent that actually *lives* with you instead of forgetting everything between sessions.

Today I'm open-sourcing it.

NEXUS — MIT, macOS, built on Claude. 22 MB of RAM for the entire daemon.

🧵 ↓

https://blazelucastaco-ai.github.io/nexus/

**2 / what's different**

Every AI tool I used had the same gap:
Close the tab → it forgets who you are.

NEXUS is the opposite.

It runs as a service on your Mac, messages you on Telegram from anywhere, and remembers every conversation in a 4-layer SQLite memory system.

**3 / the memory**

Four layers:
• Episodic — every conversation
• Semantic — extracted facts about you and your projects
• Procedural — rules and patterns
• Short-term — the last ~50 messages

A nightly dream cycle (2–5am local) consolidates episodic → semantic, drops noise, generates reflections.

**4 / the weird part**

When you install NEXUS, it asks:
*"Want me to read your Claude Code / Codex / Gemini memory and write my own in my voice?"*

It hands the raw content to Sonnet. Sonnet reads it. Writes NEXUS's memories and skills as a synthesis, in first-person.

41 Claude Code notes → 16 distilled memories + 4 auto-generated skill files on my own machine.

**5 / the numbers**

• 22.9 MB RSS at idle (15× lighter than comparable tools)
• 25/25 on a hard prompt battery (math, code, strict format, adversarial facts, LLM-judged quality)
• 847 regression tests, all green
• 65ms cold start

Measured. Not marketed.

**6 / honest caveats**

v0.1.0. Private alpha.

This week alone I fixed a temperature-deprecation bug, a self-protection false-positive, a classifier that misread compliments as tasks, and a config-yaml/json drift.

I would not yet ship this to strangers. Private beta is the next step.

**7 / links**

Site: https://blazelucastaco-ai.github.io/nexus/
GitHub: https://github.com/blazelucastaco-ai/nexus
Download (Mac): https://github.com/blazelucastaco-ai/nexus/releases/latest

MIT. Open source. Would love feedback on the memory design.

---

## Single-tweet variants (if you don't want to thread)

**V1 — numbers-forward**

Open-sourced my personal AI agent today.

22.9 MB RSS idle. 25/25 on a hard prompt battery. 847 regression tests passing. Four-layer memory in SQLite.

It lives on your Mac, messages you on Telegram.

https://blazelucastaco-ai.github.io/nexus/

**V2 — story-forward**

Every AI tool I used forgot everything the moment I closed the tab.

So I built one that actually remembers.

NEXUS: open-source personal AI for Mac, Telegram-first, persistent memory that consolidates nightly like sleep.

MIT. v0.1.0.

https://blazelucastaco-ai.github.io/nexus/

**V3 — technical hook**

LLM-driven memory import:

On install, NEXUS reads your Claude Code / Codex / Gemini history, hands the raw content to Sonnet, and the LLM writes NEXUS's own memories and skills in first-person voice.

Not a mechanical copy. A real synthesis.

https://github.com/blazelucastaco-ai/nexus

---

## LinkedIn variant (longer, more professional)

**Why I built a personal AI agent that lives on my Mac**

For the past few months I've been building NEXUS — an open-source personal AI agent for macOS. Today I'm releasing v0.1.0.

The problem that drove it: every AI tool I used had the same gap. Close the tab, it forgot who I was. Claude Code didn't remember my projects day-to-day. Cursor didn't know preferences I'd explained ten times. Even custom GPTs reset between conversations.

NEXUS is my attempt at the missing category — an AI that actually lives with you. It runs as a service on your Mac, has a real four-layer memory system in SQLite (episodic, semantic, procedural, short-term), consolidates context nightly via a dream cycle, and messages you on Telegram from anywhere.

A few of the design decisions that surprised me:

→ Telegram, not a desktop UI. One inbox, every device.
→ 22.9 MB RSS at idle. The whole daemon. (Typical Electron apps: 100–300 MB.)
→ LLM-driven memory import: on install, NEXUS reads your Claude Code / Codex / Gemini history and Sonnet synthesizes it into NEXUS's own voice.
→ Tiered model routing — Opus 4.7 for planning, Sonnet 4.6 for execution, Haiku 4.5 for fast checks.

MIT license, macOS only for now, requires an Anthropic API key.

v0.1.0, private alpha. I wouldn't yet call it production-ready — I fixed six real bugs this week. But the core works, and the distinctive parts are measurable.

Site with benchmarks: https://blazelucastaco-ai.github.io/nexus/
Repo: https://github.com/blazelucastaco-ai/nexus

Feedback welcome. Especially on the memory design — I think it's the most interesting piece.

#AI #OpenSource #MacOS #AIAgent #Anthropic #Claude

---

## Timing advice

- **X/Twitter**: post the thread on a Tuesday or Wednesday at **8–10am PT** or **4–6pm PT**. Avoid weekends unless you have an existing audience there.
- **LinkedIn**: **Tuesday–Thursday, 8–10am in your target timezone** (probably US East Coast for this crowd).
- **Same day as Product Hunt** = compounding referral traffic. Different days = two separate reach peaks. Test both strategies if you do multiple launches.
