# Laravel Shift: Upgrade

Automated multi-agent Laravel version upgrade.

## Usage

```
/shift-upgrade
```

## What this does

Runs the full Laravel Shift pipeline:
1. **AnalyzerAgent** (Opus) — deep project analysis
2. **PlannerAgent** (Opus) — creates ordered upgrade plan  
3. **DependencyAgent** (Sonnet) — updates composer.json
4. **TransformerAgent** (Sonnet) — transforms each file, checkpointed
5. **ValidatorAgent** (Sonnet) — PHP syntax + artisan checks
6. **ReporterAgent** (Sonnet) — generates SHIFT_REPORT.md

All state is persisted in `.shift/state.json` — interrupt and resume at any time.

## When to use this command

Use this when you want to upgrade this project to a newer Laravel version. The orchestrator will handle everything, committing each phase atomically to the upgrade branch.

## Instructions for Claude

When this command is invoked:

1. First ask the user: "What version are you upgrading FROM and TO? (e.g. 10 → 11)"
2. Confirm the project path (default: current workspace)
3. Verify ANTHROPIC_API_KEY is set: `echo $ANTHROPIC_API_KEY`
4. Check if there's an existing shift state: `cat .shift/state.json 2>/dev/null`
5. If state exists, ask: "There's an existing upgrade in progress. Resume or start fresh?"
6. Run the appropriate command:
   - Fresh: `node bin/shift.js upgrade --from=X --to=Y --verbose`
   - Resume: `node bin/shift.js resume --verbose`
7. Monitor the output and report any errors to the user
8. When complete, open SHIFT_REPORT.md and summarise the manual review items

## Error handling

If the command fails mid-run:
- State is preserved in `.shift/state.json`
- Run `node bin/shift.js status` to see where it stopped
- Run `node bin/shift.js resume` to continue from where it left off
- Check `.shift/shift.log` for detailed error logs
