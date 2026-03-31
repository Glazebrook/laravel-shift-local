# Laravel Shift Local — End-to-End Upgrade Validation

## Purpose

This prompt tests whether the upgrade tool ACTUALLY WORKS — not whether the code is bug-free (that's the audit skill's job), but whether running `shift upgrade` on a real Laravel project at version X produces a correctly upgraded project at version Y.

Think of it this way:
- **Audit skill** = "Is the engine built correctly?"
- **This prompt** = "Does the car actually drive from A to B?"

---

## System Context

You are running end-to-end validation of **Laravel Shift Local** (`shift`) — a Node.js CLI tool that automates Laravel framework upgrades. The tool is installed and available via the `shift` command (or `node bin/shift.js` if not globally installed).

**Requirements for this test harness:**
- PHP 8.2+ installed and available (`php --version`)
- Composer installed and available (`composer --version`)
- Git installed and available (`git --version`)
- Node.js 20+ installed and available (`node --version`)
- The `shift` command is available (or use `node bin/shift.js` as fallback)
- A valid `ANTHROPIC_API_KEY` is set in the environment
- Internet access for Composer to resolve dependencies

**CLI reference (from `shift --help`):**
```
shift upgrade --from=<version> --to=<version> [--path=<path>] [--verbose] [--fail-fast] [--dry-run]
shift resume [--path=<path>]
shift status [--path=<path>]
shift reset [--path=<path>]
shift rollback [--path=<path>]
```

---

## Pre-Flight

Run ALL of these. If ANY fails, stop and resolve before proceeding.

```bash
# 1. Verify dependencies
php --version           # Must be 8.2+
composer --version      # Must be installed
git --version           # Must be installed
node --version          # Must be 20+

# 2. Verify shift is available
shift --version 2>/dev/null || node bin/shift.js --version 2>/dev/null || echo "shift not found — run: npm link"

# 3. Determine the shift command to use for all tests
if command -v shift &>/dev/null; then
  SHIFT_CMD="shift"
elif [ -f bin/shift.js ]; then
  SHIFT_CMD="node bin/shift.js"
else
  echo "FATAL: Cannot find shift CLI"
  exit 1
fi
echo "Using: $SHIFT_CMD"

# 4. Verify API key
echo "ANTHROPIC_API_KEY is ${ANTHROPIC_API_KEY:+set}"
[ -z "$ANTHROPIC_API_KEY" ] && echo "FATAL: ANTHROPIC_API_KEY not set" && exit 1

# 5. Create test workspace (isolated from real projects)
export TEST_WORKSPACE="$HOME/shift-validation-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TEST_WORKSPACE"
cd "$TEST_WORKSPACE"
echo "Test workspace: $TEST_WORKSPACE"
```

```
PRE-FLIGHT: ✅ PASSED / ❌ FAILED — [reason]
Workspace: [path]
PHP: [version]
Composer: [version]
Node: [version]
shift: [version or path]
API key: set / NOT SET
═══════════════════════════════════════════════════
```

---

## Test Architecture

Each test follows this pattern:

```
1. CREATE    → Scaffold a real Laravel project at a specific version
2. SEED      → Add custom code that exercises upgrade edge cases
3. SNAPSHOT  → Record the pre-upgrade state (file hashes, test results, structure)
4. UPGRADE   → Run shift upgrade against the project
5. VERIFY    → Check every aspect of the upgraded project
6. REPORT    → Pass/fail with details
```

Run the tests in order. Each test is independent — a failure in Test 1 does not
block Test 2 (they use separate project directories).

---

## Test 1 — Laravel 10 → 11 Upgrade (Core Structural Changes)

This is the most complex upgrade path because Laravel 11 introduced a new application
structure (removed Kernel, simplified config, new bootstrap/app.php).

### 1.1 Create the Fixture Project

```bash
cd "$TEST_WORKSPACE"
mkdir test-10-to-11 && cd test-10-to-11

# Create a Laravel 10 project
composer create-project laravel/laravel:^10.0 . --prefer-dist --no-interaction

# Verify it's Laravel 10
php artisan --version
# Should output: Laravel Framework 10.x.x

# Initialise git (shift requires a git repo)
git init
git add -A
git commit -m "Initial Laravel 10 project"
```

### 1.2 Seed Custom Code (Edge Cases)

Add files that exercise specific upgrade scenarios. These are the things that
differentiate a good upgrade tool from a naive one.

**a) Custom middleware in Kernel.php:**
```bash
cat > app/Http/Middleware/TrackVisitor.php << 'PHP'
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class TrackVisitor
{
    public function handle(Request $request, Closure $next)
    {
        // Custom middleware that must survive the upgrade
        session(['last_visit' => now()]);
        return $next($request);
    }
}
PHP
```

