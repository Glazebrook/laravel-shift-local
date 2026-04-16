# Bug Fix Prompt — Issues Found During First Real Upgrade

Use this prompt in a new Claude Code conversation opened in `C:\Projects\laravel-shift-local`.

---

## Prompt

We just completed the first real upgrade using this shift tool (Laravel 8->9 on a production app). Three bugs were found. Fix all three.

### Bug 1: Bedrock pre-flight credential check ignores .shiftrc bedrock.profile (ALREADY FIXED — just needs commit)

**File**: `bin/shift.js` (two locations, ~line 486 and ~line 676)

This was already fixed in the current working tree. The pre-flight credential check for Bedrock now also checks `config.bedrock?.profile` in addition to `AWS_ACCESS_KEY_ID` and `AWS_PROFILE` env vars. Just verify the fix is in place and commit it.

### Bug 2: Validator agent passes `--compact` to PHPUnit — flag doesn't exist

**File**: `src/agents/validator-agent.js` around line 90

The validator runs:
```js
const testResult = await this._artisan(['test', '--stop-on-failure', '--compact']);
```

PHPUnit 9 (and most versions) does not have a `--compact` flag. This caused the test runner to fail with `Unknown option "--compact"` — but the error was not caught properly, so the validator reported tests as passing when they never actually ran.

**Fix**: Remove `'--compact'` from the args array. The correct call should be:
```js
const testResult = await this._artisan(['test', '--stop-on-failure']);
```

Also check that when PHPUnit exits with an error like "Unknown option", the validator correctly treats it as a failure (it should, since `result.ok` would be false, but verify this is the case — during the real run the report said tests were "FAILING" but validation "PASSED", which suggests the error handling may have a gap).

### Bug 3: 8->9 upgrade matrix incorrectly renames `$routeMiddleware` to `$middlewareAliases`

**Context**: The transformer agent renamed `$routeMiddleware` to `$middlewareAliases` in `app/Http/Kernel.php` during an 8->9 upgrade. This caused a runtime error: `Target class [guest] does not exist` — none of the middleware aliases (auth, guest, verified, etc.) were registered.

**Root cause**: `$middlewareAliases` was introduced in **Laravel 10**, not Laravel 9. Laravel 9's `Illuminate\Foundation\Http\Kernel` still uses `$routeMiddleware` internally (confirmed by grepping the vendor source — only `$routeMiddleware` appears, no `$middlewareAliases`).

**Where to fix**: `config/upgrade-matrix.js` in the 8->9 section. Look for any mention of `middlewareAliases` or `routeMiddleware` in the breaking changes / hints for the 8->9 upgrade. Either:
- Remove it from 8->9 entirely, OR
- Add it to 9->10 instead (where it belongs)

Also check the 9->10 section to make sure this rename IS listed there.

Additionally, check if the upgrade guide files under `config/upgrade-guides/` mention this. The transformer agent gets its instructions from both the matrix and the guide, so the incorrect hint may be in either place.

### Testing

After all fixes:
1. Run `npm test` — all 735+ tests should pass
2. Verify the upgrade matrix doesn't mention `middlewareAliases` in the 8->9 section
3. Verify the upgrade matrix DOES mention it in the 9->10 or 10->11 section

### Additional context

- The project uses AWS Bedrock as the API provider (not direct Anthropic)
- The `.shiftrc` in the project root has the current Bedrock config
- Check `CLAUDE.md` for full architecture documentation
- Do NOT add Co-Authored-By trailers to commits (user preference)
