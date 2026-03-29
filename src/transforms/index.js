/**
 * Transform Registry — Central registry of all deterministic transforms
 */

import anonymousMigrations from './anonymous-migrations.js';
import classStrings from './class-strings.js';
import debugCalls from './debug-calls.js';
import declareStrict from './declare-strict.js';
import facadeAliases from './facade-aliases.js';
import fakerMethods from './faker-methods.js';
import rulesArrays from './rules-arrays.js';
import modelTable from './model-table.js';
import latestOldest from './latest-oldest.js';
import explicitOrderby from './explicit-orderby.js';
import downMigration from './down-migration.js';
import laravelCarbon from './laravel-carbon.js';
import l11Structural from './l11-structural.js';

export const transforms = [
  anonymousMigrations,
  classStrings,
  debugCalls,
  declareStrict,
  facadeAliases,
  fakerMethods,
  rulesArrays,
  modelTable,
  latestOldest,
  explicitOrderby,
  downMigration,
  laravelCarbon,
  // Project-level transforms run last (after all file-level transforms)
  l11Structural,
];

/**
 * Get transforms applicable to a version transition, respecting config.
 * @param {string} fromVersion - Source version (e.g., "10")
 * @param {string} toVersion - Target version (unused currently, reserved)
 * @param {object} [config] - .shiftrc preProcessing.transforms config
 * @returns {Array} Applicable transforms
 */
export function getApplicableTransforms(fromVersion, toVersion, config = {}) {
  const from = parseInt(String(fromVersion).split('.')[0], 10);
  const to = parseInt(String(toVersion).split('.')[0], 10);

  return transforms.filter(t => {
    // Version range check (source version)
    const tFrom = parseInt(t.appliesFrom || '0', 10);
    const tTo = t.appliesTo ? parseInt(t.appliesTo, 10) : Infinity;
    if (from < tFrom || from > tTo) return false;

    // Target minimum version check
    if (t.targetMinVersion && to < t.targetMinVersion) return false;

    // Config check: explicit enable/disable in .shiftrc
    const configKey = t.configKey || t.name;
    if (config[configKey] !== undefined) {
      return config[configKey];
    }

    // Default: use the transform's own default
    return t.defaultEnabled !== false;
  });
}