Register it in the Kernel (Laravel 10 style):
```bash
# Add the middleware to the Kernel's $middleware array
php -r "
\$kernel = file_get_contents('app/Http/Kernel.php');
\$kernel = str_replace(
    \"\\\\Illuminate\\\\Foundation\\\\Http\\\\Middleware\\\\ValidatePostSize::class,\",
    \"\\\\Illuminate\\\\Foundation\\\\Http\\\\Middleware\\\\ValidatePostSize::class,\\n            \\\\App\\\\Http\\\\Middleware\\\\TrackVisitor::class,\",
    \$kernel
);
file_put_contents('app/Http/Kernel.php', \$kernel);
"
```

**b) Custom service provider with bindings:**
```bash
cat > app/Providers/CustomServiceProvider.php << 'PHP'
<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

class CustomServiceProvider extends ServiceProvider
{
    public function register()
    {
        $this->app->singleton('analytics', function ($app) {
            return new \stdClass();
        });
    }

    public function boot()
    {
        //
    }
}
PHP
```

Register in config/app.php providers array.

**c) Model with relationships, casts, and old-style Carbon usage:**
```bash
cat > app/Models/Post.php << 'PHP'
<?php

namespace App\Models;

use Carbon\Carbon;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Post extends Model
{
    use HasFactory;

    protected $table = 'posts';
    protected $fillable = ['title', 'content', 'published_at', 'user_id'];

    protected $casts = [
        'published_at' => 'datetime',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function scopePublished($query)
    {
        return $query->where('published_at', '<=', Carbon::now())
                     ->orderBy('created_at', 'desc');
    }
}
PHP
```

**d) Migration with class name (not anonymous):**
```bash
cat > database/migrations/2024_01_01_000001_create_posts_table.php << 'PHP'
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreatePostsTable extends Migration
{
    public function up()
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->string('title', 400);
            $table->longText('content');
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
        });
    }

    public function down()
    {
        Schema::dropIfExists('posts');
    }
}
PHP
```

**e) Route with controller reference:**
```bash
cat > routes/api.php << 'PHP'
<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\PostController;

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/posts', [PostController::class, 'index']);
    Route::post('/posts', [PostController::class, 'store']);
});
PHP
```

```bash
cat > app/Http/Controllers/PostController.php << 'PHP'
<?php

namespace App\Http\Controllers;

use App\Models\Post;
use Illuminate\Http\Request;

class PostController extends Controller
{
    public function index()
    {
        $posts = Post::published()->get();
        return response()->json($posts);
    }

    public function store(Request $request)
    {
        $validated = $request->validate([
            'title' => 'required|string|max:400',
            'content' => 'required|string',
        ]);

        $post = Post::create($validated);
        return response()->json($post, 201);
    }
}
PHP
```

**f) Debug call that should be caught by pre-processing:**
```bash
# Add a dd() call to a controller (should be removed by debug-calls transform)
php -r "
\$file = file_get_contents('app/Http/Controllers/PostController.php');
\$file = str_replace(
    'return response()->json(\$posts);',
    'dd(\$posts); // DEBUG - should be removed\n        return response()->json(\$posts);',
    \$file
);
file_put_contents('app/Http/Controllers/PostController.php', \$file);
"
```

**g) Validation rule as pipe-separated string (should become array):**
The store method already has `'required|string|max:400'` — this should be
converted to `['required', 'string', 'max:400']` by the rules-arrays transform.

### 1.3 Snapshot Pre-Upgrade State

```bash
# Record file structure
find app config routes database bootstrap -type f -name "*.php" | sort > /tmp/pre-upgrade-files.txt

# Record file hashes for change detection
find app config routes database bootstrap -type f -name "*.php" -exec md5sum {} \; | sort > /tmp/pre-upgrade-hashes.txt

# Record composer dependencies
composer show --direct > /tmp/pre-upgrade-deps.txt

# Verify PHP syntax
find app -name "*.php" -exec php -l {} \; 2>&1 | grep -v "No syntax errors"

# Git commit the seeded state
git add -A
git commit -m "Seed custom code for upgrade testing"

echo "Pre-upgrade snapshot captured"
```

### 1.4 Run the Upgrade

```bash
# Run the upgrade (versions specified via CLI flags — the authoritative method)
$SHIFT_CMD upgrade --from=10 --to=11 --verbose
```

**Wait for the upgrade to complete.** This will take several minutes as it calls
the Anthropic API for LLM-based transforms.

### 1.5 Verify the Upgrade

Run EVERY check below. Record pass/fail for each.

