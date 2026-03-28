/**
 * FileTools - Safe file read/write/backup utilities
 */

import {
  readFileSync, writeFileSync, copyFileSync,
  existsSync, mkdirSync, readdirSync, statSync,
  unlinkSync, realpathSync,
} from 'node:fs';
import { join, dirname, relative, resolve, sep, normalize, basename } from 'node:path';
import { glob } from 'glob';
// MED-3 FIX: Use crypto for stronger boundary randomness
import { randomUUID } from 'node:crypto';
import { FileToolsError, ParseError, PathTraversalError } from './errors.js';

export class FileTools {
  constructor(projectPath, logger, excludeConfig = {}) {
    this.projectPath = resolve(projectPath);
    this.backupDir = join(this.projectPath, '.shift', 'backups');
    this.logger = logger;
    this.excludePaths = (excludeConfig.paths || []).map(p => `${p}/**`);
    this.excludeFilePatterns = excludeConfig.filePatterns || [];
  }

  // ─── Read ──────────────────────────────────────────────────────
  readFile(filepath) {
    const abs = this._abs(filepath);
    if (!existsSync(abs)) throw new FileToolsError(`File not found: ${filepath}`, { filePath: filepath, operation: 'read' });
    return readFileSync(abs, 'utf8');
  }

  readJson(filepath) {
    const raw = this.readFile(filepath);
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new ParseError(`Invalid JSON in ${filepath}: ${err.message}`, { filePath: filepath, rawPreview: raw?.substring(0, 200) });
    }
  }

  // ─── Write ─────────────────────────────────────────────────────
  writeFile(filepath, content) {
    const abs = this._abs(filepath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  writeJson(filepath, obj, pretty = true) {
    this.writeFile(filepath, JSON.stringify(obj, null, pretty ? 2 : 0) + '\n');
  }

  // ─── Backup ────────────────────────────────────────────────────
  backup(filepath) {
    const abs = this._abs(filepath);
    const backupPath = join(this.backupDir, filepath);
    // AUDIT FIX: Validate backup path stays within backup directory (same traversal
    // protection as _abs() but for the backup directory)
    const resolvedBackup = resolve(backupPath);
    const backupPrefix = this.backupDir + (this.backupDir.endsWith(sep) ? '' : sep);
    if (resolvedBackup !== this.backupDir && !resolvedBackup.startsWith(backupPrefix)) {
      throw new PathTraversalError(`Backup path traversal blocked: ${filepath}`, { requestedPath: filepath, resolvedPath: resolvedBackup });
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    if (!existsSync(abs)) {
      // H9 FIX: For files that don't exist yet (new files), store a sentinel
      // marker so the backup guard knows the pristine state was "no file".
      // This prevents the first transform's output being treated as the
      // pristine original if the file is later modified in a subsequent step.
      writeFileSync(backupPath + '.created-marker', '', 'utf8');
      return null;
    }
    copyFileSync(abs, backupPath);
    return backupPath;
  }

  restore(filepath) {
    const backupPath = join(this.backupDir, filepath);
    const markerPath = backupPath + '.created-marker';

    // H9 FIX: If the sentinel marker exists, the pristine state was "no file" —
    // delete the file on rollback rather than restoring from a backup.
    if (existsSync(markerPath)) {
      const abs = this._abs(filepath);
      if (existsSync(abs)) {
        unlinkSync(abs);
      }
      return;
    }

    if (!existsSync(backupPath)) throw new FileToolsError(`No backup for: ${filepath}`, { filePath: filepath, operation: 'restore' });
    const abs = this._abs(filepath);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(backupPath, abs);
  }

  hasBackup(filepath) {
    // H9 FIX: Also check for the .created-marker sentinel (file didn't exist before)
    return existsSync(join(this.backupDir, filepath)) ||
           existsSync(join(this.backupDir, filepath + '.created-marker'));
  }

  // ─── Discovery ─────────────────────────────────────────────────
  // MED-4 FIX: Add follow: false to prevent infinite loops on circular symlinks,
  // and an AbortController timeout to prevent hangs on massive directory trees.
  async findFiles(pattern, ignore = []) {
    const defaultIgnore = [
      'vendor/**', 'node_modules/**', '.git/**',
      'storage/**', 'bootstrap/cache/**', '.shift/**',
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await glob(pattern, {
        cwd: this.projectPath,
        ignore: [...defaultIgnore, ...this.excludePaths, ...this.excludeFilePatterns, ...ignore],
        nodir: true,
        follow: false,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async findPhpFiles() {
    return this.findFiles('**/*.php');
  }

  async findConfigFiles() {
    return this.findFiles('config/**/*.php');
  }

  async findBladeFiles() {
    return this.findFiles('**/*.blade.php');
  }

  async findRouteFiles() {
    return this.findFiles('routes/**/*.php');
  }

  async findMigrations() {
    return this.findFiles('database/migrations/**/*.php');
  }

  // ─── Analysis helpers ──────────────────────────────────────────
  fileExists(filepath) {
    return existsSync(this._abs(filepath));
  }

  getFileSize(filepath) {
    const abs = this._abs(filepath);
    return existsSync(abs) ? statSync(abs).size : 0;
  }

  listDir(dirpath) {
    const abs = this._abs(dirpath);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).map(f => join(dirpath, f));
  }

  getRelative(abs) {
    return relative(this.projectPath, abs);
  }

  /**
   * Resolve a filepath relative to the project root.
   * BUG-1 FIX: Uses path.sep instead of hardcoded '/' for Windows compatibility.
   * SEC-1 FIX: Checks parent directories for symlink escape when target doesn't exist.
   * C7 FIX: Validates both the logical path (resolve) and the real path
   * (realpathSync, which follows symlinks) to prevent symlink escape attacks.
   */
  _abs(filepath) {
    const resolved = resolve(this.projectPath, filepath);
    // BUG-1 FIX: Use path.sep for cross-platform path separator
    const prefix = this.projectPath + (this.projectPath.endsWith(sep) ? '' : sep);
    // Check logical path stays within project
    if (resolved !== this.projectPath && !resolved.startsWith(prefix)) {
      throw new PathTraversalError(`Path traversal blocked: ${filepath}`, { requestedPath: filepath, resolvedPath: resolved });
    }
    // SEC-1 FIX: Check every existing ancestor for symlink escape,
    // even when the target file itself does not yet exist.
    let checkPath = resolved;
    while (checkPath !== this.projectPath && checkPath.startsWith(prefix)) {
      if (existsSync(checkPath)) {
        try {
          const real = realpathSync(checkPath);
          if (real !== this.projectPath && !real.startsWith(prefix)) {
            throw new PathTraversalError(`Symlink escape blocked: ${filepath} -> ${real}`, { requestedPath: filepath, resolvedPath: real });
          }
        } catch (err) {
          // If the error is our own security error, re-throw it
          if (err.code === 'SHIFT_TRAVERSAL') throw err;
          // Otherwise (e.g., permission error), let it through — the actual
          // read/write operation will fail with a meaningful error
        }
        break;
      }
      checkPath = dirname(checkPath);
    }
    return resolved;
  }

  /**
   * FIX #15: Check if a filepath falls within an excluded directory.
   * Used by the write guard to prevent agent writes to excluded paths.
   */
  _isExcludedPath(filepath) {
    const isCaseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
    // HIGH-5 FIX: Strip leading ./ before comparison so tool call inputs like
    // './vendor/evil.php' match the exclude path 'vendor'.
    let normalized = normalize(filepath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (isCaseInsensitive) normalized = normalized.toLowerCase();
    // M5 FIX: Apply the same normalisation to exclude paths, not just the input filepath.
    // On Windows, exclude paths from .shiftrc may contain backslashes or mixed separators.
    const excludeBasePaths = (this.excludePaths || []).map(p => {
      const base = normalize(p.replace(/\/\*\*$/, '')).replace(/\\/g, '/');
      return isCaseInsensitive ? base.toLowerCase() : base;
    });
    for (const excluded of excludeBasePaths) {
      if (normalized === excluded || normalized.startsWith(excluded + '/')) {
        return true;
      }
    }
    return false;
  }

  // ─── Anthropic tool definitions ───────────────────────────────
  // MED-5 FIX: Design constraint — agents must not run concurrently against
  // the same FileTools instance (shared backup state would race).
  // The _activeToolCall guard detects accidental concurrent use.
  getAgentTools() {
    const self = this;
    let _activeToolCall = false;
    return {
      definitions: [
        {
          name: 'read_file',
          description: 'Read the content of a file in the Laravel project',
          input_schema: {
            type: 'object',
            properties: {
              filepath: { type: 'string', description: 'Relative path to file from project root' },
            },
            required: ['filepath'],
          },
        },
        {
          name: 'write_file',
          description: 'Write content to a file (backs up original automatically)',
          input_schema: {
            type: 'object',
            properties: {
              filepath: { type: 'string', description: 'Relative path from project root' },
              content: { type: 'string', description: 'Full file content to write' },
            },
            required: ['filepath', 'content'],
          },
        },
        {
          name: 'list_files',
          description: 'List PHP files in a directory or matching a glob pattern',
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern, e.g. app/**/*.php' },
            },
            required: ['pattern'],
          },
        },
        {
          name: 'file_exists',
          description: 'Check if a file exists in the project',
          input_schema: {
            type: 'object',
            properties: {
              filepath: { type: 'string' },
            },
            required: ['filepath'],
          },
        },
      ],
      handlers: {
        read_file: async ({ filepath }) => {
          await self.logger.tool('FileTools', `read_file: ${filepath}`);
          try {
            // AUDIT FIX: Block reading sensitive files that would leak secrets to the API.
            const SENSITIVE_PATTERNS = [
              /^\.env(\..*)?$/i,                  // .env, .env.local, .env.production, etc.
              /\/(\.env(\..*)?$)/i,               // nested .env files
              /credentials\.json$/i,
              /\.pem$/i,
              /\.key$/i,
              /id_rsa/i,
              /\.pgpass$/i,
              /auth\.json$/i,                     // Composer auth tokens
            ];
            const normalizedPath = filepath.replace(/\\/g, '/');
            // SEC-003 FIX: Use path.basename() instead of string split for robust extraction
            const fileBasename = basename(normalizedPath);
            if (SENSITIVE_PATTERNS.some(p => p.test(fileBasename) || p.test(normalizedPath))) {
              return { error: `Blocked: '${filepath}' appears to be a sensitive file (credentials/secrets). It will not be sent to the API.` };
            }
            // FINDING-12 FIX: Guard against oversized files that could blow up context
            const fileSize = self.getFileSize(filepath);
            if (fileSize > 1_048_576) { // 1MB
              return { error: `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Maximum readable size is 1MB. Consider reading specific sections.`, filepath };
            }
            // SEC-2 FIX: Wrap file contents in explicit delimiters to mitigate prompt injection.
            // M9 FIX: Use a randomised delimiter so a malicious file can't include
            // the closing tag to escape the boundary.
            // MED-3 FIX: Use crypto.randomUUID() for a stronger boundary
            const boundary = `file_content_${randomUUID().replace(/-/g, '')}`;
            const raw = self.readFile(filepath);
            return { content: `<${boundary} path="${filepath}">\n${raw}\n</${boundary}>`, filepath };
          } catch (e) {
            return { error: e.message };
          }
        },
        write_file: async ({ filepath, content }) => {
          await self.logger.tool('FileTools', `write_file: ${filepath}`);
          // MED-5 FIX: Guard against concurrent tool calls on the same FileTools instance
          if (_activeToolCall) {
            return { error: 'Concurrent tool call detected — agents must not share a FileTools instance simultaneously.' };
          }
          _activeToolCall = true;
          try {
            // FIX #1 (SEC-4 bypass): Check the resolved absolute path, not raw input.
            // This prevents bypasses like "app/../.shift/state.json" and case-insensitive
            // filesystem tricks (.Shift/, .SHIFT/) on macOS/Windows.
            const abs = self._abs(filepath);
            const shiftDir = join(self.projectPath, '.shift');
            const shiftPrefix = shiftDir + (shiftDir.endsWith(sep) ? '' : sep);
            // FINDING-3 FIX: Normalize to lowercase on case-insensitive filesystems
            // to prevent bypasses like .Shift/ or .SHIFT/ on macOS/Windows
            const isCaseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
            const absCheck = isCaseInsensitive ? abs.toLowerCase() : abs;
            const shiftDirCheck = isCaseInsensitive ? shiftDir.toLowerCase() : shiftDir;
            const shiftPrefixCheck = isCaseInsensitive ? shiftPrefix.toLowerCase() : shiftPrefix;
            if (absCheck === shiftDirCheck || absCheck.startsWith(shiftPrefixCheck)) {
              return { error: 'Cannot write to .shift/ directory — this is reserved for shift state and backups.' };
            }

            // AUDIT FIX: Block writes to default protected directories regardless of .shiftrc config.
            // These are never valid write targets for an upgrade agent.
            const DEFAULT_PROTECTED = ['vendor', 'node_modules', '.git', 'storage/framework', 'bootstrap/cache'];
            let normalizedWrite = normalize(filepath).replace(/\\/g, '/').replace(/^\.\//, '');
            if (isCaseInsensitive) normalizedWrite = normalizedWrite.toLowerCase();
            for (const prot of DEFAULT_PROTECTED) {
              const protCheck = isCaseInsensitive ? prot.toLowerCase() : prot;
              if (normalizedWrite === protCheck || normalizedWrite.startsWith(protCheck + '/')) {
                return { error: `Cannot write to protected directory: ${filepath}` };
              }
            }

            // SEC-007 FIX: Block writes of executable script extensions that an LLM should never create
            const BLOCKED_EXTENSIONS = ['.sh', '.bat', '.cmd', '.ps1', '.exe', '.com', '.msi', '.vbs', '.wsf'];
            const ext = filepath.toLowerCase().substring(filepath.lastIndexOf('.'));
            if (BLOCKED_EXTENSIONS.includes(ext)) {
              return { error: `Cannot write executable file type (${ext}): ${filepath}` };
            }

            // FIX #15: Block writes to excluded directories
            if (self._isExcludedPath(filepath)) {
              return { error: `Cannot write to excluded path: ${filepath}` };
            }

            // AUDIT FIX: Reject oversized writes to prevent disk exhaustion
            if (content.length > 5_242_880) { // 5MB
              return { error: `Content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Maximum writable size is 5MB.` };
            }

            // FIX FINDING-1: Only backup if no backup exists yet, preventing
            // overwrite of pristine original with partially-transformed content on retry
            if (!self.hasBackup(filepath)) {
              self.backup(filepath);
            }
            self.writeFile(filepath, content);
            return { ok: true, filepath };
          } catch (e) {
            return { error: e.message };
          } finally {
            _activeToolCall = false;
          }
        },
        list_files: async ({ pattern }) => {
          await self.logger.tool('FileTools', `list_files: ${pattern}`);
          try {
            // SEC-002 FIX: Reject glob patterns containing path traversal or absolute paths
            if (pattern.includes('..') || pattern.startsWith('/') || pattern.startsWith('\\')) {
              return { error: `Blocked: glob pattern '${pattern}' contains path traversal or absolute path segments` };
            }
            const files = await self.findFiles(pattern);
            return { files };
          } catch (e) {
            return { error: e.message };
          }
        },
        file_exists: async ({ filepath }) => {
          try {
            return { exists: self.fileExists(filepath), filepath };
          } catch (e) {
            return { error: e.message };
          }
        },
      },
    };
  }
}
