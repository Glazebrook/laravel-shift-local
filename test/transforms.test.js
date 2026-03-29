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
  it('has 12 transforms registered', () => {
    assert.equal(transforms.length, 12);
  });

  it('each transform has required interface', () => {
    for (const t of transforms) {
      assert.ok(t.name, `Missing name on ${JSON.stringify(t)}`);
      assert.ok(t.description, `Missing description on ${t.name}`);
      assert.ok(t.glob, `Missing glob on ${t.name}`);
      assert.equal(typeof t.detect, 'function', `Missing detect() on ${t.name}`);
      assert.equal(typeof t.transform, 'function', `Missing transform() on ${t.name}`);
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
