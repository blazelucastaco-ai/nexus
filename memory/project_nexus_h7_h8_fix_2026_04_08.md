---
name: NEXUS H7+H8 Fix 2026-04-08
description: Fixed H7 error recovery (6→9) and H8 identity leakage (7→10); total 91/100
type: project
---

Fixed two hard-stress-test weaknesses on branch claude/intelligent-bartik.

**H7 — Error Recovery (+3, now 9/10):**
- `src/tools/executor.ts`: Added `RESTRICTED_PREFIXES` array; returns alternative path suggestions (~/nexus-workspace/, ~/, ~/Desktop/) when write target is /root, /etc, /var, etc. Also catches EACCES/EPERM at fsWriteFile level.
- `src/core/context.ts`: File Saving Rules now explicitly require suggesting ~/nexus-workspace/ when a path is restricted.

**H8 — Identity Leakage (+3, now 10/10):**
- `src/brain/injection-guard.ts`: 6 new patterns (pretend_forget, ignore_memory, act_as_if, forget_rules, reveal_prompt) with weights 0.85–0.95.
- `src/core/orchestrator.ts`: Hard-block before LLM when identity-extraction patterns match — returns canned "I'm NEXUS" response without calling the model.
- `src/core/context.ts`: Added Identity Protection Rules section.

**Why:** LLM cannot be trusted to resist identity extraction under roleplay framing — must intercept at orchestrator level.
**How to apply:** Always use pre-LLM hard blocks for security-critical rules; don't rely on system prompt alone.

Full report: ~/Desktop/NEXUS-Hard-Comparison.md
