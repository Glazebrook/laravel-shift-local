/**
 * Tests for deterministic pre-processing transforms
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Import transforms
import anonymousMigrations from '../src/transforms/anonymous-migrations.js';
import classStrings from '../src/transforms/class-strings.js';
import debugCalls from '../src/transforms/debug-calls.js';
import declareStrict from '../src/transforms/declare-strict.js';
import facadeAliases from '../src/transforms/facade-aliases.js';
import fakerMethods from '../src/transforms/faker-methods.js';
import rulesArrays from '../src/transforms/rules-arrays.js';
import modelTable from '../src/transforms/model-table.js';
import latestOldest from '../src/transforms/latest-oldest.js';
import explicitOrderby from '../src/transforms/explicit-orderby.js';
import downMigration from '../src/transforms/down-migration.js';
import laravelCarbon from '../src/transforms/laravel-carbon.js';
import { getApplicableTransforms, transforms } from '../src/transforms/index.js';
import { runPreProcessing, generatePreProcessingSummary } from '../src/pre-processor.js';
import l11Structural, {
  extractCustomMiddleware,
  extractCustomMiddlewareGroups,
  extractCustomMiddlewareAliases,
  extractCustomExceptionHandling,
  extractCustomProviders,
  generateBootstrapApp,
  addApiRouting,
  generateProvidersFile,
  isDefaultMiddlewareStub,
  isDefaultProviderStub,
} from '../src/transforms/l11-structural.js';
import { existsSync } from 'node:fs';

// ─── Anonymous Migrations ────────────────────────────────

describe('Transform: anonymous-migrations', () => {
  it('detects class-based migrations', () => {
    const php = `<?php\nclass CreateUsersTable extends Migration\n{\n}`;
    assert.ok(anonymousMigrations.detect(php));
  });

  it('does not detect anonymous migrations', () => {
    const php = `<?php\nreturn new class extends Migration\n{\n};`;
    assert.ok(!anonymousMigrations.detect(php));
  });

  it('converts class to anonymous class', () => {
    const php = `<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\n\nclass CreateUsersTable extends Migration\n{\n    public function up()\n    {\n    }\n}\n`;
    const result = anonymousMigrations.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('return new class extends Migration'));
    assert.ok(!result.content.includes('class CreateUsersTable'));
  });

  it('adds semicolon after closing brace', () => {
    const php = `<?php\nclass Foo extends Migration\n{\n}\n`;
    const result = anonymousMigrations.transform(php);
    assert.ok(result.content.includes('};'));
  });

  it('returns unchanged for already-anonymous', () => {
    const php = `<?php\nreturn new class extends Migration\n{\n};`;
    const result = anonymousMigrations.transform(php);
    assert.ok(!result.changed);
  });
});

// ─── Class Strings ───────────────────────────────────────

describe('Transform: class-strings', () => {
  it('detects string class references', () => {
    const php = `$model = 'App\\Models\\User';`;
    assert.ok(classStrings.detect(php));
  });

  it('does not detect non-namespaced strings', () => {
    const php = `$name = 'some string';`;
    assert.ok(!classStrings.detect(php));
  });

  it('converts string to ::class syntax', () => {
    const php = `$model = 'App\\Models\\User';\n$other = "App\\Http\\Controllers\\HomeController";`;
    const result = classStrings.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('\\App\\Models\\User::class'));
  });

  it('skips strings that are array keys', () => {
    const php = `'App\\Models\\User' => 'something'`;
    const result = classStrings.transform(php);
    assert.ok(!result.changed);
  });
});

// ─── Debug Calls ─────────────────────────────────────────

describe('Transform: debug-calls', () => {
  it('detects dd() calls', () => {
    const php = `dd($variable);`;
    assert.ok(debugCalls.detect(php));
  });

  it('detects dump() calls', () => {
    const php = `    dump($foo);`;
    assert.ok(debugCalls.detect(php));
  });

  it('detects var_dump() calls', () => {
    const php = `var_dump($bar);`;
    assert.ok(debugCalls.detect(php));
  });

  it('does not detect logger() calls', () => {
    const php = `logger('message');`;
    assert.ok(!debugCalls.detect(php));
  });

  it('removes standalone debug calls', () => {
    const php = `<?php\n$x = 1;\ndd($x);\n$y = 2;\n`;
    const result = debugCalls.transform(php);
    assert.ok(result.changed);
    assert.ok(!result.content.includes('dd('));
    assert.ok(result.content.includes('$x = 1'));
    assert.ok(result.content.includes('$y = 2'));
  });

  it('removes multiple debug calls', () => {
    const php = `<?php\nvar_dump($a);\nprint_r($b);\nray($c);\n`;
    const result = debugCalls.transform(php);
    assert.ok(result.changed);
    assert.equal(result.description, 'Removed 3 debug call(s)');
  });

  it('does not remove non-debug code', () => {
    const php = `<?php\n$result = $service->process();\n`;
    const result = debugCalls.transform(php);
    assert.ok(!result.changed);
  });
});

// ─── Declare Strict ──────────────────────────────────────

describe('Transform: declare-strict', () => {
  it('detects files without strict_types', () => {
    const php = `<?php\n\nnamespace App;\n`;
    assert.ok(declareStrict.detect(php));
  });

  it('does not detect files with strict_types', () => {
    const php = `<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n`;
    assert.ok(!declareStrict.detect(php));
  });

  it('adds declare(strict_types=1) after <?php', () => {
    const php = `<?php\n\nnamespace App;\n`;
    const result = declareStrict.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('declare(strict_types=1);'));
    assert.ok(result.content.indexOf('declare(strict_types=1)') > result.content.indexOf('<?php'));
  });

  it('does not duplicate existing declaration', () => {
    const php = `<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n`;
    const result = declareStrict.transform(php);
    assert.ok(!result.changed);
  });

  it('is disabled by default', () => {
    assert.equal(declareStrict.defaultEnabled, false);
  });
});

// ─── Facade Aliases ──────────────────────────────────────

describe('Transform: facade-aliases', () => {
  it('detects global facade aliases', () => {
    const php = `<?php\n\nuse Cache;\n`;
    assert.ok(facadeAliases.detect(php));
  });

  it('does not detect fully qualified facades', () => {
    const php = `<?php\n\nuse Illuminate\\Support\\Facades\\Cache;\n`;
    assert.ok(!facadeAliases.detect(php));
  });

  it('replaces alias with FQN', () => {
    const php = `<?php\n\nuse Cache;\nuse Auth;\n`;
    const result = facadeAliases.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('use Illuminate\\Support\\Facades\\Cache;'));
    assert.ok(result.content.includes('use Illuminate\\Support\\Facades\\Auth;'));
  });

  it('leaves non-facade imports alone', () => {
    const php = `<?php\n\nuse App\\Models\\User;\nuse Cache;\n`;
    const result = facadeAliases.transform(php);
    assert.ok(result.content.includes('use App\\Models\\User;'));
    assert.ok(result.content.includes('use Illuminate\\Support\\Facades\\Cache;'));
  });
});

// ─── Faker Methods ───────────────────────────────────────

describe('Transform: faker-methods', () => {
  it('detects Faker property access', () => {
    const php = `$faker->name`;
    assert.ok(fakerMethods.detect(php));
  });

  it('does not detect Faker method calls', () => {
    const php = `$faker->name()`;
    assert.ok(!fakerMethods.detect(php));
  });

  it('converts property to method call', () => {
    const php = `$faker->name`;
    const result = fakerMethods.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('$faker->name()'));
  });

  it('handles $this->faker syntax', () => {
    const php = `$this->faker->email`;
    const result = fakerMethods.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('$this->faker->email()'));
  });

  it('does not double-add parens to existing methods', () => {
    const php = `$faker->name()`;
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
  });

  it('does not break compound method names like paragraphs(3, true)', () => {
    const php = `'content' => $this->faker->paragraphs(3, true),`;
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
    assert.equal(result.content, php);
  });

  it('does not break dateTimeBetween method calls', () => {
    const php = `$this->faker->dateTimeBetween('-1 year', 'now')`;
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
    assert.equal(result.content, php);
  });

  it('does not break sentences method calls with arguments', () => {
    const php = `$this->faker->sentences(5)`;
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
    assert.equal(result.content, php);
  });

  it('does not break randomElement method calls', () => {
    const php = `$this->faker->randomElement(['a', 'b'])`;
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
    assert.equal(result.content, php);
  });

  it('transforms property access next to method calls in same file', () => {
    const php = `$this->faker->name, $this->faker->paragraphs(3, true)`;
    const result = fakerMethods.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('$this->faker->name()'));
    assert.ok(result.content.includes('$this->faker->paragraphs(3, true)'));
  });

  it('handles unique() and optional() chained with property access', () => {
    const php = `$this->faker->unique()->email`;
    // unique() returns a proxy — the property after it is still on faker
    // This specific pattern doesn't match our regex (unique()->email is not faker->email)
    const result = fakerMethods.transform(php);
    assert.ok(!result.changed);
  });

  it('applies from version 9+', () => {
    assert.equal(fakerMethods.appliesFrom, '9');
  });
});

// ─── Rules Arrays ────────────────────────────────────────

describe('Transform: rules-arrays', () => {
  it('detects pipe-delimited rules', () => {
    const php = `'name' => 'required|string|max:255'`;
    assert.ok(rulesArrays.detect(php));
  });

  it('does not detect array rules', () => {
    const php = `'name' => ['required', 'string', 'max:255']`;
    assert.ok(!rulesArrays.detect(php));
  });

  it('converts pipe rules to arrays', () => {
    const php = `'name' => 'required|string|max:255'`;
    const result = rulesArrays.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes("['required', 'string', 'max:255']"));
  });
});

// ─── Model Table ─────────────────────────────────────────

describe('Transform: model-table', () => {
  it('detects $table property', () => {
    const php = `protected $table = 'users';`;
    assert.ok(modelTable.detect(php));
  });

  it('removes redundant $table when it matches convention', () => {
    const php = `<?php\n\nclass User extends Model\n{\n    protected $table = 'users';\n}\n`;
    const result = modelTable.transform(php, 'app/Models/User.php');
    assert.ok(result.changed);
    assert.ok(!result.content.includes('$table'));
  });

  it('keeps $table when it does NOT match convention', () => {
    const php = `<?php\n\nclass User extends Model\n{\n    protected $table = 'custom_users';\n}\n`;
    const result = modelTable.transform(php, 'app/Models/User.php');
    assert.ok(!result.changed);
  });

  it('handles pluralisation for Category -> categories', () => {
    const php = `<?php\n\nclass Category extends Model\n{\n    protected $table = 'categories';\n}\n`;
    const result = modelTable.transform(php, 'app/Models/Category.php');
    assert.ok(result.changed);
  });
});

// ─── Latest/Oldest ───────────────────────────────────────

describe('Transform: latest-oldest', () => {
  it('detects orderBy created_at desc', () => {
    const php = `->orderBy('created_at', 'desc')`;
    assert.ok(latestOldest.detect(php));
  });

  it('replaces with latest()', () => {
    const php = `$query->orderBy('created_at', 'desc')`;
    const result = latestOldest.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('->latest()'));
  });

  it('replaces asc with oldest()', () => {
    const php = `$query->orderBy('created_at', 'asc')`;
    const result = latestOldest.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('->oldest()'));
  });
});

// ─── Explicit OrderBy ────────────────────────────────────

describe('Transform: explicit-orderby', () => {
  it('detects orderBy with desc on non-created_at columns', () => {
    const php = `->orderBy('name', 'desc')`;
    assert.ok(explicitOrderby.detect(php));
  });

  it('does not detect orderBy on created_at (handled by latest-oldest)', () => {
    const php = `->orderBy('created_at', 'desc')`;
    assert.ok(!explicitOrderby.detect(php));
  });

  it('replaces with orderByDesc()', () => {
    const php = `$query->orderBy('name', 'desc')`;
    const result = explicitOrderby.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes("->orderByDesc('name')"));
  });
});

// ─── Down Migration ──────────────────────────────────────

describe('Transform: down-migration', () => {
  it('detects down() method', () => {
    const php = `public function down()\n{\n}`;
    assert.ok(downMigration.detect(php));
  });

  it('removes down() method', () => {
    const php = `<?php\nclass Mig {\n    public function up()\n    {\n        // up\n    }\n\n    public function down()\n    {\n        // down\n    }\n}\n`;
    const result = downMigration.transform(php);
    assert.ok(result.changed);
    assert.ok(!result.content.includes('function down'));
    assert.ok(result.content.includes('function up'));
  });

  it('is disabled by default', () => {
    assert.equal(downMigration.defaultEnabled, false);
  });
});

// ─── Laravel Carbon ──────────────────────────────────────

describe('Transform: laravel-carbon', () => {
  it('detects Carbon\\Carbon usage', () => {
    const php = `use Carbon\\Carbon;`;
    assert.ok(laravelCarbon.detect(php));
  });

  it('replaces use statement', () => {
    const php = `<?php\n\nuse Carbon\\Carbon;\n`;
    const result = laravelCarbon.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('use Illuminate\\Support\\Carbon;'));
    assert.ok(!result.content.includes('use Carbon\\Carbon'));
  });

  it('replaces inline references', () => {
    const php = `<?php\nuse Carbon\\Carbon;\n$now = Carbon\\Carbon::now();`;
    const result = laravelCarbon.transform(php);
    assert.ok(result.changed);
    assert.ok(result.content.includes('Carbon::now()'));
    assert.ok(!result.content.includes('Carbon\\Carbon::now()'));
  });
});

// ─── Transform Registry ─────────────────────────────────

describe('Transform Registry', () => {
  it('has 13 transforms registered', () => {
    assert.equal(transforms.length, 13);
  });

  it('each transform has required interface', () => {
    for (const t of transforms) {
      assert.ok(t.name, `Missing name on ${JSON.stringify(t)}`);
      assert.ok(t.description, `Missing description on ${t.name}`);
      if (t.projectLevel) {
        // Project-level transforms have detect(projectRoot) and run(projectRoot)
        assert.equal(typeof t.detect, 'function', `Missing detect() on ${t.name}`);
        assert.equal(typeof t.run, 'function', `Missing run() on ${t.name}`);
      } else {
        assert.ok(t.glob, `Missing glob on ${t.name}`);
        assert.equal(typeof t.detect, 'function', `Missing detect() on ${t.name}`);
        assert.equal(typeof t.transform, 'function', `Missing transform() on ${t.name}`);
      }
    }
  });

  it('getApplicableTransforms returns all enabled-by-default for version 10', () => {
    const applicable = getApplicableTransforms('10', '11');
    // Should include everything except declare-strict and down-migration (disabled by default)
    // and faker-methods (appliesFrom: 9, so 10 >= 9 = included)
    const names = applicable.map(t => t.name);
    assert.ok(names.includes('anonymous-migrations'));
    assert.ok(names.includes('facade-aliases'));
    assert.ok(names.includes('faker-methods'));
    assert.ok(!names.includes('declare-strict')); // disabled by default
    assert.ok(!names.includes('down-migration')); // disabled by default
  });

  it('respects config overrides', () => {
    const applicable = getApplicableTransforms('10', '11', {
      'declare-strict': true,
      'debug-calls': false,
    });
    const names = applicable.map(t => t.name);
    assert.ok(names.includes('declare-strict')); // enabled via config
    assert.ok(!names.includes('debug-calls')); // disabled via config
  });

  it('filters by version range (faker-methods requires 9+)', () => {
    const from8 = getApplicableTransforms('8', '9');
    const names8 = from8.map(t => t.name);
    assert.ok(!names8.includes('faker-methods')); // appliesFrom: 9, fromVersion: 8

    const from9 = getApplicableTransforms('9', '10');
    const names9 = from9.map(t => t.name);
    assert.ok(names9.includes('faker-methods'));
  });

  it('filters by targetMinVersion (l11-structural requires target >= 11)', () => {
    const to10 = getApplicableTransforms('10', '10');
    const names10 = to10.map(t => t.name);
    assert.ok(!names10.includes('l11-structural'));

    const to11 = getApplicableTransforms('10', '11');
    const names11 = to11.map(t => t.name);
    assert.ok(names11.includes('l11-structural'));

    const to13 = getApplicableTransforms('9', '13');
    const names13 = to13.map(t => t.name);
    assert.ok(names13.includes('l11-structural'));
  });
});

// ─── L11 Structural Migration ──────────────────────────

describe('Transform: l11-structural', () => {
  // ── Detection ──

  describe('detection', () => {
    const tmpDir = join(import.meta.dirname, '.tmp-l11-detect');

    after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('detects project with Kernel.php as needing transform', () => {
      mkdirSync(join(tmpDir, 'app', 'Http'), { recursive: true });
      writeFileSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), '<?php\nclass Kernel {}');
      assert.ok(l11Structural.detect(tmpDir));
    });

    it('skips project without Kernel.php (already L11)', () => {
      const tmpDir2 = join(import.meta.dirname, '.tmp-l11-detect2');
      mkdirSync(tmpDir2, { recursive: true });
      assert.ok(!l11Structural.detect(tmpDir2));
      rmSync(tmpDir2, { recursive: true, force: true });
    });
  });

  // ── Middleware extraction ──

  describe('extractCustomMiddleware', () => {
    it('returns empty for default kernel', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\Illuminate\\Http\\Middleware\\HandleCors::class,
        \\App\\Http\\Middleware\\PreventRequestsDuringMaintenance::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize::class,
        \\App\\Http\\Middleware\\TrimStrings::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull::class,
    ];
}`;
      assert.deepEqual(extractCustomMiddleware(kernel), []);
    });

    it('extracts one custom global middleware', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\Illuminate\\Http\\Middleware\\HandleCors::class,
        \\App\\Http\\Middleware\\PreventRequestsDuringMaintenance::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize::class,
        \\App\\Http\\Middleware\\TrimStrings::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull::class,
        \\App\\Http\\Middleware\\TrackVisitor::class,
    ];
}`;
      const result = extractCustomMiddleware(kernel);
      assert.deepEqual(result, ['App\\Http\\Middleware\\TrackVisitor']);
    });

    it('extracts multiple custom middleware', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\App\\Http\\Middleware\\CustomCors::class,
        \\App\\Http\\Middleware\\LogRequests::class,
    ];
}`;
      const result = extractCustomMiddleware(kernel);
      assert.equal(result.length, 2);
      assert.ok(result.includes('App\\Http\\Middleware\\CustomCors'));
      assert.ok(result.includes('App\\Http\\Middleware\\LogRequests'));
    });
  });

  describe('extractCustomMiddlewareAliases', () => {
    it('returns empty for default aliases', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middlewareAliases = [
        'auth' => \\Illuminate\\Auth\\Middleware\\Authenticate::class,
        'throttle' => \\Illuminate\\Routing\\Middleware\\ThrottleRequests::class,
    ];
}`;
      assert.deepEqual(extractCustomMiddlewareAliases(kernel), {});
    });

    it('extracts custom aliases', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middlewareAliases = [
        'auth' => \\Illuminate\\Auth\\Middleware\\Authenticate::class,
        'admin' => \\App\\Http\\Middleware\\AdminOnly::class,
        'locale' => \\App\\Http\\Middleware\\SetLocale::class,
    ];
}`;
      const result = extractCustomMiddlewareAliases(kernel);
      assert.equal(result['admin'], 'App\\Http\\Middleware\\AdminOnly');
      assert.equal(result['locale'], 'App\\Http\\Middleware\\SetLocale');
      assert.ok(!('auth' in result));
    });

    it('handles $routeMiddleware (older Laravel naming)', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $routeMiddleware = [
        'auth' => \\Illuminate\\Auth\\Middleware\\Authenticate::class,
        'role' => \\App\\Http\\Middleware\\CheckRole::class,
    ];
}`;
      const result = extractCustomMiddlewareAliases(kernel);
      assert.equal(result['role'], 'App\\Http\\Middleware\\CheckRole');
    });
  });

  describe('extractCustomMiddlewareGroups', () => {
    it('returns empty for default groups', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middlewareGroups = [
        'web' => [
            \\App\\Http\\Middleware\\EncryptCookies::class,
            \\App\\Http\\Middleware\\VerifyCsrfToken::class,
        ],
    ];
}`;
      assert.deepEqual(extractCustomMiddlewareGroups(kernel), {});
    });

    it('extracts custom middleware in groups', () => {
      const kernel = `<?php
class Kernel extends HttpKernel {
    protected $middlewareGroups = [
        'web' => [
            \\App\\Http\\Middleware\\EncryptCookies::class,
            \\App\\Http\\Middleware\\VerifyCsrfToken::class,
            \\App\\Http\\Middleware\\TrackSession::class,
        ],
    ];
}`;
      const result = extractCustomMiddlewareGroups(kernel);
      assert.ok(result.custom);
      assert.ok(result.custom.includes('App\\Http\\Middleware\\TrackSession'));
    });
  });

  // ── Exception handling extraction ──

  describe('extractCustomExceptionHandling', () => {
    it('returns empty for default handler', () => {
      const handler = `<?php
class Handler extends ExceptionHandler {
    public function register(): void
    {
        //
    }
}`;
      assert.equal(extractCustomExceptionHandling(handler), '');
    });

    it('returns empty for handler with only comments', () => {
      const handler = `<?php
class Handler extends ExceptionHandler {
    public function register(): void
    {
        // Default handler
        /* nothing here */
    }
}`;
      assert.equal(extractCustomExceptionHandling(handler), '');
    });

    it('extracts custom exception handling code', () => {
      const handler = `<?php
