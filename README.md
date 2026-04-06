# NEXUS

```
 ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
 ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
 ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
 ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
 ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
 ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-yellow)
![macOS only](https://img.shields.io/badge/macOS-only-000000?logo=apple&logoColor=white)

> A personal AI that lives on your Mac -- sees your screen, controls your computer, remembers everything, and has opinions.

---

## What is NEXUS?

NEXUS is a persistent, opinionated AI assistant that runs locally on your Mac and communicates through Telegram. Unlike generic chatbots, NEXUS has a multi-layer memory system that lets it remember your preferences, past conversations, and learned patterns across sessions. It can see your screen, control your mouse and keyboard, manage files, browse the web, and run terminal commands -- all orchestrated through a personality engine that gives it genuine opinions, emotional states, and a sense of humor.

## Features

- 🧠 **Multi-layer memory** -- Episodic, semantic, procedural memory plus dream cycle consolidation
- 🎭 **Human-like personality** -- Emotional states, opinions, and humor that evolve over time
- 💬 **Telegram-native communication** -- Chat with NEXUS from anywhere via Telegram
- 🖥️ **Full macOS control** -- Screenshots, mouse/keyboard automation, app management
- 🤖 **10 pre-built sub-agents** -- Vision, File, Browser, Terminal, Code, Research, System, Creative, Comms, Scheduler
- 📚 **Learning system** -- Tracks your preferences, mistakes, and behavioral patterns
- 🔌 **Multi-provider AI** -- Claude, GPT, and Ollama for local models
- ✨ **Beautiful CLI setup** -- Interactive installer that gets you running in minutes

## Quick Start

```bash
git clone https://github.com/lucastopinka/nexus.git
cd nexus
./install.sh
```

The installer will walk you through setting up your Telegram bot, choosing an AI provider, and configuring your preferences.

## Architecture

```
src/
├── core/        # Orchestrator, reasoning, personality
├── memory/      # Multi-layer memory system
├── agents/      # 10 pre-built sub-agents
├── macos/       # macOS control layer
├── telegram/    # Telegram bot integration
├── learning/    # Preference & pattern learning
├── providers/   # AI provider integrations
└── utils/       # Shared utilities
```

## Sub-Agents

| Agent | Description |
|-------|-------------|
| **Vision** | Screen capture, OCR, and visual analysis |
| **File** | File system operations -- read, write, search, organize |
| **Browser** | Web browsing, scraping, and research |
| **Terminal** | Shell command execution and process management |
| **Code** | Code generation, review, refactoring, and debugging |
| **Research** | Deep web research with source synthesis |
| **System** | macOS system control -- apps, settings, notifications |
| **Creative** | Writing, brainstorming, and content generation |
| **Comms** | Message drafting, email composition, communication |
| **Scheduler** | Task scheduling, reminders, and time management |

## Memory System

NEXUS uses five memory layers that work together to create persistent, context-aware intelligence:

| Layer | Purpose |
|-------|---------|
| **Working** | Short-term context for the current conversation |
| **Episodic** | Timestamped records of past interactions and events |
| **Semantic** | Learned facts, preferences, and knowledge |
| **Procedural** | How-to knowledge and repeated workflows |
| **Dream Cycle** | Offline consolidation that strengthens important memories and prunes noise |

## Personality System

NEXUS maintains emotional states (curiosity, amusement, frustration, satisfaction) that shift naturally based on interactions. It forms genuine opinions about tools, approaches, and patterns -- and isn't afraid to share them. The personality engine ensures responses feel consistent and human-like rather than robotic.

## Configuration

All configuration lives in `~/.nexus/`:

| File | Purpose |
|------|---------|
| `config.json` | Core settings (AI provider, model, personality) |
| `memory/` | Persisted memory layers |
| `learning/` | Learned preferences and patterns |

Environment variables can be set in `.env` at the project root. See `.env.example` for all available options.

## Development

```bash
# Start in development mode with hot reload
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test

# Lint and format
pnpm lint
```

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js 22+**
- **pnpm**
- **Telegram account** (for the bot interface)
- At least one AI provider API key (Anthropic, OpenAI, or local Ollama)

## License

MIT
