# Laravel Shift: Status

Show the current state of an in-progress upgrade.

## Usage

```
/shift-status
```

## Instructions for Claude

Run: `node bin/shift.js status`

Then parse the output and present it clearly to the user, including:
- Which phase the upgrade is currently on
- How many files have been transformed vs total
- Any errors encountered
- Whether there are items needing manual review

If there are failed files, list them and offer to retry them individually.
If the upgrade is complete, remind the user to review SHIFT_REPORT.md.