class Handler extends ExceptionHandler {
    public function register(): void
    {
        $this->reportable(function (Throwable $e) {
            Sentry::captureException($e);
        });
    }
}`;
      const result = extractCustomExceptionHandling(handler);
      assert.ok(result.includes('reportable'));
      assert.ok(result.includes('Sentry'));
    });
  });

  // ── Provider extraction ──

  describe('extractCustomProviders', () => {
    it('returns empty for default config/app.php', () => {
      const config = `<?php
return [
    'providers' => [
        Illuminate\\Auth\\AuthServiceProvider::class,
        App\\Providers\\AppServiceProvider::class,
        App\\Providers\\AuthServiceProvider::class,
        App\\Providers\\EventServiceProvider::class,
        App\\Providers\\RouteServiceProvider::class,
    ],
];`;
      assert.deepEqual(extractCustomProviders(config), []);
    });

    it('extracts custom providers', () => {
      const config = `<?php
return [
    'providers' => [
        App\\Providers\\AppServiceProvider::class,
        App\\Providers\\AuthServiceProvider::class,
        App\\Providers\\TelescopeServiceProvider::class,
        App\\Providers\\HorizonServiceProvider::class,
    ],
];`;
      const result = extractCustomProviders(config);
      assert.ok(result.includes('App\\Providers\\TelescopeServiceProvider'));
      assert.ok(result.includes('App\\Providers\\HorizonServiceProvider'));
      assert.ok(!result.includes('App\\Providers\\AppServiceProvider'));
    });

    it('skips framework providers', () => {
      const config = `<?php
