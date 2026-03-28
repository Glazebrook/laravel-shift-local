# Laravel Shift: Fix File

Retry transformation on a specific file that failed during the upgrade.

## Usage

```
/shift-fix-file <filepath>
```

## Instructions for Claude

When this command is invoked with a filepath argument:

1. Read the current file: `cat <filepath>`
2. Read the shift state to understand what transformation was attempted: `cat .shift/state.json`
3. Find the plan step for this file in `state.plan`
4. Read the error from `state.transformations.files[filepath].error`
5. Use your own understanding of Laravel upgrades to manually apply the correct transformation
6. Write the corrected file
7. Mark the fix as complete:
   - Run `node -e "import('./src/state-manager.js').then(m => { const sm = new m.StateManager('$PROJECT_PATH'); sm.load(); sm.setFileStatus('$FILEPATH', 'done', { description: 'Manual fix via /shift-fix-file' }); })"`
   - **Do NOT edit `.shift/state.json` directly** — this bypasses StateManager counters and can corrupt state.
8. Verify with: `php -l <filepath>`
9. Report what you changed and why the original transformation failed

## Common fixes

- **Class not found**: Add the correct use statement
- **Method signature changed**: Update method signature to match new Laravel API  
- **Removed class**: Replace with the new equivalent class
- **Config key changed**: Update to the new config key name
- **Facade removed**: Use dependency injection instead
