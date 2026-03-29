/**
 * Pre-Processor — Runs deterministic transforms before LLM agents
 *
 * Operates between the Analyzer and Planner phases. Applies regex-based
 * code transforms that are guaranteed-correct, reducing token cost and
 * eliminating LLM hallucination risk for well-defined changes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { glob } from 'glob';
import { getApplicableTransforms } from './transforms/index.js';

/**
 * Run all applicable deterministic transforms on the project.
 *
 * @param {string} projectRoot - Path to the Laravel project
 * @param {string} fromVersion - Current Laravel version
 * @param {string} toVersion - Target Laravel version
 * @param {object} [options] - { dryRun: false, verbose: false, logger: null }
 * @param {object} [config] - .shiftrc preProcessing config
 * @returns {object} { transforms: [...], filesModified: N, totalChanges: N }
 */
export async function runPreProcessing(projectRoot, fromVersion, toVersion, options = {}, config = {}) {
  const { dryRun = false, verbose = false, logger = null } = options;
  const transformConfig = config.transforms || {};

  const applicable = getApplicableTransforms(fromVersion, toVersion, transformConfig);

  if (logger) {
    await logger.info('PreProcessor', `${applicable.length} transform(s) applicable for ${fromVersion} → ${toVersion}`);
  }

  const results = [];
  let totalFilesModified = 0;
  let totalChanges = 0;

  for (const transform of applicable) {
    const result = await runSingleTransform(transform, projectRoot, { dryRun, verbose, logger });
    results.push(result);
    totalFilesModified += result.filesModified;
    totalChanges += result.changes;
  }

  return {
    transforms: results,
    filesModified: totalFilesModified,
    totalChanges,
  };
}

/**
 * Run a single transform across all matching files.
 */
async function runSingleTransform(transform, projectRoot, options = {}) {
  const { dryRun = false, verbose = false, logger = null } = options;

  // Find matching files
  const pattern = transform.glob;
  let files;
  try {
    files = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      ignore: ['vendor/**', 'node_modules/**', 'storage/**'],
    });
  } catch {
    files = [];
  }

  const result = {
    name: transform.name,
    description: transform.description,
    filesScanned: files.length,
    filesModified: 0,
    changes: 0,
    details: [],
  };

  for (const filePath of files) {
    const absPath = join(projectRoot, filePath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue; // Skip unreadable files
    }

    if (!transform.detect(content, filePath)) continue;

    const transformResult = transform.transform(content, filePath);
    if (!transformResult.changed) continue;

    result.filesModified++;
    result.changes++;
    result.details.push({
      file: filePath,
      description: transformResult.description,
    });

    if (verbose && logger) {
      await logger.info('PreProcessor', `  ${transform.name}: ${filePath} — ${transformResult.description}`);
    }

    if (!dryRun) {
      writeFileSync(absPath, transformResult.content, 'utf8');
    }
  }

  if (logger && result.filesModified > 0) {
    await logger.info('PreProcessor', `${transform.name}: ${result.filesModified} file(s) modified`);
  }

  return result;
}

/**
 * Generate a summary report of pre-processing for the Planner agent.
 * @param {object} preProcessingResult - Result from runPreProcessing
 * @returns {string} Human-readable summary
 */
export function generatePreProcessingSummary(preProcessingResult) {
  if (!preProcessingResult || preProcessingResult.totalChanges === 0) {
    return 'No deterministic pre-processing transforms were applied.';
  }

  const lines = ['The following deterministic transforms have ALREADY been applied:'];

  for (const t of preProcessingResult.transforms) {
    if (t.filesModified === 0) continue;
    lines.push(`- ${t.name}: ${t.filesModified} file(s) — ${t.description}`);
    for (const d of t.details) {
      lines.push(`    ${d.file}: ${d.description}`);
    }
  }

  lines.push('');
  lines.push('DO NOT plan any work for changes that were already made by pre-processing.');

  return lines.join('\n');
}