return [
    'providers' => [
        Illuminate\\Auth\\AuthServiceProvider::class,
        Laravel\\Sanctum\\SanctumServiceProvider::class,
        App\\Providers\\AppServiceProvider::class,
        App\\Providers\\CustomProvider::class,
    ],
];`;
      const result = extractCustomProviders(config);
      assert.deepEqual(result, ['App\\Providers\\CustomProvider']);
    });
  });

  // ── File generation ──

  describe('generateBootstrapApp', () => {
    it('generates correct format with no custom code', () => {
      const result = generateBootstrapApp({
        customMiddleware: [],
        customMiddlewareGroups: {},
        customMiddlewareAliases: {},
        customExceptionCode: '',
      });
      assert.ok(result.includes('Application::configure(basePath: dirname(__DIR__))'));
      assert.ok(result.includes('->withRouting('));
      assert.ok(result.includes('->withMiddleware('));
      assert.ok(result.includes('->withExceptions('));
      assert.ok(result.includes('->create()'));
      assert.ok(result.includes("web: __DIR__.'/../routes/web.php'"));
      assert.ok(result.includes("commands: __DIR__.'/../routes/console.php'"));
    });

    it('includes custom middleware in withMiddleware()', () => {
      const result = generateBootstrapApp({
        customMiddleware: ['App\\Http\\Middleware\\TrackVisitor'],
        customMiddlewareGroups: {},
        customMiddlewareAliases: {},
        customExceptionCode: '',
      });
      assert.ok(result.includes('$middleware->append(\\App\\Http\\Middleware\\TrackVisitor::class)'));
    });

    it('includes custom aliases', () => {
      const result = generateBootstrapApp({
        customMiddleware: [],
        customMiddlewareGroups: {},
        customMiddlewareAliases: { 'admin': 'App\\Http\\Middleware\\AdminOnly' },
        customExceptionCode: '',
      });
      assert.ok(result.includes("$middleware->alias(['admin' => \\App\\Http\\Middleware\\AdminOnly::class])"));
    });

    it('includes custom exception code', () => {
      const result = generateBootstrapApp({
        customMiddleware: [],
        customMiddlewareGroups: {},
        customMiddlewareAliases: {},
        customExceptionCode: '$this->reportable(function (Throwable $e) { });',
      });
      assert.ok(result.includes('reportable'));
    });

    it('does NOT include api routing by default', () => {
      const result = generateBootstrapApp({
        customMiddleware: [],
        customMiddlewareGroups: {},
        customMiddlewareAliases: {},
        customExceptionCode: '',
      });
      assert.ok(!result.includes('api.php'));
    });
  });

  describe('addApiRouting', () => {
    it('adds api routing to bootstrap content', () => {
      const content = generateBootstrapApp({
        customMiddleware: [],
        customMiddlewareGroups: {},
        customMiddlewareAliases: {},
        customExceptionCode: '',
      });
      const result = addApiRouting(content);
      assert.ok(result.includes("api: __DIR__.'/../routes/api.php'"));
      assert.ok(result.includes("commands: __DIR__.'/../routes/console.php'"));
    });
  });

  describe('generateProvidersFile', () => {
    it('includes AppServiceProvider', () => {
      const result = generateProvidersFile(['App\\Providers\\AppServiceProvider']);
      assert.ok(result.includes('App\\Providers\\AppServiceProvider::class'));
      assert.ok(result.includes('return ['));
    });

    it('includes custom providers', () => {
      const result = generateProvidersFile([
        'App\\Providers\\AppServiceProvider',
        'App\\Providers\\TelescopeServiceProvider',
      ]);
      assert.ok(result.includes('App\\Providers\\AppServiceProvider::class'));
      assert.ok(result.includes('App\\Providers\\TelescopeServiceProvider::class'));
    });
  });

  // ── Stub detection ──

  describe('isDefaultMiddlewareStub', () => {
    it('detects default empty stub', () => {
      const stub = `<?php
