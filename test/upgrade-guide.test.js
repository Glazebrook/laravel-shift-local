/**
 * Tests for src/upgrade-guide.js — Upgrade guide loading and querying
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data', 'upgrade-guides');

function makeSampleGuide(version) {
  return {
    version: `${version}.x`,
    url: `https://laravel.com/docs/${version}.x/upgrade`,
    fetchedAt: '2026-03-28',
    sections: [
      {
        title: 'Updating Dependencies',
        level: 2,
        content: `You should update the following dependencies in your composer.json for Laravel ${version}.`,
        breaking: false,
      },
      {
        title: 'Application Structure',
        level: 2,
        content: `Laravel ${version} introduces changes to the application structure that are breaking.`,
        breaking: true,
      },
      {
        title: 'Password Rehashing',
        level: 3,
        content: 'Laravel will automatically rehash passwords.',
        breaking: false,
      },
    ],
    thirdParty: [
      {
        package: 'laravel/cashier-stripe',
        notes: 'Cashier Stripe 15.x required, publish migrations.',
      },
      {
        package: 'livewire/livewire',
        notes: 'Livewire v3 is recommended for this version.',
      },
    ],
  };
}

describe('UpgradeGuide', () => {
  let upgradeGuide;
  const backups = {};

  before(async () => {
    mkdirSync(DATA_DIR, { recursive: true });

    // Write test guides
    for (const version of ['9', '10', '11', '12']) {
      const filePath = join(DATA_DIR, `${version}.json`);
      if (existsSync(filePath)) {
        backups[filePath] = readFileSync(filePath, 'utf8');
      }
      writeFileSync(filePath, JSON.stringify(makeSampleGuide(version), null, 2));
    }

    upgradeGuide = await import('../src/upgrade-guide.js');
  });

  beforeEach(() => {
    upgradeGuide.clearGuideCache();
  });

  after(() => {
    for (const [filePath, content] of Object.entries(backups)) {
      writeFileSync(filePath, content);
    }
    upgradeGuide.clearGuideCache();
  });

  describe('loadUpgradeGuide', () => {
    it('loads guide for a valid version', () => {
      const guide = upgradeGuide.loadUpgradeGuide('11');
      assert.ok(guide);
      assert.equal(guide.version, '11.x');
      assert.ok(guide.sections.length > 0);
    });

    it('handles version strings with .x suffix', () => {
      const guide = upgradeGuide.loadUpgradeGuide('11.x');
      assert.ok(guide);
      assert.equal(guide.version, '11.x');
    });

    it('returns null for missing guide', () => {
      const guide = upgradeGuide.loadUpgradeGuide('13');
      assert.equal(guide, null);
    });

    it('returns null for invalid version', () => {
      const guide = upgradeGuide.loadUpgradeGuide('99');
      assert.equal(guide, null);
    });

    it('caches loaded guides', () => {
      const first = upgradeGuide.loadUpgradeGuide('11');
      const second = upgradeGuide.loadUpgradeGuide('11');
      assert.equal(first, second);
    });
  });

  describe('getBreakingSections', () => {
    it('returns only breaking sections', () => {
      const sections = upgradeGuide.getBreakingSections('11');
      assert.ok(sections.length > 0);
      for (const s of sections) {
        assert.equal(s.breaking, true);
      }
    });

    it('returns empty array for missing guide', () => {
      const sections = upgradeGuide.getBreakingSections('13');
      assert.deepEqual(sections, []);
    });
  });

  describe('getThirdPartyNotes', () => {
    it('returns third-party package notes', () => {
      const notes = upgradeGuide.getThirdPartyNotes('11');
      assert.ok(notes.length > 0);
      assert.ok(notes.some(n => n.package === 'laravel/cashier-stripe'));
    });

    it('returns empty array for missing guide', () => {
      const notes = upgradeGuide.getThirdPartyNotes('13');
      assert.deepEqual(notes, []);
    });
  });

  describe('formatGuideForPlanner', () => {
    it('formats guide as context string', () => {
      const text = upgradeGuide.formatGuideForPlanner('11');
      assert.ok(text.includes('Official Laravel 11.x'));
      assert.ok(text.includes('[BREAKING]'));
      assert.ok(text.includes('Application Structure'));
    });

    it('includes third-party section', () => {
      const text = upgradeGuide.formatGuideForPlanner('11');
      assert.ok(text.includes('Third-Party Packages'));
      assert.ok(text.includes('laravel/cashier-stripe'));
    });

    it('returns empty string for missing guide', () => {
      const text = upgradeGuide.formatGuideForPlanner('13');
      assert.equal(text, '');
    });
  });

  describe('clearGuideCache', () => {
    it('clears the cache', () => {
      upgradeGuide.loadUpgradeGuide('11');
      upgradeGuide.clearGuideCache();
      // After clear, next load re-reads from disk
      const guide = upgradeGuide.loadUpgradeGuide('11');
      assert.ok(guide);
    });
  });
});
