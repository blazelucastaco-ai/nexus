# Product Hunt launch kit

## When to launch

Tuesday or Wednesday, **12:01 AM PT**. These two days get the most eyeballs and least competition. Avoid Mondays (weekend overhang), Thursdays+Fridays (weekend decline).

## Tagline (60 char max)

**A personal AI that lives on your Mac, messaged via Telegram**

Alts:
- Open-source Claude agent with persistent memory, 22 MB idle
- The AI that remembers everything across sessions
- Your Mac's always-on AI, chat it from anywhere

## One-liner

NEXUS is an open-source personal AI agent for Mac. It remembers every conversation across sessions, runs shell and browser commands on your behalf, and messages you on Telegram when work is done.

## Full description

**The missing category: personal AI agents that actually live with you.**

You've used Claude Code in your terminal. Cursor in your editor. ChatGPT in a browser tab. Each one forgets everything the moment you close it.

NEXUS is different. It runs as a long-running service on your Mac, with a real memory system underneath: four layers (episodic, semantic, procedural, short-term), a nightly dream cycle that consolidates the day's context into durable facts, and a personality engine whose emotional state drifts as you build a relationship with it.

You message it on Telegram from anywhere. It takes screenshots, runs code, searches the web, controls Chrome, writes files — and messages back when the work is done.

**What's in the box:**

🧠 Four-layer memory in SQLite · 🌙 Nightly dream cycle for consolidation · 💬 Telegram interface (11 slash commands) · 🌐 16 browser tools via native Chrome extension · 🤖 Multi-agent router · ❤️ Emotional engine + four personality presets · 🎯 Self-evaluation on every task response · 📸 Screenshot + screen analysis · 🔮 LLM-driven memory import from Claude Code, Codex, Gemini, Cursor

**Measured performance:**

- 25/25 on a hard prompt battery (math, chain-of-thought reasoning, executable code, strict format)
- 22.9 MB RSS at idle (15× lighter than comparable tools)
- 847 regression tests, all green
- 65 ms cold start

**Tech:** macOS 12+ · TypeScript · Electron installer · Claude Opus 4.7 + Sonnet 4.6 + Haiku 4.5 · MIT license · Open source on GitHub

**Download:** native Mac installer or one-command curl install.

## Gallery shot list (what to screenshot / record)

1. **Cover image (1270×760)**: the NEXUS logo on the cream background with the tagline. Can be a clean static image from the docs site hero.
2. **Screenshot: installer wizard**. Show step 5 or 6 mid-install with the terracotta accent + agent checkboxes.
3. **Screenshot: dashboard tab**. Status "running", the four stat cards, the live activity feed streaming log entries.
4. **Screenshot: Telegram conversation**. A real exchange — user asks "what did we work on yesterday?" and NEXUS replies with the sarcastic-genius tone.
5. **Screenshot: memory tab**. The list of memories showing the imported ones tagged with source labels.
6. **Screenshot: benchmark detail**. The 25-prompt battery table.
7. **Video (optional, 30–60s)**: install → configure → send first Telegram message → NEXUS replies. No voice-over needed, text captions only.

## Maker comment (post this when you launch)

Hey everyone 👋 Lucas here, solo maker of NEXUS.

I built this because every AI tool I loved had the same problem: it forgot everything the moment I closed the tab. Claude Code couldn't remember my projects day-to-day. Cursor didn't know the preferences I'd explained ten times. Even custom GPTs reset between chats.

NEXUS is my attempt at the missing category — a personal AI that actually *lives* with you. It runs as a service on your Mac, has a real four-layer memory in SQLite, consolidates what you've worked on during a nightly dream cycle, and messages you on Telegram from wherever you are.

It's v0.1.0 and I won't pretend it's polished — this week alone I fixed a temperature-deprecation bug that broke task planning on Opus 4.7, a classifier that misread compliments as tasks, and a self-protection path that blocked the user's own workspace. It's a private alpha right now.

But the core ideas work, and the distinctive ones — LLM-driven memory import that reads your Claude Code / Codex / Gemini history and writes NEXUS's own memory in first-person voice, a personality with emotional drift, 22 MB idle memory — are real and measurable.

MIT licensed. Open source. Would love feedback.

## Hunter preferences

- Choose "Tech" + "Developer Tools" + "Artificial Intelligence" categories.
- Topics/tags: `ai-agent`, `claude`, `anthropic`, `macos`, `telegram-bot`, `personal-ai`, `open-source`.
- Pricing: Free (user brings Anthropic API key).

## Launch-day checklist

- [ ] Schedule post for 12:01 AM PT Tuesday or Wednesday
- [ ] Cover image + 5 screenshots uploaded
- [ ] 30-second demo video (optional but ~2× upvote rate)
- [ ] Maker comment ready to post at T+0 (seed the thread)
- [ ] Post launch URL to Twitter/X, LinkedIn, relevant subreddits (r/macapps, r/sideproject, r/LocalLLaMA) at T+2h
- [ ] Reply to every single comment for the first 24h — engagement is the single biggest ranking signal
- [ ] Ask ~10 friends who already use/know NEXUS to upvote + comment (honest reactions, not pump)