namespace App\\Http\\Middleware;
class TrimStrings extends Middleware {
    protected $except = [
        //
    ];
}`;
      assert.ok(isDefaultMiddlewareStub(stub));
    });

    it('detects customised stub (non-empty $except)', () => {
      const stub = `<?php
namespace App\\Http\\Middleware;
class VerifyCsrfToken extends Middleware {
    protected $except = [
        'api/*',
        'webhooks/*',
    ];
}`;
      assert.ok(!isDefaultMiddlewareStub(stub));
    });
  });

  describe('isDefaultProviderStub', () => {
    it('detects default empty provider', () => {
      const provider = `<?php
namespace App\\Providers;
class EventServiceProvider extends ServiceProvider {
    public function register(): void
    {
        //
    }
    public function boot(): void
    {
        //
    }
}`;
      assert.ok(isDefaultProviderStub(provider));
    });

    it('detects customised provider', () => {
      const provider = `<?php
namespace App\\Providers;
class EventServiceProvider extends ServiceProvider {
    public function boot(): void
    {
        Event::listen(OrderShipped::class, SendShipmentNotification::class);
    }
}`;
      assert.ok(!isDefaultProviderStub(provider));
    });
  });

  // ── Full run integration ──

  describe('full run', () => {
    const tmpDir = join(import.meta.dirname, '.tmp-l11-run');

    function setupProject(overrides = {}) {
      rmSync(tmpDir, { recursive: true, force: true });

      // Create directory structure
      mkdirSync(join(tmpDir, 'app', 'Http', 'Middleware'), { recursive: true });
      mkdirSync(join(tmpDir, 'app', 'Console'), { recursive: true });
      mkdirSync(join(tmpDir, 'app', 'Exceptions'), { recursive: true });
      mkdirSync(join(tmpDir, 'app', 'Providers'), { recursive: true });
      mkdirSync(join(tmpDir, 'bootstrap'), { recursive: true });
      mkdirSync(join(tmpDir, 'config'), { recursive: true });
      mkdirSync(join(tmpDir, 'routes'), { recursive: true });
      mkdirSync(join(tmpDir, 'tests'), { recursive: true });
      mkdirSync(join(tmpDir, '.shift', 'backups'), { recursive: true });

      // Write Kernel.php
      writeFileSync(join(tmpDir, 'app', 'Http', 'Kernel.php'), overrides.kernel || `<?php
