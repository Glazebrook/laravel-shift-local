/**
 * Upgrade Guide — Loads pre-fetched official Laravel upgrade guides
 *
 * Guides are fetched at BUILD TIME by scripts/build-upgrade-guides.js
 * and stored in data/upgrade-guides/. This module loads them at runtime.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_DIR = resolve(import.meta.dirname, '..', 'data', 'upgrade-guides');

const guideCache = new Map();

/**
 * Load the official Laravel upgrade guide for a version.
 * @param {string} version - Target version, e.g., "11"
 * @returns {object|null} Parsed guide with sections, or null if not available
 */
export function loadUpgradeGuide(version) {
  const v = String(version).split('.')[0];

  if (guideCache.has(v)) {
    return guideCache.get(v);
  }

  const filePath = join(DATA_DIR, `${v}.json`);
  if (!existsSync(filePath)) {
    guideCache.set(v, null);
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const guide = JSON.parse(raw);
    guideCache.set(v, guide);
    return guide;
  } catch {
    guideCache.set(v, null);
    return null;
  }
}

/**
 * Get breaking change sections from the upgrade guide.
 * @param {string} version - Target version
 * @returns {Array} Sections marked as breaking
 */
export function getBreakingSections(version) {
  const guide = loadUpgradeGuide(version);
  if (!guide) return [];
  return guide.sections?.filter(s => s.breaking) || [];
}

/**
 * Get third-party package notes from the upgrade guide.
 * @param {string} version - Target version
 * @returns {Array} Third-party package entries
 */
export function getThirdPartyNotes(version) {
  const guide = loadUpgradeGuide(version);
  if (!guide) return [];
  return guide.thirdParty || [];
}

/**
 * Generate a formatted context string for the Planner agent.
 * @param {string} toVersion - Target version
 * @returns {string} Formatted guide text, or empty string if unavailable
 */
export function formatGuideForPlanner(toVersion) {
  const guide = loadUpgradeGuide(toVersion);
  if (!guide) return '';

  const lines = [`Official Laravel ${guide.version} Upgrade Guide (${guide.url}):`];

  for (const section of guide.sections || []) {
    const flag = section.breaking ? ' [BREAKING]' : '';
    lines.push(`\n### ${section.title}${flag}`);
    lines.push(section.content.substring(0, 500));
  }

  if (guide.thirdParty?.length > 0) {
    lines.push('\n### Third-Party Packages');
    for (const pkg of guide.thirdParty) {
      lines.push(`- ${pkg.package}: ${pkg.notes.substring(0, 200)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Clear the guide cache. Useful for testing.
 */
export function clearGuideCache() {
  guideCache.clear();
}