#### A. Structural Verification

```bash
echo "=== STRUCTURAL VERIFICATION ==="

# A1: Laravel version is now 11
php artisan --version
# EXPECTED: Laravel Framework 11.x.x
# PASS/FAIL: ___

# A2: Kernel.php should be REMOVED (Laravel 11 doesn't use it)
test -f app/Http/Kernel.php && echo "FAIL: Kernel.php still exists" || echo "PASS: Kernel.php removed"

# A3: bootstrap/app.php should be UPDATED (new middleware/exception format)
grep -q "withMiddleware" bootstrap/app.php && echo "PASS: New bootstrap format" || echo "FAIL: Old bootstrap format"

# A4: Custom middleware should be PRESERVED in bootstrap/app.php
grep -q "TrackVisitor" bootstrap/app.php && echo "PASS: Custom middleware migrated" || echo "FAIL: Custom middleware LOST"

# A5: Custom service provider should still be registered
grep -rq "CustomServiceProvider" bootstrap/app.php bootstrap/providers.php config/app.php 2>/dev/null && echo "PASS: Custom provider registered" || echo "FAIL: Custom provider LOST"

# A6: RouteServiceProvider should be handled
# (either removed with routes in bootstrap/app.php, or preserved if customised)
echo "Check: RouteServiceProvider handling — manual review"

# A7: Git branch should be the shift upgrade branch
BRANCH=$(git branch --show-current)
echo "Current branch: $BRANCH"
echo "$BRANCH" | grep -q "shift/upgrade-10-to-11" && echo "PASS: Correct branch" || echo "INFO: Branch name: $BRANCH"
```

#### B. Dependency Verification

```bash
echo "=== DEPENDENCY VERIFICATION ==="

# B1: composer.json requires Laravel 11
grep -q '"laravel/framework"' composer.json && grep -q '"\^11' composer.json && echo "PASS: Framework ^11" || echo "FAIL: Framework not ^11"

# B2: PHP requirement updated
grep -q '"php"' composer.json && grep -q '"\^8.2' composer.json && echo "PASS: PHP ^8.2" || echo "FAIL: PHP requirement not updated"

# B3: composer install succeeds
composer install --no-interaction 2>&1 | tail -5
echo "composer install exit code: $?"
# EXPECTED: 0

# B4: No dependency conflicts
composer validate --no-check-publish 2>&1
echo "composer validate exit code: $?"
```

#### C. Code Quality Verification

```bash
echo "=== CODE QUALITY VERIFICATION ==="

# C1: All PHP files have valid syntax
SYNTAX_ERRORS=$(find app config routes database bootstrap -name "*.php" -exec php -l {} \; 2>&1 | grep -c "Parse error")
echo "PHP syntax errors: $SYNTAX_ERRORS"
# EXPECTED: 0

# C2: Post model still has all relationships and scopes
grep -q "function user()" app/Models/Post.php && echo "PASS: user() relationship" || echo "FAIL: user() relationship LOST"
grep -q "function scopePublished" app/Models/Post.php && echo "PASS: scopePublished scope" || echo "FAIL: scopePublished LOST"

# C3: PostController still has both methods
grep -q "function index()" app/Http/Controllers/PostController.php && echo "PASS: index() method" || echo "FAIL: index() LOST"
grep -q "function store()" app/Http/Controllers/PostController.php && echo "PASS: store() method" || echo "FAIL: store() LOST"

# C4: Routes still defined
grep -q "posts" routes/api.php && echo "PASS: API routes present" || echo "FAIL: API routes LOST"
```

#### D. Pre-Processing Verification

These checks verify deterministic transforms ran correctly. Pre-processing runs
automatically (all transforms enabled by default except `declare-strict` and
`down-migration`).

```bash
echo "=== PRE-PROCESSING VERIFICATION ==="

# D1: Debug call removed (debug-calls transform, enabled by default)
grep -q "dd(\$posts)" app/Http/Controllers/PostController.php && echo "FAIL: dd() not removed" || echo "PASS: dd() removed"

# D2: Migration converted to anonymous class (anonymous-migrations transform)
grep -q "return new class extends Migration" database/migrations/2024_01_01_000001_create_posts_table.php && echo "PASS: Anonymous migration" || echo "FAIL: Still class-based migration"

# D3: Carbon import updated (laravel-carbon transform)
grep -q "use Illuminate\\\\Support\\\\Carbon" app/Models/Post.php && echo "PASS: Carbon import updated" || echo "INFO: Carbon import unchanged (may be correct if unused)"

# D4: Redundant $table removed from Post model (model-table transform — table follows convention)
grep -q 'protected \$table' app/Models/Post.php && echo "INFO: \$table still present (may be intentional)" || echo "PASS: Redundant \$table removed"

# D5: latest() used instead of orderBy('created_at', 'desc') (latest-oldest transform)
grep -q "->latest()" app/Models/Post.php && echo "PASS: latest() adopted" || echo "INFO: orderBy still used"

# D6: Validation rules as arrays (rules-arrays transform)
grep -q "\['required', 'string', 'max:400'\]" app/Http/Controllers/PostController.php && echo "PASS: Rules as arrays" || echo "INFO: Rules still pipe-separated"
```

