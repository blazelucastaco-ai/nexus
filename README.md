# NEXUS

```
 ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
 ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
 ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ███████╗
 ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
 ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
 ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Claude 4.7+](https://img.shields.io/badge/Claude-4.7%2B%20tiered-7C3AED?logo=anthropic&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-yellow)
![macOS only](https://img.shields.io/badge/macOS-only-000000?logo=apple&logoColor=white)

> Your personal AI assistant that lives on your Mac, talks to you over Telegram, remembers everything, and autonomously executes multi-step tasks.

---

## What is NEXUS?

NEXUS is a persistent AI agent that runs 24/7 on your Mac and communicates through Telegram. Send it a message from anywhere — phone, laptop, beach — and it executes real work: writing and running code, browsing the web, managing files, controlling your computer, and handling long multi-step tasks while you do other things.

Unlike a chatbot, NEXUS has a multi-layer memory system so it remembers your preferences, past work, and what you've asked it before. It has a personality engine with genuine emotional states and opinions that shift over time. It gets better the longer you use it.

**NEXUS is built for one thing: autonomous task execution via Telegram, on macOS.**

## Features

- 🧠 **Multi-layer memory** — Episodic, semantic, procedural, and working memory with dream-cycle consolidation
- 🎭 **Personality engine** — Real emotional states, circadian rhythm, formed opinions, relationship progression
- 💬 **Telegram-native** — Control NEXUS from anywhere, zero browser required
- 🟠 **Jarvis voice interface** — A local, on-device voice + a black-screen orb that breathes, reacts, and speaks. Wake it with "Hey Nexus", talk to it, and the orb pulses with the reply. Same brain as Telegram — one mind, two doors in.
- 🖥️ **Full macOS control** — Screenshots, mouse/keyboard automation, AppleScript, app management
- 🤖 **10 specialized sub-agents** — Vision, File, Browser, Terminal, Code, Research, System, Creative, Comms, Scheduler
- 📚 **Learning system** — Tracks your preferences, corrects repeated mistakes, recognizes behavioral patterns
- 🔌 **Extensible skills** — Drop Markdown files in `~/.nexus/skills/` and NEXUS will use them
- 🤝 **Co Work** — When a step runs into trouble, NEXUS automatically consults a parallel Opus agent for a second opinion
- ✨ **Premium CLI** — Interactive installer, health checks, live logs, one-command updates

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/blazelucastaco-ai/nexus/main/remote-install.sh | bash
```

The installer clones the repo, checks your system, installs dependencies, and walks you through setup interactively.

**Or install manually:**

```bash
git clone https://github.com/blazelucastaco-ai/nexus.git
cd nexus
./install.sh
```

## Architecture

```
src/
├── core/          # Orchestrator, task runner, planner, classifier
├── agents/        # 10 specialized sub-agents + Co Work consultation
├── memory/        # Multi-layer memory: episodic, semantic, procedural
├── personality/   # Emotional engine, opinions, humor, style
├── brain/         # Skills, reasoning, self-awareness, goal tracking
├── learning/      # Preference and pattern learning, mistake tracking
├── macos/         # macOS control: screenshots, input, AppleScript, apps
├── telegram/      # Telegram bot gateway, commands, media handling
├── ai/            # Claude provider, streaming, tool routing
└── tools/         # Tool definitions, executor, approval gate
```

## Sub-Agents

| Agent | What it does |
|-------|-------------|
| **Vision** | Screen capture and visual analysis |
| **File** | File system operations — read, write, search, organize |
| **Browser** | Web browsing, research, and page scraping |
| **Terminal** | Shell command execution and process management |
| **Code** | Code generation, review, refactoring, and debugging |
| **Research** | Multi-source web research with synthesis |
| **System** | macOS control — apps, settings, notifications |
| **Creative** | Writing, brainstorming, and content generation |
| **Comms** | Message drafting and communication tasks |
| **Scheduler** | Task scheduling and reminders |

## Memory System

Five memory layers that persist across sessions and consolidate overnight:

| Layer | Purpose |
|-------|---------|
| **Working** | Short-term context for the current conversation |
| **Episodic** | Timestamped records of past interactions |
| **Semantic** | Learned facts, preferences, and knowledge |
| **Procedural** | How-to knowledge and repeated workflows |
| **Dream Cycle** | Offline consolidation — strengthens important memories, prunes noise |

## Personality System

NEXUS maintains a full emotional state that shifts naturally based on interactions, time of day, and conversation quality. It forms and evolves genuine opinions, pushes back when it disagrees, and builds relationship warmth over time. All of this persists to disk and is restored on restart.

- **Emotional states**: valence, arousal, confidence, engagement, patience
- **Circadian rhythm**: different energy and tone depending on time of day
- **Relationship progression**: stranger → acquaintance → familiar → trusted → close
- **Opinions**: formed from evidence, subject to time decay, can change over many interactions

## Skills

