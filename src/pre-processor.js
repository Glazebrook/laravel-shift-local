/**
 * Pre-Processor — Runs deterministic transforms before LLM agents
 *
 * Operates between the Analyzer and Planner phases. Applies regex-based
 * code transforms that are guaranteed-correct, reducing token cost and
 * eliminating LLM hallucination risk for well-defined changes.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { glob } from 'glob';
import { getApplicableTransforms } from './transforms/index.js';

/**
 * SEC-002 FIX: Back up a file before writing and validate path stays within project root.
 */
function safeWriteFile(projectRoot, absPath, content) {
  const prefix = projectRoot + (projectRoot.endsWith(sep) ? '' : sep);
  const resolved = resolve(absPath);
  if (resolved !== projectRoot && !resolved.startsWith(prefix)) {
    throw new Error(`Path traversal blocked: ${absPath}`);
  }

  // Create backup before overwriting
  if (existsSync(absPath)) {
    const relPath = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : basename(absPath);
    const backupDir = join(projectRoot, '.shift', 'backups', dirname(relPath));
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(absPath, join(backupDir, basename(absPath)));
  }

  // R10-002 FIX: Atomic write — write to temp then rename to prevent partial writes on crash
  const tmp = absPath + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, absPath);
}

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
    let result;

    if (transform.projectLevel) {
      // Project-level transforms (e.g. l11-structural) operate on the whole project
      result = await runProjectLevelTransform(transform, projectRoot, { dryRun, verbose, logger });
    } else {
      // File-level transforms operate on individual files matching a glob
      result = await runSingleTransform(transform, projectRoot, { dryRun, verbose, logger });
    }

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
    // R10-016 FIX: Add follow: false to prevent following symlinks into loops
    files = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      ignore: ['vendor/**', 'node_modules/**', 'storage/**'],
      follow: false,
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
      // SEC-002 FIX: Use safeWriteFile for backup creation + path validation
      safeWriteFile(projectRoot, absPath, transformResult.content);
    }
  }

  if (logger && result.filesModified > 0) {
    await logger.info('PreProcessor', `${transform.name}: ${result.filesModified} file(s) modified`);
  }

  return result;
}

/**
 * Run a project-level transform (operates on entire project, not per-file).
 */
async function runProjectLevelTransform(transform, projectRoot, options = {}) {
  const { dryRun = false, verbose = false, logger = null } = options;

  const result = {
    name: transform.name,
    description: transform.description,
    filesScanned: 0,
    filesModified: 0,
    changes: 0,
    details: [],
  };

  // Check if the transform applies to this project
  if (!transform.detect(projectRoot)) {
    if (logger) {
      await logger.info('PreProcessor', `${transform.name}: skipped (not applicable)`);
    }
    return result;
  }

  const runResult = transform.run(projectRoot, { dryRun, verbose });

  // Aggregate results
  const allFiles = [
    ...runResult.filesModified.map(f => ({ file: f, desc: 'modified' })),
    ...runResult.filesCreated.map(f => ({ file: f, desc: 'created' })),
    ...runResult.filesDeleted.map(f => ({ file: f, desc: 'deleted' })),
  ];

  result.filesModified = allFiles.length;
  result.changes = allFiles.length;
  result.details = allFiles.map(f => ({
    file: f.file,
    description: f.desc,
  }));

  // Add extra context details
  if (runResult.customMiddleware?.length > 0) {
    result.details.push({
      file: 'bootstrap/app.php',
      description: `Migrated ${runResult.customMiddleware.length} custom middleware: ${runResult.customMiddleware.join(', ')}`,
    });
  }
  if (runResult.customProviders?.length > 0) {
    result.details.push({
      file: 'bootstrap/providers.php',
      description: `Migrated ${runResult.customProviders.length} custom providers: ${runResult.customProviders.join(', ')}`,
    });
  }

  if (verbose && logger) {
    for (const d of result.details) {
      await logger.info('PreProcessor', `  ${transform.name}: ${d.file} — ${d.description}`);
    }
  }

  if (logger && result.filesModified > 0) {
    await logger.info('PreProcessor', `${transform.name}: ${result.filesModified} file(s) changed`);
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

  const hasStructural = preProcessingResult.transforms.some(t => t.name === 'l11-structural' && t.filesModified > 0);

  for (const t of preProcessingResult.transforms) {
    if (t.filesModified === 0) continue;
    lines.push(`- ${t.name}: ${t.filesModified} file(s) — ${t.description}`);
    for (const d of t.details) {
      lines.push(`    ${d.file}: ${d.description}`);
    }
  }

  lines.push('');
  lines.push('DO NOT plan any work for changes that were already made by pre-processing.');

  if (hasStructural) {
    lines.push('');
    lines.push('STRUCTURAL MIGRATION NOTE:');
    lines.push('The L11 structural migration has been applied deterministically. Do NOT plan any of these:');
    lines.push('- app/Http/Kernel.php (DELETED — middleware migrated to bootstrap/app.php)');
    lines.push('- app/Console/Kernel.php (DELETED)');
    lines.push('- app/Exceptions/Handler.php (DELETED — exceptions migrated to bootstrap/app.php)');
    lines.push('- bootstrap/app.php (REWRITTEN to L11 Application::configure() format)');
    lines.push('- bootstrap/providers.php (CREATED with custom providers)');
    lines.push('- Default middleware stubs (DELETED)');
    lines.push('- Default provider stubs (DELETED)');
    lines.push('- config/cors.php (DELETED)');
    lines.push('- tests/CreatesApplication.php (DELETED)');
    lines.push('- tests/TestCase.php (UPDATED — CreatesApplication removed)');
    lines.push('Focus only on: config files, model changes, controller updates, route adjustments, and project-specific code.');
  }

  return lines.join('\n');
}
