# Laravel Shift Local

> Automated Laravel upgrades powered by a **Claude multi-agent pipeline** — runs entirely in your terminal via VS Code + Claude Code, with no external service required.

Mirrors the functionality of [laravelshift.com](https://laravelshift.com) but runs on your machine, against your local codebase, using the Anthropic API directly.

---

## Features

- **Multi-agent orchestration** — Opus for analysis/planning, Sonnet for execution
- **Resumable upgrades** — interrupt at any point, pick up exactly where you left off
- **Git-safe** — works on a dedicated branch, commits each phase atomically
- **File-level checkpointing** — each file tracked individually, failed files retried up to 3×
- **Full backup** — every modified file backed up before changes
- **Laravel Boost integration** — uses Laravel's own MCP tools for deeper codebase understanding
- **SHIFT_REPORT.md** — full post-upgrade report with manual review items and Claude prompts
- **Claude Code slash commands** — `/shift-upgrade`, `/shift-status`, `/shift-fix-file`, `/shift-review`

## Supported upgrade paths

| From | To | Complexity |
|------|----|------------|
| 8.x | 9.x | Medium |
| 9.x | 10.x | Medium |
| 10.x | 11.x | **High** (slim skeleton) |
| 11.x | 12.x | Low |
| 12.x | 13.x | Low |
| Multi-version | e.g. 9→11 | Analyzed per step |

---

## Requirements

- **Node.js 20+**
- **PHP 8.x** (matching your project)
- **Composer** installed globally
- **Git** repository (the project being upgraded must be a git repo)
- **ANTHROPIC_API_KEY** environment variable

---

## Installation

### Option A: Install globally (recommended)

```bash
# Clone this repo somewhere permanent
git clone https://github.com/your-org/laravel-shift-local.git ~/tools/laravel-shift-local
cd ~/tools/laravel-shift-local

# Install dependencies
npm install

# Link globally so you can run `shift` from anywhere
npm link
```

### Option B: Use from project directory

```bash
# Copy into your project or a tools directory
cd /path/to/laravel-shift-local
npm install

# Run with node directly
node bin/shift.js upgrade --from=10 --to=11 --path=/var/www/myapp
```

### Set your API key

```bash
# Add to your shell profile (.bashrc, .zshrc, etc.)
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Usage

### Basic upgrade

```bash
# Upgrade the project in the current directory
shift upgrade --from=10 --to=11

# Upgrade a specific project path
shift upgrade --from=10 --to=11 --path=/var/www/my-laravel-app

# With verbose output
shift upgrade --from=9 --to=11 --verbose
```

### Resume after interruption

```bash
# In the project directory
shift resume

# Or with a path
shift resume --path=/var/www/my-laravel-app
```

### Check status

```bash
shift status
shift status --path=/var/www/my-laravel-app
```

### Reset state (start over)

```bash
shift reset
# NOTE: This clears the state file but does NOT revert code changes.
# To also revert code: git checkout main && git branch -D shift/upgrade-X-to-Y
```

---

## Using with Claude Code (VS Code)

This project includes slash commands for use inside Claude Code.

### Setup

1. Open your Laravel project in VS Code
2. Copy the `.claude/commands/` directory from this repo into your Laravel project's `.claude/commands/`
3. Open Claude Code

### Available slash commands

| Command | Description |
|---------|-------------|
| `/shift-upgrade` | Run the full upgrade pipeline |
| `/shift-status` | Show current upgrade status |
| `/shift-fix-file <path>` | Retry a failed file manually |
| `/shift-review` | Review and action the SHIFT_REPORT.md |

---

## Using with Laravel Boost

[Laravel Boost](https://laravel.com/ai/boost) provides Laravel-specific MCP tools (database schema, routes, artisan, logs, etc.) that dramatically improve the quality of AI-assisted code changes.

### Setup Laravel Boost in your project

```bash
# In your Laravel project
composer require laravel/boost --dev
php artisan boost:install
```

Then in VS Code / Claude Code settings, enable the `laravel-boost` MCP server.

The Shift agents automatically use Boost tools when available — they'll query your actual routes, database schema, and config values rather than guessing from file content alone.

---

## How it works

```
Your Project
     │
     ▼
┌─────────────────────────────────────────────────────┐
│                   ORCHESTRATOR                        │
│  (State machine — INIT→ANALYZING→...→COMPLETE)       │
│  Checkpoints every phase to .shift/state.json        │
└─────────┬─────────────────────────────────────────────┘
          │
    ┌─────┼──────────────────────────────────┐
    ▼     ▼     ▼       ▼         ▼          ▼
 Analyzer Planner Dependency Transformer Validator Reporter
 (Opus)  (Opus)  (Sonnet)  (Sonnet)    (Sonnet) (Sonnet)
    │
    └── Uses Anthropic tool use to actually read/write your files
```

### Phase details

| Phase | Agent | What happens |
|-------|-------|-------------|
| ANALYZING | AnalyzerAgent (Opus) | Reads composer.json, config, routes, models. Produces structured analysis. |
| PLANNING | PlannerAgent (Opus) | Creates ordered list of every change needed. Files assigned priorities. |
| DEPENDENCIES | DependencyAgent (Sonnet) | Updates composer.json, runs `composer update`. |
| TRANSFORMING | TransformerAgent (Sonnet) | Applies changes file-by-file. Each file checkpointed. Commits batch. |
| VALIDATING | ValidatorAgent (Sonnet) | PHP syntax check on all files. Runs `artisan config:clear`, `route:list`. Optionally runs test suite. Auto-fixes syntax errors it can. |
| REPORTING | ReporterAgent (Sonnet) | Generates SHIFT_REPORT.md with full summary, manual review items, and copy-paste Claude prompts. |

---

## Output files

After a successful run, you'll find:

```
your-laravel-project/
├── SHIFT_REPORT.md          ← Full upgrade report + manual review items
└── .shift/
    ├── state.json           ← Complete upgrade state (for resuming)
    ├── shift.log            ← Detailed log of all agent activity
    └── backups/             ← Backup of every modified file
```

---

## Configuration (.shiftrc)

Place a `.shiftrc` file in your Laravel project root to configure behaviour:

```json
{
  "behaviour": {
    "failFast": false,
    "maxFileRetries": 3,
    "runTests": true,
    "verbose": false
  },
  "exclude": {
    "paths": ["vendor", "node_modules", "storage"],
    "filePatterns": ["*.min.js"]
  },
  "models": {
    "analyzer": "claude-opus-4-6",
    "planner": "claude-opus-4-6",
    "transformer": "claude-sonnet-4-6"
  }
}
```

---

## Troubleshooting

### "ANTHROPIC_API_KEY not set"
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# Or add to your .bashrc/.zshrc
```

### "Project must be a git repository"
```bash
cd /path/to/your/laravel/project
git init
git add -A
git commit -m "Initial commit before shift upgrade"
```

### "composer update failed"
The dependency agent will try `--ignore-platform-reqs` automatically. If it still fails, manually resolve conflicts then run `shift resume`.

### Agent timed out / API error
All API calls retry automatically (3× with exponential backoff). If the entire phase fails, run `shift resume` — it picks up from the last checkpointed file.

### File transform failed
```bash
# See which files failed
shift status

# Try to fix manually, then mark as done in .shift/state.json
# Or use the Claude Code slash command:
# /shift-fix-file app/Http/Kernel.php
```

---

## Troubleshooting

### API key expires or is rotated mid-run

If your `ANTHROPIC_API_KEY` is revoked or rotated while an upgrade is running, agent calls will fail with an authentication error. The pipeline will report this clearly and stop. To recover:

1. Set the new key: `export ANTHROPIC_API_KEY=sk-ant-...`
2. Resume: `shift resume --path=/your/project`

### Corrupted state file

If `.shift/state.json` is manually edited or corrupted (e.g. by a disk error or interrupted write), `shift resume` will report the specific missing field. To recover:

- If the corruption is minor, fix the JSON manually.
- Otherwise, run `shift reset` and start again. Your code changes on the upgrade branch are preserved in git.

### `composer update` fails or hangs

The dependency agent runs `composer update` with a configurable timeout (default 600s). If composer hangs:

1. Kill the process (`Ctrl+C` — state is saved on SIGINT).
2. Fix the composer issue manually (e.g. resolve conflicts, update `composer.json`).
3. Resume: `shift resume` — the dependency phase will retry.

To increase the timeout, add to `.shiftrc`: `{ "composerTimeout": 1200 }`

### An agent makes a bad transformation

Each file is committed individually. To revert a single file:

1. Check the git log: `git log --oneline` on the upgrade branch.
2. Revert the specific file: `git checkout HEAD~N -- path/to/file.php`
3. Or use the backup: files are backed up in `.shift/backups/` before modification.

### Full rollback

To undo the entire upgrade and return to the pre-upgrade state:

```bash
shift rollback --path=/your/project
```

This resets to the backup tag created before the upgrade started.

### Retry counters exhausted on resume

If a phase or file failed and hit the retry limit, then you fix the underlying issue:

```bash
shift resume --reset-retries --path=/your/project
```

This resets all retry counters without clearing state, giving every failed phase/file a fresh set of attempts.

### Security review of `.shiftrc`

The `.shiftrc` file controls model selection, timeouts, retry counts, and git behaviour. In shared repositories, review `.shiftrc` changes in PRs — a malicious commit could set expensive models or extreme retry counts. Use `--no-rc` to ignore it entirely:

```bash
shift upgrade --from=10 --to=11 --no-rc
```

---

## Architecture notes

- **Agentic loop**: Each agent runs a full `while (hasToolCalls)` loop with a 25-round safety limit
- **Context efficiency**: Agents receive only what they need — no full codebase dumped into context
- **Per-file isolation**: Each file transformation is an independent agent call — failures don't cascade
- **Deterministic ordering**: Critical files always transform before medium/low priority ones
- **Git atomicity**: Each phase is a separate commit, so you can `git revert` any single phase

---

## License

MIT — use freely in commercial projects.