namespace App\\Http;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel {
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\Illuminate\\Http\\Middleware\\HandleCors::class,
        \\App\\Http\\Middleware\\PreventRequestsDuringMaintenance::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize::class,
        \\App\\Http\\Middleware\\TrimStrings::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull::class,
    ];
    protected $middlewareGroups = [
        'web' => [
            \\App\\Http\\Middleware\\EncryptCookies::class,
            \\App\\Http\\Middleware\\VerifyCsrfToken::class,
        ],
    ];
    protected $middlewareAliases = [
        'auth' => \\Illuminate\\Auth\\Middleware\\Authenticate::class,
        'throttle' => \\Illuminate\\Routing\\Middleware\\ThrottleRequests::class,
    ];
}`);

      // Write Console/Kernel.php
      writeFileSync(join(tmpDir, 'app', 'Console', 'Kernel.php'), `<?php
namespace App\\Console;
class Kernel extends ConsoleKernel {
    protected function schedule(Schedule $schedule): void {}
}`);

      // Write Handler.php
      writeFileSync(join(tmpDir, 'app', 'Exceptions', 'Handler.php'), overrides.handler || `<?php
namespace App\\Exceptions;
class Handler extends ExceptionHandler {
    public function register(): void
    {
        //
    }
}`);

      // Write bootstrap/app.php (old format)
      writeFileSync(join(tmpDir, 'bootstrap', 'app.php'), `<?php