#### E. Backups & Report Verification

```bash
echo "=== BACKUPS & REPORT VERIFICATION ==="

# E1: Shift report generated (written to project root, NOT .shift/)
test -f SHIFT_REPORT.md && echo "PASS: Report exists at project root" || echo "FAIL: No SHIFT_REPORT.md at project root"

# E2: Report contains expected sections
if [ -f SHIFT_REPORT.md ]; then
  grep -qi "summary" SHIFT_REPORT.md && echo "PASS: Executive summary section" || echo "INFO: No summary section"
  grep -qi "token\|cost\|usage" SHIFT_REPORT.md && echo "PASS: Token/cost section" || echo "INFO: No token section"
  grep -qi "manual\|review\|action" SHIFT_REPORT.md && echo "PASS: Manual review section" || echo "INFO: No manual review section"
fi

# E3: Backup directory exists with pre-modification copies
test -d .shift/backups && echo "PASS: Backup directory exists" || echo "FAIL: No backup directory"
BACKUP_COUNT=$(find .shift/backups -type f 2>/dev/null | wc -l)
echo "Backup files: $BACKUP_COUNT"
[ "$BACKUP_COUNT" -gt 0 ] && echo "PASS: Backups created" || echo "FAIL: No backup files"

# E4: State file exists
test -f .shift/state.json && echo "PASS: State file exists" || echo "FAIL: No state file"

# E5: Git log shows atomic commits per phase
echo "Git log:"
git log --oneline | head -20
# EXPECTED: Multiple commits, one per phase (analysis, pre-processing, planning, etc.)
```

#### F. Functional Verification

```bash
echo "=== FUNCTIONAL VERIFICATION ==="

# F1: Artisan commands work
php artisan list 2>&1 | head -5
echo "artisan list exit code: $?"

# F2: Route list works (proves routing is intact)
php artisan route:list 2>&1 | head -20
echo "route:list exit code: $?"

# F3: Migrate works (proves database structure is valid)
php artisan migrate --pretend 2>&1 | head -10
echo "migrate --pretend exit code: $?"
```

### 1.6 Record Results

```
═══════════════════════════════════════════════════
TEST 1 — LARAVEL 10 → 11 — RESULTS
═══════════════════════════════════════════════════

Structural:
  A1 Version detected as 11:        ✅ / ❌
  A2 Kernel.php removed:            ✅ / ❌
  A3 New bootstrap format:          ✅ / ❌
  A4 Custom middleware preserved:   ✅ / ❌
  A5 Custom provider registered:    ✅ / ❌
  A7 Correct git branch:            ✅ / ❌

Dependencies:
  B1 Framework ^11:                 ✅ / ❌
  B2 PHP ^8.2:                      ✅ / ❌
  B3 composer install succeeds:     ✅ / ❌
  B4 No conflicts:                  ✅ / ❌

Code Quality:
  C1 Zero syntax errors:            ✅ / ❌
  C2 Model relationships intact:    ✅ / ❌
  C3 Controller methods intact:     ✅ / ❌
  C4 Routes intact:                 ✅ / ❌

Pre-Processing:
  D1 Debug calls removed:           ✅ / ❌
  D2 Anonymous migrations:          ✅ / ❌
  D3 Carbon import:                 ✅ / ❌ / N/A
  D4 Redundant $table:              ✅ / ❌ / N/A
  D5 latest() adoption:             ✅ / ❌ / N/A
  D6 Rules as arrays:               ✅ / ❌ / N/A

Backups & Report:
  E1 Report at project root:        ✅ / ❌
  E2 Report sections complete:      ✅ / ❌
  E3 Backup directory populated:    ✅ / ❌
  E4 State file exists:             ✅ / ❌
  E5 Atomic git commits:            ✅ / ❌

Functional:
  F1 artisan list works:            ✅ / ❌
  F2 route:list works:              ✅ / ❌
  F3 migrate --pretend works:       ✅ / ❌

OVERALL: ✅ PASS / ❌ FAIL — [N] of [N] checks passed
═══════════════════════════════════════════════════
```

---

