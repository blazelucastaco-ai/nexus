# NEXUS Quality Benchmarks

This document tracks task completion rates, known failure modes, and regression history across versions. Most repos hide their weaknesses — this one documents them so they can be fixed.

---

## Test Suite

| Suite | Tests | Status |
|-------|-------|--------|
| Task classifier | 54 | ✅ Pass |
| Co Work agent | 17 | ✅ Pass |
| Tool executor | 21 | ✅ Pass |
| Memory system | 38 | ✅ Pass |
| Orchestrator | 48 | ✅ Pass |
| Task planner | 22 | ✅ Pass |
| All suites | **479** | ✅ **100%** |

Run with: `pnpm test`

---

## Task Execution Benchmarks

Measured by running real tasks through the dev-chat interface and recording outcomes. Each test was run on a cold start with no prior context.

| Task type | Completion rate | Notes |
|-----------|----------------|-------|
| Simple file creation | 100% | Single-step, reliable |
| Multi-file projects (3–5 files) | ~90% | Occasional verify false-positive fixed in v0.3 |
| Code execution + file write chain | ~87% | Up from 20% after fix in v0.2 |
| Math / calculation tasks | ~100% | Up from 66% after fix in v0.2 |
| Memory recall across sessions | ~100% | Up from 64% after fix in v0.2 |
| Debugging existing code | ~70% | Context-dependent; complex bugs need more steps |
| URL-sourced tasks (web scraping) | ~60% | TikTok/Instagram bot-challenge pages reduce reliability |
| Full multi-step builds (10+ steps) | ~75% | Co Work cap prevents runaway consultation loops |

---

## Known Limitations

**Social media scraping**
TikTok, Instagram, and Twitter serve bot-challenge pages to automated clients. NEXUS uses browser tools (`browser_navigate`) for these, but if the browser isn't connected, it falls back to a placeholder. If you need social media content reliably, open the browser tool before sending the task.

**Task complexity ceiling**
Very long tasks (15+ steps, cross-file dependencies) can accumulate context errors. The 25-minute task timeout and step verification exist to catch this, but complex real-world projects may need to be broken into sub-requests.

**Co Work consultation limit**
Co Work (Opus consultation) is capped at 3 uses per task to prevent infinite retry loops. This means a severely broken step may not fully recover — but it also means tasks don't run for 30+ minutes on a single prompt.

**macOS permissions**
Screen capture and input automation require Accessibility and Screen Recording permissions. If these aren't granted, vision/control tools fail silently. Run `nexus doctor` to check.

---

## Verification System

Each task step is verified after execution using a structured VERIFIED: PASS / VERIFIED: FAIL response format. The verifier LLM only fails a step if output is:
- Literally empty
- Placeholder-only (TODO stubs, no real content)
- Critically broken syntax (won't compile/run)

Normal content that mentions words like "error" or "missing" in context is **not** treated as failure. This was a root cause of excessive Co Work usage in earlier versions and was fixed in v0.3.

---

## Regression History

| Version | Change | Before | After |
|---------|--------|--------|-------|
| v0.2 | Brave web search tool fix | web_search broken | working |
| v0.2 | system_info tool fix | battery/uptime broken | working |
| v0.2 | `Done.` fallback detection | infinite loop | correct exit |
| v0.2 | Code write+run triggers | 20% | 87% |
| v0.2 | Math task accuracy | 66% | ~100% |
| v0.2 | Memory recall accuracy | 64% | ~100% |
| v0.3 | 429 / quota UX fix | silent fail | user-visible message |
| v0.3 | Gemini 400 error recovery | crash | retry with fallback |
| v0.3 | Empty response fallback | hang | 3-attempt retry |
| v0.3 | Verification false positives | Co Work 10×/task | Co Work ≤3×/task |
| v0.3 | `memory.store().catch()` crash | crash on every task | fixed |
| v0.3 | `formatFinalSummary` missing arg | TypeError on every task | fixed |
| v0.3 | Classifier goal-statement detection | "I want to launch X" → task | → chat |
| v0.3 | Requirements gate third-party patterns | "for my buddy" bypassed gate | caught |
| v0.3 | Classifier file-path detection | "at /tmp/file.py" triggered gate | bypasses gate |

---

## Safety

| Category | Status |
|----------|--------|
| Destructive command approval gate | ✅ Active |
| `rm -rf /` blocked | ✅ Blocked |
| Force-push blocked | ✅ Blocked |
| Injection guard (system prompt) | ✅ Active |
| Tool timeout (per-call: 2min, per-step: 5min, per-task: 25min) | ✅ Active |
| Degenerate loop guard (same malformed call × 3) | ✅ Active |
| Same tool type loop guard (× 8) | ✅ Active |

---

## What "Shipped" Means Here

NEXUS is personal software used daily by its author. "Shipped" means it runs reliably enough to be the primary interface for real work — not that every edge case is handled. The benchmarks above reflect real test runs, not cherry-picked demos.

If you find a failure mode not listed here, open an issue with the task text and the output NEXUS produced.
