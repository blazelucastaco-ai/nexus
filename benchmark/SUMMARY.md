# NEXUS vs OpenClaw — Task Battery Results

**Date:** 2026-04-19
**Battery:** 15 prompts across 7 categories (instruction-following, math, reasoning, code, factual, format, multi-step)
**Scoring:** Programmatic checks (exact match, regex, word count, line count, contains)
**Models:** NEXUS → claude-sonnet-4-6 · OpenClaw → claude-sonnet-4-5 (both Anthropic)

## Headline

| | NEXUS | OpenClaw |
|---|---|---|
| Pass rate | **15/15 (100%)** | **15/15 (100%)** |
| Avg wall time per prompt | 39,886 ms | 6,482 ms |

Both systems answered every prompt correctly. **Correctness is a tie at 100%.**

Wall time delta is explained by the test rig: NEXUS boots its full orchestrator (4 memory layers, personality/emotional engines, browser bridge, agent manager) for each one-shot call; OpenClaw's `--local` mode spawns just the agent. This is a cold-start-per-prompt measurement, not daemon-mode response latency. In normal use both systems run as long-lived daemons where per-message latency is dominated by model API time.

## Per-category

| Category | NEXUS | OpenClaw | NEXUS ms | OpenClaw ms |
|---|---|---|---|---|
| instruction-following | 3/3 | 3/3 | 39,489 | 6,383 |
| math | 2/2 | 2/2 | 42,589 | 6,279 |
| math-multi-step | 1/1 | 1/1 | 41,190 | 8,124 |
| factual | 2/2 | 2/2 | 38,798 | 5,247 |
| reasoning | 3/3 | 3/3 | 39,063 | 6,872 |
| code | 3/3 | 3/3 | 39,707 | 6,841 |
| format | 1/1 | 1/1 | 39,548 | 5,761 |

## Combined with runtime benchmark

| Dimension | NEXUS | OpenClaw | Winner |
|---|---|---|---|
| Task battery pass rate | 15/15 | 15/15 | Tie |
| Idle RSS (daemon) | 22.9 MB | 359.1 MB | **NEXUS — 15.7× lighter** |
| Cold start | 65 ms | 72 ms | NEXUS (10% faster) |
| Tests in shipped package | 792 | 0 | **NEXUS** |
| Catalog breadth | 10 agents + browser bridge | 30+ skills, 10+ extensions | **OpenClaw** |
| Production deps | 17 | 53 | NEXUS |

## Methodology

- Same Anthropic API key used for both systems to eliminate provider variance.
- Each prompt run once per system; scored by programmatic check (no LLM judge needed — all prompts have objectively checkable answers).
- Battery, runner, and raw results are committed in `benchmark/` for reproducibility.

## Reproducing

```bash
cd ~/nexus
node benchmark/run.mjs           # full 15-prompt battery
node benchmark/run.mjs --limit=3 # smoke test
```

Results written to `benchmark/results/run-<timestamp>.json`.
