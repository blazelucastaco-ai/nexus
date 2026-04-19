# NEXUS vs OpenClaw — Benchmark Report

**Date:** 2026-04-19
**Subjects:** NEXUS v0.1.0 · OpenClaw v2026.3.8
**Host:** macOS 25.3.0 (darwin arm64), Node 20.x, zsh

---

## TL;DR

| Headline | OpenClaw | NEXUS | Delta |
|---|---|---|---|
| Running RSS (live daemon) | **359.1 MB** | **22.9 MB** | NEXUS **15.7× lighter** |
| Cold-start (median of 5) | 72 ms | 65 ms | NEXUS 10% faster |
| Test suite | none found | **792 tests / 56 files** | — |
| On-disk footprint | 670 MB | 302 MB (node_modules + dist) | NEXUS 55% smaller |
| Skills / extensions shipped | 30+ skills, 10+ ext | 10 built-in agents + browser bridge | OpenClaw broader catalog |

**Verdict:** OpenClaw is a broader, catalog-rich ecosystem with many pre-built skills/extensions and a large docs surface. NEXUS is an order of magnitude lighter at runtime, has real automated test coverage, and focuses on a tight core (orchestrator, memory, browser, installer) rather than a plugin marketplace.

---

## Methodology

- **Runtime memory** measured with `ps -o rss=` against the long-running process (OpenClaw gateway PID 1164, NEXUS daemon PID 29327). Both daemons were warm and idle at sample time.
- **Cold-start** measured with `hyperfine`-style best-of-5 via `time node <entry> --help`; reported value is the median of 5 runs.
- **Disk** measured with `du -sh` on the install root (for OpenClaw, the npm-global package dir; for NEXUS, the checked-out repo's `node_modules` + `dist`).
- **LOC** via `find ... -name '*.ts' | xargs wc -l` on source (NEXUS only — OpenClaw ships compiled only).
- **Test surface** via `grep -rc "^\s*\(it\|test\)(" test/**` for NEXUS; absence of a test directory was confirmed in OpenClaw's installed package.
- What this benchmark does **not** measure: end-to-end task success rate, model-call latency, UX polish, or plugin interop. Those need a task-suite harness (future work).

---

## Static comparison

| Dimension | OpenClaw 2026.3.8 | NEXUS 0.1.0 |
|---|---|---|
| Install root | `~/.npm-global/lib/node_modules/openclaw` | `~/nexus` |
| Disk total | 670 MB (92 MB dist + 43 MB extensions + 460 KB skills + deps) | 266 MB node_modules + 36 MB dist |
| Source visible | compiled only (`dist/`) | full TypeScript (50,704 LOC) |
| CLI subcommands | 40 | 27 |
| Production deps | 53 | 17 |
| Dev deps | 20 | 13 |
| Skills bundled | 30+ (1password, apple-notes, apple-reminders, bear-notes, discord, github, …) | 10 built-in agents + browser bridge |
| Extensions bundled | 10+ | — (browser extension in-repo) |
| README | 559 lines | 186 lines |
| CHANGELOG | 3,998 lines | none |
| Dist file count | 897 | — |

OpenClaw's install ships a large precompiled distribution plus a curated catalog of integrations. NEXUS ships source + a focused agent core and delegates broad integrations to its installer app and browser bridge.

---

## Runtime comparison

| Metric | OpenClaw | NEXUS |
|---|---|---|
| Cold start (median of 5) | **72 ms** | **65 ms** |
| Process | gateway (PID 1164) | daemon (PID 29327) |
| Idle RSS | **359.1 MB** | **22.9 MB** |
| Ratio | 1.00× | **0.064× (15.7× less)** |

The memory delta is the single most striking number in this benchmark. Running both projects in steady-state idle, OpenClaw's gateway process holds ~359 MB resident, while the NEXUS daemon sits at ~23 MB. That is a different weight class.

Two likely drivers:
1. **Dependency footprint.** OpenClaw ships 53 production deps; NEXUS ships 17. More preloaded modules → more retained heap.
2. **Process model.** OpenClaw keeps a gateway process hot to broker requests across its skill/extension catalog. NEXUS's daemon is leaner and offloads UI to a separate Electron app only when the installer is open.

Cold-start is close (72 ms vs 65 ms); both are well under the threshold where a human notices.

---

## Test coverage

| | OpenClaw | NEXUS |
|---|---|---|
| Test files | 0 found | 56 |
| Test cases | 0 found | **792** |
| Framework | — | Vitest |

OpenClaw's installed package contains no `test/` directory and no `*.test.*` files. This doesn't mean the upstream project has no tests — only that the shipped artifact doesn't include them.

NEXUS has 792 test cases spread across 56 files, covering orchestrator, message pipeline, memory, repositories, capability kernel, browser bridge, and installer core. The entire suite runs green on `main`.

For a system that autonomously executes tool calls and mutates user data, automated regression coverage is load-bearing. This is one of the places NEXUS clearly leads.

---

## Feature / maturity

- **OpenClaw strengths:** catalog breadth (30+ integrations), a mature CHANGELOG (3,998 lines indicates long iteration), larger documentation surface, more CLI entry points (40 vs 27).
- **NEXUS strengths:** native macOS installer app with wizard + dashboard + menubar tray, tight core (orchestrator + memory + browser), 15× lighter at runtime, actual test coverage, open source code (not just compiled dist).

Different design goals: OpenClaw positions as a broad assistant hub; NEXUS positions as an embedded agent core with polished install/control UX.

---

## Caveats

- OpenClaw ships compiled-only — some comparisons (LOC, code complexity) aren't directly possible.
- RSS numbers are single-sample; a fair comparison under load would require a sustained-work harness.
- "Features" is a soft axis; the skill-count comparison rewards OpenClaw's catalog model and doesn't capture NEXUS's agent-orchestration depth.
- NEXUS is v0.1.0 — the CHANGELOG gap reflects age, not quality.

---

## Recommended next benchmark

A task-suite harness that runs the same N prompts against both systems and scores:
- task success rate
- tokens used
- wall time
- error/retry count
- context-stitching quality across sessions

That is the comparison that matters to an end user. This report is the substrate: static shape + runtime cost. The dynamic shape comes next.
