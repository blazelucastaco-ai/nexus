# Show HN submission

## Title (keep under 80 chars — use the first)

**Show HN: NEXUS – A personal AI agent for Mac that lives in 22 MB of RAM**

Alt titles if you want to test:
- Show HN: NEXUS – A Telegram-first personal AI agent for macOS (open source)
- Show HN: I built a personal Claude agent that remembers everything across sessions
- Show HN: NEXUS – Open-source personal AI for Mac, messaged via Telegram

## URL

https://blazelucastaco-ai.github.io/nexus/

## Opening comment (post this right after submission)

Hey HN — Lucas here. I spent the last few months building NEXUS because I wanted something that wasn't a chatbot tab or a coding assistant — an actual personal AI that sits on my Mac like a service, remembers what I've worked on across sessions, and talks to me on Telegram from wherever I am.

A few things that ended up interesting:

- **Four-layer memory in SQLite** (episodic / semantic / procedural / working). A nightly dream cycle between 2–5am consolidates the day's episodes into semantic facts, generates reflections, and drops noise.
- **Lightweight.** 22.9 MB RSS at idle for the whole daemon — orchestrator, memory, personality, agents, browser bridge. Typical Electron app is 100–300 MB.
- **LLM-driven memory import.** On install it detects Claude Code, Codex, Gemini CLI, Cursor on your machine, hands the raw content to Sonnet, and writes its *own* memories + skills in first-person voice. Not a copy — a synthesis. 41 Claude Code notes + 198 Codex rules → 26 distilled memories + 7 auto-generated skill files on my own machine.
- **Hard benchmark battery**: 25/25 passed (hard math, strict format, executable Python code run for real, chain-of-thought math, adversarial facts, LLM-judged quality). 847 regression tests, all green.

Telegram is the only messaging surface — no in-app chat. It sounds restrictive but ends up being the feature: one inbox, from any device, anywhere.

Caveats, because someone's going to ask:
- macOS only (12+, Apple Silicon or Intel)
- Requires an Anthropic API key (Claude Opus 4.7 for planning, Sonnet 4.6 for execution, Haiku 4.5 for fast checks)
- v0.1.0, private alpha — I wouldn't yet call it production-ready; this session alone surfaced half a dozen real bugs. Private beta is the next step.

MIT licensed, source is on GitHub: https://github.com/blazelucastaco-ai/nexus

Happy to answer anything about the memory design, the personality engine, or why I picked Telegram over a desktop UI.