Drop a Markdown file in `~/.nexus/skills/` with YAML frontmatter:

```markdown
---
name: My Skill
description: One-line summary
triggers: keyword1, keyword2
---

Detailed instructions for NEXUS when this skill is relevant...
```

NEXUS scores relevance per-request and injects matching skills into the task context automatically.

## Co Work

When a step in a task fails, NEXUS automatically consults a parallel Claude Opus agent ("Co Work") for advice. The Opus agent analyzes what went wrong and suggests a specific fix. NEXUS gets a maximum of 3 Co Work consultations per task so it doesn't become a crutch. Co Work events are reported in the Telegram summary with "I phoned a friend" language.

## Voice & the Jarvis Interface

NEXUS has a voice and a Jarvis-style screen — a black field with a single molten-orange orb that breathes, reacts while it listens and thinks, and pulses in time with its voice as it speaks. It runs as a frameless full-screen window in the NEXUS menubar app and is **the same brain as Telegram** — same memory, same history, same personality. One core, two doors in.

**Voice is cloud TTS (ElevenLabs); the wake word and the screen are local:**

- **Speech (TTS):** [ElevenLabs](https://elevenlabs.io) — a refined British voice by default (configurable with any Voice ID from your account). Each reply is normalized for natural speech (no spelled-out digits, spoken emoji, or markdown) and the orb pulses in time with it. Requires an ElevenLabs API key; without one, voice replies stay silent (the text still shows).
- **Wake word:** say **"Hey Nexus"** and the screen wakes. An on-device keyword spotter (sherpa-onnx) listens locally; only the wake event ever leaves the helper. First launch prompts for **Microphone** + **Speech Recognition** permission (a one-time macOS grant).
- **The screen:** served on `http://127.0.0.1:4242`, opened automatically in the menubar app. NEXUS drives it itself — the orb, a first-person "thinking" bubble, and charts/diagrams/projects it conjures via its `ui_*` tools.

**Setup.** Add your ElevenLabs API key during install (the **Voice** step) or to `.env` as `ELEVENLABS_API_KEY` — no Python venv or model download is needed, TTS is a cloud API. The installer also builds the local "Hey Nexus" wake helper. Get a key at [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys).

**Env (optional):** `ELEVENLABS_API_KEY` (enables voice), `ELEVENLABS_VOICE_ID` (a Voice ID from your ElevenLabs Voice Lab), `ELEVENLABS_MODEL_ID`, `ELEVENLABS_OUTPUT_FORMAT`, `NEXUS_WAKE_KWS=0` (use the dictation-based wake fallback), `NEXUS_TTS=0` (disable voice). Open the screen directly at `http://127.0.0.1:4242`.

## Configuration

All persistent data lives in `~/.nexus/`:

| Path | Purpose |
|------|---------|
| `config.yaml` | Core settings (model, personality traits, behavior) |
| `memory.db` | SQLite database for episodic and semantic memory |
| `memory/` | File-based memory layers |
| `skills/` | User-defined skill files |
| `brain.json` | Personality and emotional state persistence |
| `wake/` | On-device "Hey Nexus" keyword-spotter model + worker |
| `app/web-ui/` | Built Jarvis interface (served on `:4242`) |

Environment variables in `.env` at project root. See `.env.example` for all options.

## CLI Commands

After installation, the `nexus` command is available globally:

```bash
nexus start        # Start the NEXUS service
nexus stop         # Stop the NEXUS service
nexus restart      # Restart the NEXUS service
nexus status       # Show status, uptime, and memory usage
nexus logs         # Tail logs in real-time
nexus config       # Show current configuration (secrets redacted)
nexus doctor       # Full health check — connectivity, DB, permissions
nexus verify       # Verify installation and API connectivity
nexus setup        # Re-run the interactive setup wizard
nexus update       # Pull latest from GitHub and rebuild
nexus agents       # List all agents and their capabilities
nexus memory       # Show memory system statistics
nexus screenshot   # Take a screenshot and save to Desktop
nexus health       # System resource and service health
nexus version      # Show version and environment info
nexus uninstall    # Remove NEXUS from this system
```

## Development

```bash
pnpm dev           # Development mode with hot reload
pnpm build         # Production build
pnpm test          # Run test suite (1048 tests)
pnpm lint          # Lint and format
```

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js 22+**
- **pnpm**
- **Telegram account** with a bot token from [@BotFather](https://t.me/BotFather)
- **Anthropic API key** (required — NEXUS runs on Claude with tiered routing: **Opus 4.8** for heavy reasoning/planning, **Sonnet 4.6** for chat/execution, **Haiku 4.5** for fast high-volume work)
- **For the Jarvis voice interface (optional):** an [ElevenLabs](https://elevenlabs.io) API key for cloud TTS (add it during install — see *Voice & the Jarvis Interface* below). Without one, voice replies stay silent (the text still shows).

## License

MIT © 2026 Lucas Topinka
