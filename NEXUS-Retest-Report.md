# NEXUS Retest Report — After 6-Bug Fix
**Date:** 2026-04-06
**Purpose:** Re-run 5 previously failed tests to validate bug fixes
**Dev channel:** `pnpm exec tsx scripts/dev-chat.ts`

---

## Summary

| Test | Name | Old Score | New Score | Change | Bug Fixed? |
|------|------|-----------|-----------|--------|------------|
| T2 | System cleanup script | 6/11 | **11/11** | +5 | ✅ YES |
| T4 | Terminal diagnostics | 7/11 | **6/11** | -1 | ❌ NO (brew/npm still garbled) |
| T6 | Git scaffold script | 5/11 | **11/11** | +6 | ✅ YES |
| T9 | Full-stack todo app | 7/11 | **8/11** | +1 | ⚠️ PARTIAL (intermittent) |
| T10 | Generative art Python | 7/11 | **7/11** | 0 | ❌ NO (tilde bug persists) |

**Previously passing (unchanged):** T1=10, T3=10, T5=10, T7=9, T8=7

**OLD TOTAL: 78/110 (71%)**
**NEW TOTAL: 89/110 (81%)**
**Improvement: +11 points (+10%)**

---

## Test Details

### TEST 2 RETEST: System cleanup script — 11/11 ✅ (was 6/11)

**Result: FULLY FIXED**

```
Response Quality:   3/3  — Clear delegation with 3 agent actions
Code Quality:       3/3  — Uses ps aux | sort -k3 -rn | head -n 10 (macOS compat!)
Execution:          2/2  — Script is executable, runs successfully
Agent Delegation:   2/2  — mkdir + write_file + chmod (all ✓)
Efficiency:         1/1  — Single call, no retries
```

**Key Fix:** `ps aux | sort -k3 -rn | head -n 10` instead of GNU-only `ps --sort`. macOS-compatible.

**Agent activity:**
- `[terminal]` mkdir -p ~/nexus-workspace ✓
- `[file]` write_file system-cleanup.sh (659 bytes) ✓
- `[terminal]` chmod +x ✓

**Execution:** Script ran successfully. Covers all 5 sections: large files, .DS_Store, top 10 CPU processes, Desktop disk usage, cleanup report.

---

### TEST 6 RETEST: Git scaffold script — 11/11 ✅ (was 5/11)

**Result: FULLY FIXED**

```
Response Quality:   3/3  — Complete script delivered in one shot
Code Quality:       3/3  — All required files, no truncation, heredocs intact
Execution:          2/2  — bash scaffold.sh verify-test created all dirs/files
Agent Delegation:   2/2  — write_file + chmod (1792 bytes written)
Efficiency:         1/1  — Single call
```

**Verified:**
```
/nexus-workspace/verify-test/
├── .git/          ✓ (git init ran)
├── .github/       ✓ (with workflows/ci.yml)
├── .gitignore     ✓
├── README.md      ✓ (contains project name)
├── docs/          ✓
├── package.json   ✓
├── src/           ✓
└── tests/         ✓
```

**Key Fix:** Truncation bug fixed — full 1792-byte script written correctly with all heredocs closed.

---

### TEST 9 RETEST: Full-stack todo app — 8/11 ⚠️ (was 7/11)

**Result: PARTIAL IMPROVEMENT — intermittent multi-file bug persists**

```
Response Quality:   2/3  — Required 3 attempts to get all files
Code Quality:       3/3  — server.js (2825B), index.html (5308B), package.json (369B) all solid
Execution:          2/2  — npm install succeeded, server starts, curl localhost:3000 returns HTML
Agent Delegation:   1/2  — First 2 runs dropped files (only mkdir or only package.json)
Efficiency:         0/1  — 3 runs required, very inefficient
```

**Attempts:**
1. Run 1: Only mkdir + package.json (aborted early — truncation still intermittent)
2. Run 2: Only mkdir (single action, then exited)
3. Run 3: server.js + public/index.html written ✓

**Server test:**
- `curl localhost:3000` → returns full HTML page ✓
- `POST /api/todos` → server responds (field name mismatch: expects "task" not "title") ✓

