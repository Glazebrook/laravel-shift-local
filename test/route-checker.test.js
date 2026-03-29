/**
 * Tests for src/route-checker.js — Dead route detection
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { checkRoutes, generateRouteReport } from '../src/route-checker.js';

describe('RouteChecker', () => {
  const tmpDir = join(import.meta.dirname, '.tmp-routes-test');

  before(() => {
    mkdirSync(join(tmpDir, 'routes'), { recursive: true });
    mkdirSync(join(tmpDir, 'app', 'Http', 'Controllers'), { recursive: true });

    // Write controllers
    writeFileSync(join(tmpDir, 'app', 'Http', 'Controllers', 'UserController.php'), `<?php

namespace App\\Http\\Controllers;

class UserController extends Controller
{
    public function index() { return view('users.index'); }
    public function show() { return view('users.show'); }
    public function store() { /* ... */ }
    protected function internalMethod() { /* not routable */ }
    private function privateHelper() { /* not routable */ }
}
`);

    writeFileSync(join(tmpDir, 'app', 'Http', 'Controllers', 'InvokeController.php'), `<?php

namespace App\\Http\\Controllers;

class InvokeController extends Controller
{
    public function __invoke() { return response('ok'); }
}
`);

    // Write route files
    writeFileSync(join(tmpDir, 'routes', 'web.php'), `<?php

use App\\Http\\Controllers\\UserController;
use App\\Http\\Controllers\\InvokeController;

// Valid routes
Route::get('/users', [UserController::class, 'index']);
Route::get('/users/{user}', [UserController::class, 'show']);
Route::post('/users', [UserController::class, 'store']);

// Invokable route
Route::get('/invoke', InvokeController::class);

// Dead route: missing controller
Route::get('/orders', [OrderController::class, 'index']);

// Dead route: missing method
Route::get('/users/missing', [UserController::class, 'nonExistent']);

// Dead route: protected method
Route::get('/users/internal', [UserController::class, 'internalMethod']);

// Old string syntax — dead route
Route::get('/admin', 'AdminController@index');

// Closure route (should be skipped — no controller)
Route::get('/health', function () { return 'ok'; });
`);

    writeFileSync(join(tmpDir, 'routes', 'api.php'), `<?php

use App\\Http\\Controllers\\UserController;

Route::apiResource('users', UserController::class);
`);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('checkRoutes', () => {
    it('detects valid routes correctly', async () => {
      const result = await checkRoutes(tmpDir);
      assert.ok(result.checked > 0);
      // Valid routes should not appear in deadRoutes
      const deadPaths = result.deadRoutes.map(r => r.route);
      assert.ok(!deadPaths.includes('/users'));
    });

    it('detects missing controller', async () => {
      const result = await checkRoutes(tmpDir);
      const dead = result.deadRoutes.find(r => r.controller === 'OrderController');
      assert.ok(dead, 'Should detect missing OrderController');
      assert.ok(dead.reason.includes('not found'));
    });

    it('detects missing method', async () => {
      const result = await checkRoutes(tmpDir);
      const dead = result.deadRoutes.find(r => r.method === 'nonExistent');
      assert.ok(dead, 'Should detect missing method');
      assert.ok(dead.reason.includes('not found'));
    });

    it('detects protected method', async () => {
      const result = await checkRoutes(tmpDir);
      const dead = result.deadRoutes.find(r => r.method === 'internalMethod');
      assert.ok(dead, 'Should detect protected method');
      assert.ok(dead.reason.includes('protected'));
    });

    it('detects missing controller in string syntax', async () => {
      const result = await checkRoutes(tmpDir);
      const dead = result.deadRoutes.find(r => r.controller === 'AdminController');
      assert.ok(dead, 'Should detect missing AdminController');
    });

    it('validates invokable controllers', async () => {
      const result = await checkRoutes(tmpDir);
      // InvokeController has __invoke so should be valid
      const dead = result.deadRoutes.find(r => r.controller === 'InvokeController');
      assert.ok(!dead, 'InvokeController with __invoke should be valid');
    });

    it('validates resource routes (checks all methods)', async () => {
      const result = await checkRoutes(tmpDir);
      // apiResource generates index, store, show, update, destroy
      // UserController has index, show, store but NOT update or destroy
      const deadUser = result.deadRoutes.filter(r => r.controller === 'UserController');
      // Should detect missing update and destroy methods
      assert.ok(deadUser.some(r => r.method === 'update'), 'Should detect missing update');
      assert.ok(deadUser.some(r => r.method === 'destroy'), 'Should detect missing destroy');
    });

    it('handles empty project gracefully', async () => {
      const emptyDir = join(import.meta.dirname, '.tmp-routes-empty');
      mkdirSync(join(emptyDir, 'routes'), { recursive: true });
      try {
        const result = await checkRoutes(emptyDir);
        assert.equal(result.checked, 0);
        assert.deepEqual(result.deadRoutes, []);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('skips closure routes (no controller to check)', async () => {
      const result = await checkRoutes(tmpDir);
      // Closure routes should not appear in deadRoutes
      const closureDead = result.deadRoutes.find(r => r.route === '/health');
      assert.ok(!closureDead, 'Closure routes should be skipped');
    });
  });

  describe('generateRouteReport', () => {
    it('generates report with dead routes', async () => {
      const result = await checkRoutes(tmpDir);
      const report = generateRouteReport(result);
      assert.ok(report.includes('Dead routes found'));
      assert.ok(report.includes('Controller'));
    });

    it('reports all clear when no dead routes', () => {
      const report = generateRouteReport({ deadRoutes: [], checked: 5 });
      assert.ok(report.includes('valid'));
    });

    it('handles no routes checked', () => {
      const report = generateRouteReport({ deadRoutes: [], checked: 0 });
      assert.ok(report.includes('No routes'));
    });

    it('handles null result', () => {
      const report = generateRouteReport(null);
      assert.ok(report.includes('No routes'));
    });
  });
});