## Test 2 — Laravel 11 → 12 Upgrade (Dependency & Convention Changes)

### 2.1 Create the Fixture

```bash
cd "$TEST_WORKSPACE"
mkdir test-11-to-12 && cd test-11-to-12

composer create-project laravel/laravel:^11.0 . --prefer-dist --no-interaction
php artisan --version  # Should be 11.x.x

git init && git add -A && git commit -m "Initial Laravel 11 project"
```

### 2.2 Seed Custom Code

```bash
# Model with Carbon 2.x pattern (Carbon 3 required in Laravel 12)
cat > app/Models/Event.php << 'PHP'
<?php

namespace App\Models;

use Carbon\Carbon;
use Illuminate\Database\Eloquent\Model;

class Event extends Model
{
    protected $fillable = ['name', 'starts_at', 'ends_at'];

    protected $casts = [
        'starts_at' => 'datetime',
        'ends_at' => 'datetime',
    ];

    public function duration(): string
    {
        return Carbon::parse($this->starts_at)->diffForHumans($this->ends_at);
    }

    public function isUpcoming(): bool
    {
        return Carbon::parse($this->starts_at)->isFuture();
    }
}
PHP

# Controller with facade alias (should be converted to FQN)
cat > app/Http/Controllers/EventController.php << 'PHP'
<?php

namespace App\Http\Controllers;

use Cache;
use App\Models\Event;
use Illuminate\Http\Request;

class EventController extends Controller
{
    public function index()
    {
        $events = Cache::remember('events', 3600, function () {
            return Event::where('starts_at', '>', now())->get();
        });

        return response()->json($events);
    }
}
PHP

# Debug statement to test removal
cat > app/Services/EventNotifier.php << 'PHP'
<?php

namespace App\Services;

class EventNotifier
{
    public function notify($event)
    {
        dump($event); // DEBUG
        // Real notification logic would go here
        return true;
    }
}
PHP

git add -A && git commit -m "Seed custom code"
```

### 2.3 Snapshot, Upgrade, and Verify

```bash
# Snapshot
find app -type f -name "*.php" -exec md5sum {} \; | sort > /tmp/pre-upgrade-11-hashes.txt
composer show --direct > /tmp/pre-upgrade-11-deps.txt

# Run the upgrade
$SHIFT_CMD upgrade --from=11 --to=12 --verbose
```

### 2.4 Verify

```bash
echo "=== TEST 2 VERIFICATION ==="

# Version
php artisan --version  # Should be 12.x.x

# Carbon 3 compatibility (Carbon\Carbon should still work — it's the same package)
grep -q "use Carbon\\\\Carbon" app/Models/Event.php && echo "INFO: Carbon import preserved" || echo "INFO: Carbon import changed"

# Facade alias should be fully qualified (facade-aliases transform)
grep -q "use Illuminate\\\\Support\\\\Facades\\\\Cache" app/Http/Controllers/EventController.php && echo "PASS: Facade FQN" || echo "FAIL: Still using alias"

# Debug dump removed (debug-calls transform)
grep -q "dump(\$event)" app/Services/EventNotifier.php && echo "FAIL: dump() not removed" || echo "PASS: dump() removed"

# Dependencies
grep '"laravel/framework"' composer.json | grep -q '"\^12' && echo "PASS: Framework ^12" || echo "FAIL: Framework not ^12"
composer install --no-interaction 2>&1 | tail -3
php artisan list > /dev/null 2>&1 && echo "PASS: artisan works" || echo "FAIL: artisan broken"

# Syntax
ERRORS=$(find app -name "*.php" -exec php -l {} \; 2>&1 | grep -c "Parse error")
echo "Syntax errors: $ERRORS"

# Report at project root
test -f SHIFT_REPORT.md && echo "PASS: Report exists" || echo "FAIL: No report"

# Backups exist
test -d .shift/backups && echo "PASS: Backups exist" || echo "FAIL: No backups"

# Git branch
git branch --show-current
```

```
═══════════════════════════════════════════════════
TEST 2 — LARAVEL 11 → 12 — RESULTS
═══════════════════════════════════════════════════

  Version 12:                       ✅ / ❌
  Facade aliases resolved:          ✅ / ❌
  Debug calls removed:              ✅ / ❌
  Dependencies updated:             ✅ / ❌
  composer install succeeds:        ✅ / ❌
  artisan works:                    ✅ / ❌
  Zero syntax errors:               ✅ / ❌
  Custom models intact:             ✅ / ❌
  Custom controllers intact:        ✅ / ❌
  Report at project root:           ✅ / ❌
  Backups created:                  ✅ / ❌

OVERALL: ✅ PASS / ❌ FAIL
═══════════════════════════════════════════════════
```