$app = new Illuminate\\Foundation\\Application(
    $_ENV['APP_BASE_PATH'] ?? dirname(__DIR__)
);
$app->singleton('Kernel', App\\Http\\Kernel::class);
return $app;`);

      // Write config/app.php
      writeFileSync(join(tmpDir, 'config', 'app.php'), overrides.configApp || `<?php
return [
    'providers' => [
        App\\Providers\\AppServiceProvider::class,
        App\\Providers\\AuthServiceProvider::class,
        App\\Providers\\RouteServiceProvider::class,
    ],
];`);

      // Write config/cors.php
      writeFileSync(join(tmpDir, 'config', 'cors.php'), `<?php
return ['paths' => ['api/*']];`);

      // Write default middleware stubs
      writeFileSync(join(tmpDir, 'app', 'Http', 'Middleware', 'TrimStrings.php'), `<?php
namespace App\\Http\\Middleware;
class TrimStrings extends Middleware {
    protected $except = [
        //
    ];
}`);

      writeFileSync(join(tmpDir, 'app', 'Http', 'Middleware', 'TrustProxies.php'), `<?php
namespace App\\Http\\Middleware;
class TrustProxies extends Middleware {
}`);

      // Write default providers
      writeFileSync(join(tmpDir, 'app', 'Providers', 'AppServiceProvider.php'), `<?php
namespace App\\Providers;
class AppServiceProvider extends ServiceProvider {
    public function register(): void
    {
        //
    }
    public function boot(): void
    {
        //
    }
}`);

      writeFileSync(join(tmpDir, 'app', 'Providers', 'AuthServiceProvider.php'), `<?php
namespace App\\Providers;
class AuthServiceProvider extends ServiceProvider {
    public function register(): void
    {
        //
    }
    public function boot(): void
    {
        //
    }
}`);

      writeFileSync(join(tmpDir, 'app', 'Providers', 'RouteServiceProvider.php'), `<?php
namespace App\\Providers;
class RouteServiceProvider extends ServiceProvider {
    public function register(): void
    {
        //
    }
    public function boot(): void
    {
        //
    }
}`);

      // Write routes/web.php
      writeFileSync(join(tmpDir, 'routes', 'web.php'), `<?php
Route::get('/', function () { return view('welcome'); });`);

      // Write tests/TestCase.php
      writeFileSync(join(tmpDir, 'tests', 'TestCase.php'), `<?php
namespace Tests;
use Tests\\CreatesApplication;
use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;
abstract class TestCase extends BaseTestCase
{
    use CreatesApplication;
}`);

      // Write tests/CreatesApplication.php
      writeFileSync(join(tmpDir, 'tests', 'CreatesApplication.php'), `<?php