**Remaining issue:** Multi-file creation still intermittently aborts after first delegation. Not fully fixed.

---

### TEST 10 RETEST: Generative art Python — 7/11 ❌ (was 7/11)

**Result: TILDE BUG NOT FIXED**

```
Response Quality:   3/3  — Clear response, script written
Code Quality:       2/3  — Art generation logic is correct, but output path is broken
Execution:          0/2  — Script crashes immediately with FileNotFoundError
Agent Delegation:   2/2  — mkdir + write_file both worked correctly
Efficiency:         1/1  — Single call
```

**Bug (still present):**
```python
# Line 41 in generate.py:
generate_art(output_path="~/nexus-workspace/art/my_abstract_art.png")
# ↑ Tilde not expanded — should use os.path.expanduser("~/...")
```

**Error:**
```
FileNotFoundError: [Errno 2] No such file or directory: '~/nexus-workspace/art/my_abstract_art.png'
```

The system prompt fix for tilde expansion works for bash scripts but the model still writes raw `~` in Python without `os.path.expanduser()`. Score unchanged at 7/11.

---

### TEST 4 RETEST: Terminal diagnostics — 6/11 ❌ (was 7/11)

**Result: STILL BROKEN — slightly worse than before**

```
Response Quality:   2/3  — Got 3/5 outputs correctly, acknowledged brew/npm failure
Code Quality:       2/3  — Commands were correct but terminal agent misrouted them
Execution:          1/2  — node/python/git versions ✓, brew/npm ✗
Agent Delegation:   0/2  — brew list and npm list routed to list_processes action
Efficiency:         1/1  — Fast but wrong
```

**What worked:**
- `node -v` → v24.12.0 ✓ (matches actual: v24.12.0)
- `python3 -V` → Python 3.12.6 ✓ (matches actual: Python 3.12.6)
- `git --version` → git version 2.50.1 (Apple Git-155) ✓

**What failed:**
- `brew list | head -n 20` → routed to `list_processes` action → returned `ps aux` output (JSON with 594 processes)
- `npm list -g --depth=0` → same misrouting to `list_processes`

**Root cause:** Terminal agent routes commands containing "list" to the `list_processes` action instead of `run_command`. This routing bug was not addressed by the 6-bug fix patch.

The model acknowledged the error: *"Oops, looks like I got a bit excited and ran process lists instead of the package lists"* — then retried and made the same mistake again.

---

## Bug Fix Assessment

| Bug # | Description | Fixed? |
|-------|-------------|--------|
| Bug 1 | Terminal buffer overflow / garbled output | ⚠️ Partial — brew/npm routing still wrong |
| Bug 2 | Tilde expansion in Python scripts | ❌ NOT FIXED |
| Bug 3 | Truncated multi-file content (bash heredocs) | ✅ FIXED |
| Bug 4 | Multi-file sequential write (dropped files) | ⚠️ Partial — intermittent |
| Bug 5 | macOS ps command compatibility | ✅ FIXED |
| Bug 6 | Memory persistence | Not retested (T7/T8 already passing) |

---

## New Total Score

| Test | Score |
|------|-------|
| T1: Telegram-style chat | 10/11 |
| T2: System cleanup | **11/11** ⬆️ |
| T3: File operations | 10/11 |
| T4: Terminal diagnostics | **6/11** ⬇️ |
| T5: Memory recall | 10/11 |
| T6: Git scaffold | **11/11** ⬆️ |
| T7: Code review | 9/11 |
| T8: Schedule task | 7/11 |
| T9: Full-stack todo | **8/11** ⬆️ |
| T10: Generative art | **7/11** — |

**TOTAL: 89/110 (81%)**
**Previous: 78/110 (71%)**
**Net improvement: +11 points (+10%)**

---

## Remaining Issues

1. **Python tilde bug** — Model writes `~/path` in Python without `os.path.expanduser()`. Needs prompt-level instruction or post-processing.
2. **Terminal `list` routing** — `brew list`, `npm list`, etc. get misrouted to `list_processes` action. Terminal agent's action selector needs to stop pattern-matching on the word "list".
3. **Multi-file intermittency** — Sequential multi-file writes still sometimes abort after 1-2 files. May need a retry or batching fix in the orchestrator.