---

## Test 3 — Multi-Version Jump: Laravel 9 → 11

This tests the tool's ability to handle a 2-version jump. The upgrade matrix
includes entries for 9→10 and 10→11. The planner uses `getCombinedMatrix()`
to chain the breaking changes from both steps.

### 3.1 Create and Seed

```bash
cd "$TEST_WORKSPACE"
mkdir test-9-to-11 && cd test-9-to-11

composer create-project laravel/laravel:^9.0 . --prefer-dist --no-interaction
php artisan --version  # Should be 9.x.x

git init && git add -A && git commit -m "Initial Laravel 9 project"

# Seed: old-style Faker property access (deprecated in 9, removed in 10)
cat > database/factories/PostFactory.php << 'PHP'
<?php

namespace Database\Factories;

use Illuminate\Database\Eloquent\Factories\Factory;

class PostFactory extends Factory
{
    public function definition()
    {
        return [
            'title' => $this->faker->sentence,
            'content' => $this->faker->paragraphs(3, true),
            'published_at' => $this->faker->dateTimeBetween('-1 year', 'now'),
        ];
    }
}
PHP

git add -A && git commit -m "Seed custom code"
```

### 3.2 Upgrade and Verify

```bash
# Run the multi-version upgrade
$SHIFT_CMD upgrade --from=9 --to=11 --verbose
```

```bash
echo "=== TEST 3 VERIFICATION ==="

# Version should be 11 (jumped over 10)
php artisan --version

# Faker methods should be calls not properties (faker-methods transform)
grep -q "faker->sentence()" database/factories/PostFactory.php && echo "PASS: Faker methods" || echo "CHECK: Faker syntax"

# All structural Laravel 11 changes should be present
test -f app/Http/Kernel.php && echo "FAIL: Kernel still exists" || echo "PASS: Kernel removed"
grep -q "withMiddleware" bootstrap/app.php && echo "PASS: New bootstrap" || echo "FAIL: Old bootstrap"

# Dependencies
composer install --no-interaction 2>&1 | tail -3
php artisan list > /dev/null 2>&1 && echo "PASS: artisan works" || echo "FAIL: artisan broken"

ERRORS=$(find app -name "*.php" -exec php -l {} \; 2>&1 | grep -c "Parse error")
echo "Syntax errors: $ERRORS"

# Report and backups
test -f SHIFT_REPORT.md && echo "PASS: Report exists" || echo "FAIL: No report"
test -d .shift/backups && echo "PASS: Backups exist" || echo "FAIL: No backups"
```

```
═══════════════════════════════════════════════════
TEST 3 — LARAVEL 9 → 11 (MULTI-VERSION) — RESULTS
═══════════════════════════════════════════════════

  Version 11:                       ✅ / ❌
  Faker methods converted:          ✅ / ❌
  Kernel removed:                   ✅ / ❌
  New bootstrap format:             ✅ / ❌
  Dependencies resolved:            ✅ / ❌
  artisan works:                    ✅ / ❌
  Zero syntax errors:               ✅ / ❌
  Report exists:                    ✅ / ❌
  Backups created:                  ✅ / ❌

OVERALL: ✅ PASS / ❌ FAIL
═══════════════════════════════════════════════════
```

---

## Test 4 — Rollback and Resume

Tests that the tool's safety mechanisms work: can we undo an upgrade, and can
we resume an interrupted one?

### 4.1 Rollback Test

```bash
cd "$TEST_WORKSPACE"
cp -r test-10-to-11 test-rollback
cd test-rollback

# Record current state
git log --oneline | head -5
INITIAL_COMMIT=$(git log --oneline | tail -1 | cut -d' ' -f1)
git diff --stat "$INITIAL_COMMIT"..HEAD

# Use shift rollback (reverts to pre-shift backup tag)
$SHIFT_CMD rollback 2>&1
echo "rollback exit code: $?"

# Verify we're back to pre-upgrade state
php artisan --version  # Should be back to 10.x.x
echo "Rollback: $(php artisan --version 2>&1 | grep -o '[0-9]*\.[0-9]*\.[0-9]*')"

# Verify Kernel.php is restored (Laravel 10 has Kernel.php)
test -f app/Http/Kernel.php && echo "PASS: Kernel.php restored" || echo "FAIL: Kernel.php missing after rollback"
```

### 4.2 Resume Test