namespace Tests;
trait CreatesApplication {
    public function createApplication() {
        return require __DIR__.'/../bootstrap/app.php';
    }
}`);
    }

    after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('deletes Kernel.php with backup', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('app/Http/Kernel.php'));
      assert.ok(!existsSync(join(tmpDir, 'app', 'Http', 'Kernel.php')));
      // Backup exists
      assert.ok(existsSync(join(tmpDir, '.shift', 'backups', 'app', 'Http', 'Kernel.php')));
    });

    it('deletes Console/Kernel.php', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('app/Console/Kernel.php'));
      assert.ok(!existsSync(join(tmpDir, 'app', 'Console', 'Kernel.php')));
    });

    it('deletes Handler.php', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('app/Exceptions/Handler.php'));
    });

    it('deletes config/cors.php', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('config/cors.php'));
    });

    it('deletes tests/CreatesApplication.php', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('tests/CreatesApplication.php'));
    });

    it('deletes default middleware stubs', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('app/Http/Middleware/TrimStrings.php'));
      assert.ok(result.filesDeleted.includes('app/Http/Middleware/TrustProxies.php'));
    });

    it('deletes default provider stubs', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesDeleted.includes('app/Providers/AuthServiceProvider.php'));
      assert.ok(result.filesDeleted.includes('app/Providers/RouteServiceProvider.php'));
    });

    it('preserves custom middleware stubs', () => {
      setupProject();
      writeFileSync(join(tmpDir, 'app', 'Http', 'Middleware', 'VerifyCsrfToken.php'), `<?php
namespace App\\Http\\Middleware;
class VerifyCsrfToken extends Middleware {
    protected $except = [
        'api/webhooks/*',
        'stripe/*',
    ];
}`);
      const result = l11Structural.run(tmpDir);
      assert.ok(!result.filesDeleted.includes('app/Http/Middleware/VerifyCsrfToken.php'));
      assert.ok(existsSync(join(tmpDir, 'app', 'Http', 'Middleware', 'VerifyCsrfToken.php')));
    });

    it('preserves custom provider stubs (has non-empty methods)', () => {
      setupProject();
      writeFileSync(join(tmpDir, 'app', 'Providers', 'EventServiceProvider.php'), `<?php
namespace App\\Providers;
class EventServiceProvider extends ServiceProvider {
    public function boot(): void
    {
        Event::listen(OrderShipped::class, SendNotification::class);
    }
}`);
      const result = l11Structural.run(tmpDir);
      assert.ok(!result.filesDeleted.includes('app/Providers/EventServiceProvider.php'));
    });

    it('rewrites bootstrap/app.php to L11 format', () => {
      setupProject();
      l11Structural.run(tmpDir);
      const content = readFileSync(join(tmpDir, 'bootstrap', 'app.php'), 'utf-8');
      assert.ok(content.includes('Application::configure(basePath: dirname(__DIR__))'));
      assert.ok(content.includes('->withMiddleware('));
      assert.ok(content.includes('->withExceptions('));
      assert.ok(content.includes('->create()'));
    });

    it('creates bootstrap/providers.php', () => {
      setupProject();
      const result = l11Structural.run(tmpDir);
      assert.ok(result.filesCreated.includes('bootstrap/providers.php'));
      const content = readFileSync(join(tmpDir, 'bootstrap', 'providers.php'), 'utf-8');
      assert.ok(content.includes('App\\Providers\\AppServiceProvider::class'));
    });

    it('includes custom providers in bootstrap/providers.php', () => {
      setupProject({
        configApp: `<?php
return [
    'providers' => [
        App\\Providers\\AppServiceProvider::class,
        App\\Providers\\AuthServiceProvider::class,
        App\\Providers\\TelescopeServiceProvider::class,
    ],
];`,
      });
      const result = l11Structural.run(tmpDir);
      assert.ok(result.customProviders.includes('App\\Providers\\TelescopeServiceProvider'));
      const content = readFileSync(join(tmpDir, 'bootstrap', 'providers.php'), 'utf-8');
      assert.ok(content.includes('App\\Providers\\TelescopeServiceProvider::class'));
    });

    it('includes api routing when routes/api.php exists', () => {
      setupProject();
      writeFileSync(join(tmpDir, 'routes', 'api.php'), '<?php\n// api routes');
      l11Structural.run(tmpDir);
      const content = readFileSync(join(tmpDir, 'bootstrap', 'app.php'), 'utf-8');
      assert.ok(content.includes("api: __DIR__.'/../routes/api.php'"));
    });

    it('does NOT include api routing when no routes/api.php', () => {
      setupProject();
      l11Structural.run(tmpDir);
      const content = readFileSync(join(tmpDir, 'bootstrap', 'app.php'), 'utf-8');
      assert.ok(!content.includes('api.php'));
    });

    it('migrates custom middleware to bootstrap/app.php', () => {
      setupProject({
        kernel: `<?php
namespace App\\Http;
class Kernel extends HttpKernel {
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\Illuminate\\Http\\Middleware\\HandleCors::class,
        \\App\\Http\\Middleware\\PreventRequestsDuringMaintenance::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ValidatePostSize::class,
        \\App\\Http\\Middleware\\TrimStrings::class,
        \\Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull::class,
        \\App\\Http\\Middleware\\TrackVisitor::class,
    ];
    protected $middlewareGroups = [
        'web' => [
            \\App\\Http\\Middleware\\EncryptCookies::class,
        ],
    ];
    protected $middlewareAliases = [
        'auth' => \\Illuminate\\Auth\\Middleware\\Authenticate::class,
    ];
}`,
      });
      const result = l11Structural.run(tmpDir);
      assert.deepEqual(result.customMiddleware, ['App\\Http\\Middleware\\TrackVisitor']);
      const content = readFileSync(join(tmpDir, 'bootstrap', 'app.php'), 'utf-8');
      assert.ok(content.includes('$middleware->append(\\App\\Http\\Middleware\\TrackVisitor::class)'));
    });

    it('migrates custom exception handling to bootstrap/app.php', () => {
      setupProject({
        handler: `<?php
