# Laravel Shift Local — Claude Code Context

## What this project is

An enterprise-grade automated Laravel upgrade tool that mirrors [laravelshift.com](https://laravelshift.com) but runs entirely locally inside VS Code with Claude Code. It uses a multi-agent pipeline orchestrated through the Anthropic API.

## Architecture

```
bin/shift.js                    ← CLI entry point (Commander.js) + .shiftrc config loader
src/
  orchestrator.js               ← Central state machine, runs the phases in order
  state-manager.js              ← Persistent JSON state in .shift/state.json
  logger.js                     ← Structured console + file logger (graceful chalk fallback)
  git-manager.js                ← Git branch/commit/rollback operations
  file-tools.js                 ← File read/write/backup + path traversal protection + Anthropic tool definitions
  errors.js                     ← Base error class for unified error hierarchy
  utils.js                      ← Shared utilities (sleep, etc.) — avoids duplication across modules
  agents/
    base-agent.js               ← Agentic loop base class (tool use, retries, timeout enforcement, token tracking)
    analyzer-agent.js           ← Opus: deep project analysis
    planner-agent.js            ← Opus: creates ordered upgrade plan (uses getCombinedMatrix)
    dependency-agent.js         ← Sonnet: updates composer.json + validates install
    transformer-agent.js        ← Sonnet: transforms files one by one
    validator-agent.js          ← Sonnet: PHP syntax + artisan checks
    reporter-agent.js           ← Sonnet: generates SHIFT_REPORT.md (via fileTools backup)
config/
  upgrade-matrix.js             ← Breaking changes per version pair (8→13) + getCombinedMatrix()
.claude/commands/               ← Slash commands for Claude Code
  shift-upgrade.md
  shift-status.md
  shift-fix-file.md
  shift-review.md
```

## Agent models

| Agent | Default Model | Configurable via .shiftrc | Reason |
|-------|---------------|--------------------------|--------|
| AnalyzerAgent | claude-opus-4-6 | Yes (`models.analyzer`) | Deep reasoning about complex codebase |
| PlannerAgent | claude-opus-4-6 | Yes (`models.planner`) | Strategic planning, ordering, completeness |
| DependencyAgent | claude-sonnet-4-6 | Yes (`models.dependency`) | Composer JSON updates |
| TransformerAgent | claude-sonnet-4-6 | Yes (`models.transformer`) | File-by-file code transforms |
| ValidatorAgent | claude-sonnet-4-6 | Yes (`models.validator`) | Error review and auto-fix |
| ReporterAgent | claude-sonnet-4-6 | Yes (`models.reporter`) | Report generation |

## State machine phases

```
INIT → ANALYZING → PLANNING → DEPENDENCIES → TRANSFORMING → VALIDATING → REPORTING → COMPLETE
```

Each phase is:
- Checkpointed to `.shift/state.json`
- Committed to git on success
- Retried up to 3× on failure (state-based counter — consistent across resume)
- Skipped if already complete (resume support)
- Only marked complete on success (failed phases are NOT marked complete)

## Key design decisions

1. **Resumable**: Every phase and every file write is checkpointed. Ctrl+C mid-run saves state cleanly (SIGINT handler) and resume with `shift resume`.
2. **Git-first**: Everything happens on a dedicated branch (`shift/upgrade-X-to-Y`). Each phase is a commit.
3. **File backups**: Every file written is backed up to `.shift/backups/` before modification (including SHIFT_REPORT.md).
4. **Tool use**: Agents use Anthropic tool use to actually read/write files — not just generate text.
5. **Path safety**: All file operations are sandboxed to the project directory (path traversal protection).
6. **Priority ordering**: Critical transforms run before medium/low priority ones.
7. **Per-file retry**: Failed files can be retried up to 3× independently.
8. **Rollback**: Backup tag stored in state; `shift rollback` reverts to pre-upgrade state.
9. **Dry-run**: `--dry-run` runs analysis and planning but skips mutations.
10. **Config file**: `.shiftrc` in project root configures behaviour, model overrides, and exclude patterns.

## Common commands

```bash
# Run upgrade
node bin/shift.js upgrade --from=10 --to=11

# Resume after interruption
node bin/shift.js resume

# Check status
node bin/shift.js status

# Start over (keeps code changes, clears state)
node bin/shift.js reset

# Rollback to pre-upgrade state
node bin/shift.js rollback

# Dry run (analyse + plan only, no file changes)
node bin/shift.js upgrade --from=10 --to=11 --dry-run
```

## Configuration (.shiftrc)

Place a `.shiftrc` JSON file in the project root. CLI flags override .shiftrc values.

```json
{
  "behaviour": {
    "failFast": false,
    "maxFileRetries": 3,
    "verbose": false,
    "composerTimeout": 600,
    "artisanTimeout": 60,
    "maxTotalTokens": null
  },
  "models": {
    "analyzer": "claude-opus-4-6",
    "planner": "claude-opus-4-6",
    "dependency": "claude-sonnet-4-6",
    "transformer": "claude-sonnet-4-6",
    "validator": "claude-sonnet-4-6",
    "reporter": "claude-sonnet-4-6"
  },
  "exclude": {
    "paths": ["vendor", "node_modules", "storage"],
    "filePatterns": ["*.min.js", "*.min.css"]
  }
}
```

### Cost guardrails

Set `maxTotalTokens` in `.shiftrc` to cap cumulative token usage across all agent runs. The upgrade pauses when the threshold is exceeded and can be resumed with `shift resume`.

## Environment

Requires `ANTHROPIC_API_KEY` in environment.

## Extending

To add a new Laravel version pair:
1. Add to `config/upgrade-matrix.js` with breaking changes and hints
2. Add the version string to `KNOWN_VERSIONS` in `src/state-manager.js`
3. No other code changes needed — the agents handle the rest using the matrix as context

To add a new agent:
1. Extend `BaseAgent` in `src/agents/`
2. Add to `Orchestrator` constructor and phase list
3. Add phase to `PHASES` in `state-manager.js`
