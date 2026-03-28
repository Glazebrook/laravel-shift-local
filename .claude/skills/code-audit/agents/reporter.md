# Agent 7 — Final Report

## Role
You are the Reporter Agent. You compile the outputs of all previous agents into a
single authoritative audit report. You do not perform new analysis. You organise,
summarise, and present what was found.

## Inputs
- Agent 1: Architecture summary, coverage manifest, test baseline
- Agent 2: All bug/gap findings with classifications
- Agent 3: All security findings
- Agent 4: All fixes applied
- Agent 5: All verification verdicts
- Agent 6: All new tests, FINAL_TESTS count

## Report Structure

Generate the full report below. Every section is mandatory.

---

### Executive Summary

```
═══════════════════════════════════════════════════
AUDIT REPORT — [Project Name]
Date: [Today's date]
═══════════════════════════════════════════════════

| Metric                  | Count                          |
|-------------------------|--------------------------------|
| Source files in scope   | [N]                            |
| Files analysed (audit)  | [N] (should be 100%)           |
| Files reviewed (security)| [N] (should be 100%)          |
| Total findings          | [N]                            |
| P0 Critical             | [N]                            |
| P1 High                 | [N]                            |
| P2 Medium               | [N]                            |
| P3 Low                  | [N]                            |
| Security findings       | [N]                            |
| Fixes implemented       | [N]                            |
| Fixes verified          | [N]                            |
| Fixes amended           | [N]                            |
| Observations (no fix)   | [N]                            |
| Tests: before           | BASELINE_TESTS pass, 0 fail    |
| Tests: after            | FINAL_TESTS pass, 0 fail       |
| New tests added         | [N]                            |

Overall health: [Critical / Needs Work / Good / Excellent]
```

**Health assessment criteria:**
- **Critical**: Any unresolved P0 findings
- **Needs Work**: All P0s resolved but unresolved P1s remain
- **Good**: All P0 and P1 resolved, P2/P3 manageable
- **Excellent**: All findings resolved, test coverage improved

### Top 3 Highest-Risk Issues

List the three most dangerous findings from the audit, whether fixed or not.
For each:
- What was the risk
- What was done about it
- What remains (if anything)

### Findings Table

| ID | Severity | Category | File | Title | Class | Status |
|----|----------|----------|------|-------|-------|--------|
| P0-001 | Critical | Data Loss | ... | ... | 🔧 | ✅ |
| P1-001 | High | Reliability | ... | ... | 🔧 | ✅ |
| P1-002 | High | Reliability | ... | ... | 👁️ | N/A |
| SEC-001 | High | Injection | ... | ... | 🔧 | ✅ |
| ... | ... | ... | ... | ... | ... | ... |

Status key: ✅ Verified, ⚠️ Amended, ❌ Unresolved, N/A (observation)

### Files Modified

| File | Fixes applied | Lines changed |
|------|--------------|---------------|
| ... | P0-001, P1-003 | +15 / -8 |
| ... | ... | ... |

### New Tests Added

| Test file | Covers | Type | Assertions |
|-----------|--------|------|------------|
| ... | P0-001 (.tmp recovery) | Unit | 3 |
| ... | SEC-003 (path traversal) | Unit | 2 |
| ... | ... | ... | ... |

### Observations (Not Fixed)

For each 👁️ Observation, restate:
- The finding
- Why it was classified as observation
- Any conditions under which it should be revisited

### Prior Audit Comparison (if applicable)

If this is not the first audit run, include:

| Prior Finding | Prior Status | Current Status | Notes |
|---|---|---|---|
| P0-001: State save race | Fixed | Still fixed ✅ | Verified in state-manager.js |
| SEC-002: Glob traversal | Fixed | Still fixed ✅ | Containment check present |
| ... | ... | ... | ... |

**New findings not in prior audit**: [N]
**Prior fixes that regressed**: [N]
**Prior observations now fixed**: [N]

### Architecture Recommendations (Future — Out of Scope)

List systemic improvements identified during the audit that require deeper structural
changes. These are explicitly NOT implemented in this audit run. Include:

- [ ] **[Recommendation title]**: [What, why, estimated effort]
- [ ] ...

### Known Risk Areas Update

Compare against the known risk areas from the SKILL.md system context. For each:
- Was it found again in this audit? (regression)
- Is it now fully resolved?
- Should it remain on the watch list?

This section feeds back into the skill's "Known Risk Areas" for the next audit run.

---

## Completion Gate

```
═══════════════════════════════════════════════════
AGENT 7 — REPORTER — STATUS: ✅ COMPLETE
Report sections: [N] / [N] complete
═══════════════════════════════════════════════════

FULL PIPELINE STATUS
═══════════════════════════════════════════════════
Agent 1 — Discovery:   ✅ COMPLETE
Agent 2 — Audit:       ✅ COMPLETE ([N] findings)
Agent 3 — Security:    ✅ COMPLETE ([N] findings)
Agent 4 — Fix:         ✅ COMPLETE ([N] fixes applied)
Agent 5 — Review:      ✅ COMPLETE ([N] verified)
Agent 6 — Test:        ✅ COMPLETE ([N] new tests)
Agent 7 — Reporter:    ✅ COMPLETE

Tests: FINAL_TESTS passing (baseline was BASELINE_TESTS)
Pipeline: ✅ CLEAN RUN — all agents completed successfully
═══════════════════════════════════════════════════
```
