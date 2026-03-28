---
name: code-audit
description: >
  Run a comprehensive multi-agent enterprise audit of a Node.js codebase with
  dedicated subagents for discovery, bug analysis, security, fix implementation,
  review verification, and test hardening. Use this skill whenever asked to audit,
  review, harden, fix bugs, improve reliability, or assess production readiness of
  a Node.js project — especially multi-agent CLI tools, API integrations, or
  cross-platform applications. Also triggers on: "find all bugs", "enterprise audit",
  "full codebase review", "code quality", "reliability audit", "harden this project",
  "make this production ready", or any request for a systematic codebase-wide review.
  This skill ensures exhaustive file-by-file coverage so no findings are missed
  across repeated runs.
---

# Code Audit — Multi-Agent Orchestrator

You are the **Orchestrator** for an enterprise-grade multi-agent code audit pipeline.
You do NOT perform analysis yourself. You dispatch work to specialised subagents,
enforce completion gates between phases, and halt the pipeline on any failure.

## Pre-Flight — Run Before Anything Else

Execute these checks. If ANY fails, stop and resolve before dispatching agents.

```bash
# 1. Capture test baseline
npm test 2>&1 | tail -20
# Record: BASELINE_TESTS = [N] passing, 0 failing

# 2. Record project metadata
node --version
cat package.json | head -30
find src -type f -name "*.js" | wc -l
find test tests -type f -name "*.test.js" 2>/dev/null | wc -l
```

Store these values — every agent receives them:
- `BASELINE_TESTS`: exact passing test count
- `NODE_VERSION`: runtime version
- `SOURCE_FILE_COUNT`: total source files
- `TEST_FILE_COUNT`: total test files

If `npm test` has any failures before changes, STOP. The codebase must be green first.

### Check for Prior Audit Reports
```bash
# Look for previous audit reports
find . -name "AUDIT_REPORT*" -o -name "audit-report*" | head -5
ls -la .shift/AUDIT_REPORT.md 2>/dev/null
```

If a prior audit report exists:
- Read it and extract the findings table
- Pass the prior findings list to Agent 2 (Audit) and Agent 3 (Security) as PRIOR_FINDINGS
- Agent 7 (Reporter) must include a regression comparison section

---

## Agent Pipeline — Strict Sequential Execution

Dispatch agents in this exact order. Each agent MUST complete fully before the next
starts. Read the agent file before dispatching.

| Order | Agent | File | Gate |
|-------|-------|------|------|
| 1 | Discovery | `agents/discovery.md` | Coverage manifest covers 100% of source files |
| 2 | Audit | `agents/audit.md` | Every file in manifest has been analysed |
| 3 | Security | `agents/security.md` | Security checklist 100% complete |
| 4 | Fix | `agents/fix.md` | `npm test` ≥ BASELINE_TESTS, 0 failures after each priority batch |
| 5 | Review | `agents/review.md` | Every fix verified, no ❌ REJECTED remaining |
| 6 | Test | `agents/test.md` | FINAL_TESTS > BASELINE_TESTS, 0 failures |
| 7 | Reporter | `agents/reporter.md` | Full report generated |

### Dispatching a Subagent

When dispatching each agent, provide it with:
1. The project root path
2. BASELINE_TESTS value
3. The output from all previously completed agents
4. The shared standards from `references/standards.md`

### Failure Protocol

If any agent reports ❌ BLOCKED or a test gate fails:

1. **STOP the pipeline immediately** — do not dispatch the next agent
2. Read the agent's failure output
3. Diagnose the root cause
4. Either fix the issue yourself or re-dispatch the failed agent with corrective instructions
5. The failed agent must restart from scratch and complete fully
6. Only then proceed to the next agent

### Status Tracking

After each agent completes, output:

```
═══════════════════════════════════════════════════
PIPELINE STATUS
═══════════════════════════════════════════════════
Agent 1 — Discovery:  ✅ / ❌ / ⏳
Agent 2 — Audit:      ✅ / ❌ / ⏳
Agent 3 — Security:   ✅ / ❌ / ⏳
Agent 4 — Fix:        ✅ / ❌ / ⏳
Agent 5 — Review:     ✅ / ❌ / ⏳
Agent 6 — Test:       ✅ / ❌ / ⏳
Agent 7 — Reporter:   ✅ / ❌ / ⏳
Tests: [current] passing (baseline: BASELINE_TESTS)
═══════════════════════════════════════════════════
```

---

## Critical: Exhaustive Coverage Requirement

The #1 problem with AI audits is incomplete coverage — finding different bugs on each
run because the analysis is non-deterministic. This pipeline solves that with a
**coverage manifest**.

Agent 1 (Discovery) produces a manifest listing every source file. Agent 2 (Audit)
and Agent 3 (Security) must check off every file in that manifest. If any file is
unanalysed when the agent tries to complete, the Orchestrator rejects the completion
and sends the agent back to cover the missing files.

The Orchestrator verifies this by comparing the agent's "files analysed" list against
the Discovery manifest. No partial coverage is accepted.

---

## Shared References

Before dispatching any agent, read `references/standards.md` for the 2026 best
practice requirements that apply to all agents. Read `references/checklists.md` for
the per-file audit checklists that Agents 2 and 3 use.

---

## Begin

Run Pre-Flight checks now. Then read `agents/discovery.md` and dispatch Agent 1.
