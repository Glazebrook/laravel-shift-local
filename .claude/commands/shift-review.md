# Laravel Shift: Review Report

Review the SHIFT_REPORT.md and help action the manual review items.

## Usage

```
/shift-review
```

## Instructions for Claude

1. Read SHIFT_REPORT.md
2. List all items marked as requiring manual review
3. For each item, offer to:
   a. Apply the fix automatically if straightforward
   b. Show exactly what needs to change with a diff
   c. Explain why the change is needed in plain English

4. After addressing each item, ask: "Shall I mark this as resolved?"

5. When all items are addressed, run validation:
   ```
   php artisan config:clear
   php artisan route:list
   php artisan test
   ```

6. If tests pass, suggest creating a PR:
   - Show the branch name from `.shift/state.json`
   - Summarise all changes made

## Priority order

Address items in this order:
1. CRITICAL — will cause application boot failure
2. HIGH — will cause runtime errors
3. MEDIUM — deprecated usage, won't break now but will in future
4. LOW — code style/best practice improvements
