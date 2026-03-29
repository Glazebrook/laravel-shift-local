/**
 * Tests for src/blueprint-exporter.js — Blueprint YAML export
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { generateBlueprintYaml } from '../src/blueprint-exporter.js';

describe('BlueprintExporter', () => {
  const tmpDir = join(import.meta.dirname, '.tmp-blueprint-test');

  before(() => {
    mkdirSync(join(tmpDir, 'app', 'Models'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Http', 'Controllers'), { recursive: true });
    mkdirSync(join(tmpDir, '.shift'), { recursive: true });

    // Write a model file
    writeFileSync(join(tmpDir, 'app', 'Models', 'User.php'), `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class User extends Model
{
    protected $fillable = ['name', 'email', 'password'];

    protected $casts = [
        'email_verified_at' => 'datetime',
        'is_admin' => 'boolean',
    ];

    public function posts()
    {
        return $this->hasMany(Post::class);
    }

    public function profile()
    {
        return $this->hasOne(Profile::class);
    }

    public function roles()
    {
        return $this->belongsToMany(Role::class);
    }
}
`);

    // Write a model with non-conventional table name
    writeFileSync(join(tmpDir, 'app', 'Models', 'Post.php'), `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Post extends Model
{
    protected $table = 'blog_posts';
    protected $fillable = ['title', 'content', 'published_at'];

    protected $casts = [
        'published_at' => 'timestamp',
    ];

    public function author()
    {
        return $this->belongsTo(User::class);
    }
}
`);

    // Write a controller
    writeFileSync(join(tmpDir, 'app', 'Http', 'Controllers', 'UserController.php'), `<?php

namespace App\\Http\\Controllers;

class UserController extends Controller
{
    public function index()
    {
        return view('users.index');
    }

    public function show(User $user)
    {
        return view('users.show', compact('user'));
    }

    public function store(Request $request)
    {
        // store logic
    }
}
`);

    // Write the base Controller (should be skipped)
    writeFileSync(join(tmpDir, 'app', 'Http', 'Controllers', 'Controller.php'), `<?php

namespace App\\Http\\Controllers;

use Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;

abstract class Controller
{
}
`);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates YAML with models', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('models:'));
    assert.ok(result.yaml.includes('User:'));
    assert.ok(result.yaml.includes('Post:'));
    assert.ok(result.modelCount >= 2);
  });

  it('extracts fillable properties', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('name: string'));
    assert.ok(result.yaml.includes('email: string'));
  });

  it('extracts casts', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('email_verified_at: datetime'));
    assert.ok(result.yaml.includes('is_admin: boolean'));
  });

  it('extracts relationships', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('hasMany: Post'));
    assert.ok(result.yaml.includes('hasOne: Profile'));
    assert.ok(result.yaml.includes('belongsToMany: Role'));
    assert.ok(result.yaml.includes('belongsTo: User'));
  });

  it('handles non-conventional table names', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('table: blog_posts'));
  });

  it('extracts controllers with methods', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    assert.ok(result.yaml.includes('controllers:'));
    assert.ok(result.yaml.includes('UserController:'));
    assert.ok(result.yaml.includes('index:'));
    assert.ok(result.yaml.includes('show:'));
    assert.ok(result.yaml.includes('store:'));
    assert.ok(result.controllerCount >= 1);
  });

  it('skips base Controller class', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    // Should have UserController but not standalone "Controller:"
    const lines = result.yaml.split('\n');
    const controllerLines = lines.filter(l => l.trim().startsWith('Controller:'));
    // Base Controller should not appear (only UserController)
    assert.equal(controllerLines.length, 0);
  });

  it('respects includeControllers=false', async () => {
    const result = await generateBlueprintYaml(tmpDir, { includeControllers: false });
    assert.ok(!result.yaml.includes('controllers:'));
    assert.equal(result.controllerCount, 0);
  });

  it('writes to output file', async () => {
    const outputPath = '.shift/blueprint.yaml';
    await generateBlueprintYaml(tmpDir, { outputPath });
    const absPath = join(tmpDir, outputPath);
    assert.ok(existsSync(absPath));
    const content = readFileSync(absPath, 'utf8');
    assert.ok(content.includes('models:'));
  });

  it('handles empty models directory gracefully', async () => {
    const emptyDir = join(import.meta.dirname, '.tmp-blueprint-empty');
    mkdirSync(join(emptyDir, 'app', 'Models'), { recursive: true });
    mkdirSync(join(emptyDir, '.shift'), { recursive: true });
    try {
      const result = await generateBlueprintYaml(emptyDir);
      assert.equal(result.modelCount, 0);
      assert.ok(typeof result.yaml === 'string');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('generated YAML is valid (basic structure check)', async () => {
    const result = await generateBlueprintYaml(tmpDir);
    // Check it starts with comment and has valid indentation
    assert.ok(result.yaml.startsWith('# Blueprint YAML'));
    // No tabs (YAML should use spaces)
    assert.ok(!result.yaml.includes('\t'));
  });
});