namespace App\\Exceptions;
class Handler extends ExceptionHandler {
    public function register(): void
    {
        $this->reportable(function (Throwable $e) {
            Sentry::captureException($e);
        });
    }
}`,
      });
      const result = l11Structural.run(tmpDir);
      assert.ok(result.customExceptionHandling);
      const content = readFileSync(join(tmpDir, 'bootstrap', 'app.php'), 'utf-8');
      assert.ok(content.includes('reportable'));
    });

    it('updates tests/TestCase.php (removes CreatesApplication)', () => {
      setupProject();
      l11Structural.run(tmpDir);
      const content = readFileSync(join(tmpDir, 'tests', 'TestCase.php'), 'utf-8');
      assert.ok(!content.includes('use CreatesApplication'));
      assert.ok(!content.includes('use Tests\\CreatesApplication'));
      assert.ok(content.includes('class TestCase'));
    });

    it('skips gracefully when config/app.php is missing', () => {
      setupProject();
      rmSync(join(tmpDir, 'config', 'app.php'));
      const result = l11Structural.run(tmpDir);
      assert.deepEqual(result.customProviders, []);
      // Still creates providers.php with at least AppServiceProvider
      const content = readFileSync(join(tmpDir, 'bootstrap', 'providers.php'), 'utf-8');
      assert.ok(content.includes('AppServiceProvider'));
    });

    it('skips gracefully when Handler.php is missing', () => {
      setupProject();
      rmSync(join(tmpDir, 'app', 'Exceptions', 'Handler.php'));
      const result = l11Structural.run(tmpDir);
      assert.ok(!result.customExceptionHandling);
    });

    it('skips gracefully when tests/TestCase.php is missing', () => {
      setupProject();
      rmSync(join(tmpDir, 'tests', 'TestCase.php'));
      // Should not throw
      const result = l11Structural.run(tmpDir);
      assert.ok(!result.filesModified.includes('tests/TestCase.php'));
    });

    it('dry run does not modify files', () => {
      setupProject();
      const result = l11Structural.run(tmpDir, { dryRun: true });
      assert.deepEqual(result.filesDeleted, []);
      assert.deepEqual(result.filesCreated, []);
      assert.deepEqual(result.filesModified, []);
      // But still extracts info
      assert.ok(Array.isArray(result.customMiddleware));
      // Original files should still exist
      assert.ok(existsSync(join(tmpDir, 'app', 'Http', 'Kernel.php')));
    });

    it('cleans up empty directories', () => {
      setupProject();
      // Remove all middleware files except the stubs that will be deleted
      l11Structural.run(tmpDir);
      // app/Http/Middleware should be gone if all stubs were deleted
      // (unless custom stubs remain)
      assert.ok(!existsSync(join(tmpDir, 'app', 'Http', 'Middleware')));
      // app/Exceptions should be gone
      assert.ok(!existsSync(join(tmpDir, 'app', 'Exceptions')));
    });
  });
});

// ─── Pre-Processor Integration ───────────────────────────

describe('Pre-Processor', () => {
  const tmpDir = join(import.meta.dirname, '.tmp-preprocess-test');

  before(() => {
    mkdirSync(join(tmpDir, 'app', 'Models'), { recursive: true });
    mkdirSync(join(tmpDir, 'database', 'migrations'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Http', 'Controllers'), { recursive: true });

    // Write test PHP files
    writeFileSync(join(tmpDir, 'database', 'migrations', '2024_01_01_create_users.php'),
      `<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\n\nclass CreateUsersTable extends Migration\n{\n    public function up()\n    {\n    }\n}\n`);

    writeFileSync(join(tmpDir, 'app', 'Http', 'Controllers', 'TestController.php'),
      `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse Cache;\nuse Auth;\n\nclass TestController\n{\n    public function index()\n    {\n        dd($request);\n        $query->orderBy('created_at', 'desc');\n    }\n}\n`);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs applicable transforms on project', async () => {
    const result = await runPreProcessing(tmpDir, '10', '11', { dryRun: true });
    assert.ok(result.transforms.length > 0);
    assert.equal(typeof result.totalChanges, 'number');
    assert.equal(typeof result.filesModified, 'number');
  });

  it('dry run does not modify files', async () => {
    const beforeContent = readFileSync(
      join(tmpDir, 'database', 'migrations', '2024_01_01_create_users.php'), 'utf8'
    );
    await runPreProcessing(tmpDir, '10', '11', { dryRun: true });
    const afterContent = readFileSync(
      join(tmpDir, 'database', 'migrations', '2024_01_01_create_users.php'), 'utf8'
    );
    assert.equal(beforeContent, afterContent);
  });

  it('actual run modifies files', async () => {
    const result = await runPreProcessing(tmpDir, '10', '11', { dryRun: false });
    assert.ok(result.totalChanges > 0);

    // Check migration was converted
    const migration = readFileSync(
      join(tmpDir, 'database', 'migrations', '2024_01_01_create_users.php'), 'utf8'
    );
    assert.ok(migration.includes('return new class extends Migration'));
  });

  it('generates summary for Planner', async () => {
    const result = await runPreProcessing(tmpDir, '10', '11', { dryRun: true });
    const summary = generatePreProcessingSummary(result);
    assert.ok(typeof summary === 'string');
  });

  it('returns empty summary when no changes', () => {
    const summary = generatePreProcessingSummary({ transforms: [], totalChanges: 0 });
    assert.ok(summary.includes('No deterministic pre-processing'));
  });
});