```bash
cd "$TEST_WORKSPACE"
mkdir test-resume && cd test-resume

composer create-project laravel/laravel:^10.0 . --prefer-dist --no-interaction
git init && git add -A && git commit -m "Initial Laravel 10"

# Run with very low token limit — should pause after a few steps
# maxTotalTokens must be >= 10000 (validated by the tool) and lives under behaviour
cat > .shiftrc << 'JSON'
{
  "shift": { "fromVersion": "10", "toVersion": "11" },
  "behaviour": { "maxTotalTokens": 10000 }
}
JSON

# Run upgrade — will pause when token budget exhausted
timeout 300 $SHIFT_CMD upgrade --from=10 --to=11 2>&1 || true

# Check if state was saved
test -d .shift && echo "PASS: State directory exists" || echo "FAIL: No state directory"
test -f .shift/state.json && echo "PASS: State file exists" || echo "FAIL: No state file"

# Check state content
if [ -f .shift/state.json ]; then
  cat .shift/state.json | python3 -m json.tool 2>/dev/null | head -20 || cat .shift/state.json | head -20
  echo "State file found — resume should work"
fi

# Increase token limit and resume
cat > .shiftrc << 'JSON'
{
  "shift": { "fromVersion": "10", "toVersion": "11" },
  "behaviour": { "maxTotalTokens": 500000 }
}
JSON

# Resume from where we left off
$SHIFT_CMD resume 2>&1

# Verify it completed
php artisan --version
```

```
═══════════════════════════════════════════════════
TEST 4 — ROLLBACK & RESUME — RESULTS
═══════════════════════════════════════════════════

Rollback:
  Git history intact:               ✅ / ❌
  Reset to pre-upgrade:             ✅ / ❌
  Kernel.php restored:              ✅ / ❌
  artisan works after rollback:     ✅ / ❌

Resume:
  State file created on pause:      ✅ / ❌
  Resume completes upgrade:         ✅ / ❌
  No duplicate work on resume:      ✅ / ❌
  artisan works after resume:       ✅ / ❌

OVERALL: ✅ PASS / ❌ FAIL
═══════════════════════════════════════════════════
```

---

## Test 5 — Edge Cases & Error Handling

### 5.1 Empty Project (Minimal Laravel)

```bash
cd "$TEST_WORKSPACE"
mkdir test-minimal && cd test-minimal

composer create-project laravel/laravel:^10.0 . --prefer-dist --no-interaction
# Remove all custom code — just the skeleton
rm -rf app/Models/User.php  # Keep only bare minimum

git init && git add -A && git commit -m "Minimal Laravel 10"

# Run upgrade
$SHIFT_CMD upgrade --from=10 --to=11 --verbose

# Should complete without errors even with minimal code
php artisan --version
echo "Minimal project exit code: $?"
test -f SHIFT_REPORT.md && echo "PASS: Report generated" || echo "FAIL: No report"
```

### 5.2 Non-Laravel Project (Should Fail Gracefully)

```bash
cd "$TEST_WORKSPACE"
mkdir test-not-laravel && cd test-not-laravel
git init

echo '{"name":"not-laravel","require":{"php":"^8.1"}}' > composer.json
git add -A && git commit -m "Not a Laravel project"

# Should fail gracefully with a clear error message
$SHIFT_CMD upgrade --from=10 --to=11 2>&1
EXIT_CODE=$?
echo "Non-Laravel exit code: $EXIT_CODE"
# EXPECTED: Non-zero exit code, clear error message, no crash/stack trace
[ "$EXIT_CODE" -ne 0 ] && echo "PASS: Non-zero exit" || echo "FAIL: Should have failed"
```

### 5.3 Already Up-to-Date

```bash
cd "$TEST_WORKSPACE"
mkdir test-already-current && cd test-already-current

composer create-project laravel/laravel:^11.0 . --prefer-dist --no-interaction
git init && git add -A && git commit -m "Already Laravel 11"

# Should detect already at target version and exit cleanly
$SHIFT_CMD upgrade --from=11 --to=11 2>&1
EXIT_CODE=$?
echo "Already-current exit code: $EXIT_CODE"
# EXPECTED: Should detect already at target version and exit cleanly
```

### 5.4 Dry Run (No Mutations)

```bash
cd "$TEST_WORKSPACE"
mkdir test-dry-run && cd test-dry-run

composer create-project laravel/laravel:^10.0 . --prefer-dist --no-interaction
git init && git add -A && git commit -m "Initial Laravel 10"

# Dry run should analyse and plan but not modify code or dependencies
PRE_HASH=$(git rev-parse HEAD)
$SHIFT_CMD upgrade --from=10 --to=11 --dry-run --verbose 2>&1
POST_HASH=$(git rev-parse HEAD)

# Verify no commits were made during dry run (beyond pre-processing and conformity)
echo "Pre: $PRE_HASH"
echo "Post: $POST_HASH"

# Verify composer.json NOT modified (dependencies phase skipped in dry-run)
grep -q '"laravel/framework": "\^10' composer.json && echo "PASS: Dependencies unchanged" || echo "FAIL: Dependencies modified in dry-run"

# Verify artisan still works with original version
php artisan --version  # Should still be 10.x.x
```

