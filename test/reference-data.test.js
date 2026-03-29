/**
 * Tests for src/reference-data.js — Reference diff manifest loading and querying
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// We test against the actual module, using a temporary data directory
const DATA_DIR = resolve(import.meta.dirname, '..', 'data', 'reference-diffs');

// Sample manifest data for testing
function makeSampleManifest(from, to) {
  return {
    from: `${from}.x`,
    to: `${to}.x`,
    generated: '2026-03-28T00:00:00Z',
    sourceRepos: {
      from: `https://github.com/laravel-shift/laravel-${from}.x`,
      to: `https://github.com/laravel-shift/laravel-${to}.x`,
    },
    skeleton: {
      filesAdded: [
        {
          path: `new-file-${to}.php`,
          content: '<?php // new file',
          description: `New file in Laravel ${to}`,
        },
      ],
      filesRemoved: [
        {
          path: `old-file-${from}.php`,
          description: `Removed in Laravel ${to}`,
          breaking: true,
          migration: 'Migrate to new approach',
        },
      ],
      filesModified: [
        {
          path: 'config/app.php',
          diff: `--- a/config/app.php\n+++ b/config/app.php\n@@ -1 +1 @@\n-old\n+new`,
          description: 'Config changes',
          breaking: true,
        },
      ],
    },
    composer: {
      requireUpdates: {
        'laravel/framework': { from: `^${from}.0`, to: `^${to}.0` },
        php: { from: `^8.${parseInt(from) - 8}`, to: `^8.${parseInt(to) - 8}` },
      },
      requireDevUpdates: {
        'phpunit/phpunit': { from: `^${parseInt(from) + 2}.0`, to: `^${parseInt(to) + 2}.0` },
      },
      additions: {},
      removals: from === '10' ? ['doctrine/dbal'] : [],
    },
    breakingChanges: [
      {
        category: 'structure',
        title: `Breaking change ${from} to ${to}`,
        description: `Sample breaking change for ${from} → ${to}`,
        affectedFiles: ['config/app.php'],
        automatable: true,
      },
    ],
  };
}

describe('ReferenceData', () => {
  let referenceData;
  const backups = {};

  before(async () => {
    // Create data directory and sample manifests
    mkdirSync(DATA_DIR, { recursive: true });

    // Write test manifests for 8→9, 9→10, 10→11, 11→12
    for (const [from, to] of [['8', '9'], ['9', '10'], ['10', '11'], ['11', '12']]) {
      const filePath = join(DATA_DIR, `${from}-to-${to}.json`);
      // Back up existing files
      if (existsSync(filePath)) {
        const { readFileSync } = await import('node:fs');
        backups[filePath] = readFileSync(filePath, 'utf8');
      }
      writeFileSync(filePath, JSON.stringify(makeSampleManifest(from, to), null, 2));
    }

    // Import after creating test data
    referenceData = await import('../src/reference-data.js');
  });

  beforeEach(() => {
    // Clear cache between tests to ensure clean state
    referenceData.clearCache();
  });

  after(() => {
    // Restore backed-up files or clean up test data
    for (const [filePath, content] of Object.entries(backups)) {
      writeFileSync(filePath, content);
    }
    referenceData.clearCache();
  });

  describe('loadManifest', () => {
    it('loads a manifest for a valid version transition', () => {
      const manifest = referenceData.loadManifest('10', '11');
      assert.ok(manifest);
      assert.equal(manifest.from, '10.x');
      assert.equal(manifest.to, '11.x');
    });

    it('handles version strings with .x suffix', () => {
      const manifest = referenceData.loadManifest('10.x', '11.x');
      assert.ok(manifest);
      assert.equal(manifest.from, '10.x');
    });

    it('returns null for missing manifest', () => {
      const manifest = referenceData.loadManifest('12', '13');
      assert.equal(manifest, null);
    });

    it('returns null for invalid version numbers', () => {
      const manifest = referenceData.loadManifest('99', '100');
      assert.equal(manifest, null);
    });

    it('caches loaded manifests', () => {
      const first = referenceData.loadManifest('10', '11');
      const second = referenceData.loadManifest('10', '11');
      assert.equal(first, second); // Same reference = cached
    });
  });

  describe('getBreakingChanges', () => {
    it('returns breaking changes for a version transition', () => {
      const changes = referenceData.getBreakingChanges('10', '11');
      assert.ok(Array.isArray(changes));
      assert.ok(changes.length > 0);
      assert.equal(changes[0].category, 'structure');
    });

    it('returns empty array for missing manifest', () => {
      const changes = referenceData.getBreakingChanges('12', '13');
      assert.deepEqual(changes, []);
    });
  });

  describe('getComposerChanges', () => {
    it('returns composer changes for a version transition', () => {
      const changes = referenceData.getComposerChanges('10', '11');
      assert.ok(changes);
      assert.ok(changes.requireUpdates['laravel/framework']);
      assert.equal(changes.requireUpdates['laravel/framework'].from, '^10.0');
      assert.equal(changes.requireUpdates['laravel/framework'].to, '^11.0');
    });

    it('returns removals when applicable', () => {
      const changes = referenceData.getComposerChanges('10', '11');
      assert.ok(changes.removals.includes('doctrine/dbal'));
    });

    it('returns null for missing manifest', () => {
      const changes = referenceData.getComposerChanges('12', '13');
      assert.equal(changes, null);
    });
  });

  describe('getFileChange', () => {
    it('finds an added file', () => {
      const change = referenceData.getFileChange('10', '11', 'new-file-11.php');
      assert.ok(change);
      assert.equal(change.type, 'added');
    });

    it('finds a removed file', () => {
      const change = referenceData.getFileChange('10', '11', 'old-file-10.php');
      assert.ok(change);
      assert.equal(change.type, 'removed');
      assert.equal(change.breaking, true);
    });

    it('finds a modified file', () => {
      const change = referenceData.getFileChange('10', '11', 'config/app.php');
      assert.ok(change);
      assert.equal(change.type, 'modified');
    });

    it('returns null for unchanged file', () => {
      const change = referenceData.getFileChange('10', '11', 'nonexistent.php');
      assert.equal(change, null);
    });

    it('returns null for missing manifest', () => {
      const change = referenceData.getFileChange('12', '13', 'config/app.php');
      assert.equal(change, null);
    });
  });

  describe('getTransitionChain', () => {
    it('returns single-step chain for consecutive versions', () => {
      const chain = referenceData.getTransitionChain('10', '11');
      assert.equal(chain.length, 1);
      assert.equal(chain[0].from, '10');
      assert.equal(chain[0].to, '11');
      assert.ok(chain[0].manifest);
    });

    it('returns multi-step chain for version jumps', () => {
      const chain = referenceData.getTransitionChain('8', '11');
      assert.equal(chain.length, 3);
      assert.equal(chain[0].from, '8');
      assert.equal(chain[0].to, '9');
      assert.equal(chain[1].from, '9');
      assert.equal(chain[1].to, '10');
      assert.equal(chain[2].from, '10');
      assert.equal(chain[2].to, '11');
    });

    it('returns empty chain for same version', () => {
      const chain = referenceData.getTransitionChain('10', '10');
      assert.deepEqual(chain, []);
    });

    it('returns empty chain for reverse transition', () => {
      const chain = referenceData.getTransitionChain('11', '10');
      assert.deepEqual(chain, []);
    });

    it('returns empty chain for unknown versions', () => {
      const chain = referenceData.getTransitionChain('99', '100');
      assert.deepEqual(chain, []);
    });

    it('includes null manifests for missing data files', () => {
      const chain = referenceData.getTransitionChain('11', '13');
      assert.equal(chain.length, 2);
      assert.ok(chain[0].manifest); // 11→12 exists
      assert.equal(chain[1].manifest, null); // 12→13 missing
    });
  });

  describe('getAggregatedComposerChanges', () => {
    it('aggregates composer changes across multiple versions', () => {
      const changes = referenceData.getAggregatedComposerChanges('8', '11');
      assert.ok(changes.requireUpdates['laravel/framework']);
      // Should have from=8 origin and to=11 target
      assert.equal(changes.requireUpdates['laravel/framework'].from, '^8.0');
      assert.equal(changes.requireUpdates['laravel/framework'].to, '^11.0');
    });

    it('preserves removals from intermediate versions', () => {
      const changes = referenceData.getAggregatedComposerChanges('8', '12');
      assert.ok(changes.removals.includes('doctrine/dbal'));
    });

    it('returns empty changes for missing chain', () => {
      const changes = referenceData.getAggregatedComposerChanges('99', '100');
      assert.deepEqual(changes.requireUpdates, {});
      assert.deepEqual(changes.removals, []);
    });

    it('handles single-step transitions', () => {
      const changes = referenceData.getAggregatedComposerChanges('10', '11');
      assert.ok(changes.requireUpdates['laravel/framework']);
      assert.equal(changes.requireUpdates['laravel/framework'].from, '^10.0');
      assert.equal(changes.requireUpdates['laravel/framework'].to, '^11.0');
    });
  });

  describe('clearCache', () => {
    it('clears the manifest cache', () => {
      // Load a manifest to populate cache
      const first = referenceData.loadManifest('10', '11');
      assert.ok(first);

      // Clear cache
      referenceData.clearCache();

      // Next load should re-read from disk (still returns data, but different reference)
      const second = referenceData.loadManifest('10', '11');
      assert.ok(second);
      assert.deepEqual(first, second);
    });
  });
});