### 5.5 .shiftrc Config Validation

```bash
cd "$TEST_WORKSPACE"
mkdir test-bad-config && cd test-bad-config

composer create-project laravel/laravel:^10.0 . --prefer-dist --no-interaction
git init && git add -A && git commit -m "Initial Laravel 10"

# Test with malformed .shiftrc — should warn and use defaults, not crash
echo 'THIS IS NOT JSON' > .shiftrc
$SHIFT_CMD upgrade --from=10 --to=11 --verbose 2>&1 | head -5
# EXPECTED: Warning about .shiftrc parse error, not a crash

# Test with --no-rc flag (ignores .shiftrc entirely)
$SHIFT_CMD upgrade --from=10 --to=11 --no-rc --dry-run --verbose 2>&1 | head -10
echo "no-rc exit code: $?"
```

```
═══════════════════════════════════════════════════
TEST 5 — EDGE CASES — RESULTS
═══════════════════════════════════════════════════

  Minimal project upgrades:         ✅ / ❌
  Non-Laravel fails gracefully:     ✅ / ❌
  Already-current detected:         ✅ / ❌
  Dry run makes no mutations:       ✅ / ❌
  Bad .shiftrc warns, not crash:    ✅ / ❌
  --no-rc flag works:               ✅ / ❌
  No crashes on any edge case:      ✅ / ❌

OVERALL: ✅ PASS / ❌ FAIL
═══════════════════════════════════════════════════
```

---

## Final Summary

After all tests complete, compile the full results:

```
═══════════════════════════════════════════════════
LARAVEL SHIFT LOCAL — END-TO-END VALIDATION REPORT
═══════════════════════════════════════════════════
Date: [today]
Tool version: [shift --version output]
PHP version: [php --version]
Node version: [node --version]
Test workspace: [path]

Test 1 — Laravel 10 → 11:      ✅ PASS / ❌ FAIL  ([N]/[N] checks)
Test 2 — Laravel 11 → 12:      ✅ PASS / ❌ FAIL  ([N]/[N] checks)
Test 3 — Laravel 9 → 11 multi: ✅ PASS / ❌ FAIL  ([N]/[N] checks)
Test 4 — Rollback & Resume:    ✅ PASS / ❌ FAIL  ([N]/[N] checks)
Test 5 — Edge Cases:           ✅ PASS / ❌ FAIL  ([N]/[N] checks)

Total checks: [N]
Passed: [N]
Failed: [N]

Critical failures (blocks production use):
  [list any failures in structural, dependency, or functional verification]

Non-critical issues (cosmetic or optional transforms):
  [list any failures in pre-processing verification]

Token cost across all tests:
  [total tokens used — check SHIFT_REPORT.md in each test project]

Recommendation:
  ✅ READY FOR PRODUCTION USE
  ⚠️ READY WITH CAVEATS — [list what to watch for]
  ❌ NOT READY — [list blocking issues]
═══════════════════════════════════════════════════
```

### Cleanup

```bash
# Remove test workspace when done (or keep for debugging)
echo "Test workspace at: $TEST_WORKSPACE"
echo "Run 'rm -rf $TEST_WORKSPACE' to clean up"
```

---

## Global Rules

1. **Each test is independent** — a failure in one does not skip others
2. **Real projects only** — no mocking, no simulation. Real Composer, real PHP, real API calls
3. **Verify everything** — structure, dependencies, syntax, functionality, reports, backups
4. **Record exact output** — don't summarise, capture the actual verification output
5. **Token costs are real** — these tests call the Anthropic API. Budget accordingly
6. **Clean workspace** — each test gets its own directory, no cross-contamination
7. **Stop-on-crash only** — if shift crashes (non-graceful exit), that's a test failure worth investigating immediately. Graceful errors are expected in edge case tests
8. **Use CLI flags for versions** — always pass `--from` and `--to` explicitly. Do not rely solely on `.shiftrc` for version selection in test scenarios
9. **Check backups** — every test should verify `.shift/backups/` exists and contains files. This is the safety net for production use
10. **Check report location** — the report is `SHIFT_REPORT.md` at the project root, not inside `.shift/`

---

## Begin

Run **Pre-Flight** now. Verify PHP, Composer, Git, Node, shift, and API key. Then start **Test 1 — Laravel 10 → 11**.
