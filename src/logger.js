/**
 * Logger - Structured logging with console + file output
 * M4 FIX: Uses a write buffer that flushes periodically instead of
 * blocking the event loop with appendFileSync on every log line.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join } from 'path';

let chalk;
let chalkLoadFailed = false;

// FINDING-15 FIX: Named constant for buffer flush threshold
const BUFFER_FLUSH_THRESHOLD = 50;
function getChalkSync() {
  return chalk || null;
}
async function getChalk() {
  if (chalk) return chalk;
  if (chalkLoadFailed) return null;
  try {
    chalk = (await import('chalk')).default;
    return chalk;
  } catch {
    chalkLoadFailed = true;
    return null;
  }
}


// FINDING-11 FIX: Module-level registry to ensure process handlers are registered only once.
// Multiple Logger instances share the same handlers; each instance registers itself for cleanup.
const _loggerInstances = new Set();
let _processHandlersRegistered = false;

function _registerProcessHandlers() {
  if (_processHandlersRegistered) return;
  _processHandlersRegistered = true;
  process.once('beforeExit', () => {
    for (const logger of _loggerInstances) logger._flushBuffer();
  });
  process.once('exit', () => {
    for (const logger of _loggerInstances) logger._flushBufferSync();
  });
}

export class Logger {
  constructor(projectPath, verbose = false) {
    this.projectPath = projectPath;
    this.verbose = verbose;
    this.logPath = join(projectPath, '.shift', 'shift.log');
    this._ensureLogDir();

    // M4 FIX: Write buffer for async log file writes
    this._buffer = [];
    this._flushInterval = setInterval(() => this._flushBuffer(), 1000);
    this._flushInterval.unref(); // Don't keep process alive for logging

    // FINDING-11 FIX: Register this instance and set up process handlers once
    _loggerInstances.add(this);
    _registerProcessHandlers();
  }

  _ensureLogDir() {
    // M11 FIX: mkdirSync({ recursive: true }) is a no-op for existing directories
    // and handles concurrent creation safely. No need for the existsSync pre-check.
    const dir = join(this.projectPath, '.shift');
    mkdirSync(dir, { recursive: true });
  }

  /**
   * M4 FIX: Buffer log lines instead of blocking with appendFileSync.
   */
  _write(level, agent, message, data = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] [${agent}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
    this._buffer.push(line);

    // Auto-flush if buffer gets large
    if (this._buffer.length >= BUFFER_FLUSH_THRESHOLD) {
      this._flushBuffer();
    }
  }

  /**
   * H4 FIX: _flushBuffer is now genuinely async using fs.promises.appendFile
   * instead of the synchronous appendFileSync. The 1-second interval timer
   * no longer blocks the event loop with synchronous I/O.
   */
  async _flushBuffer() {
    if (this._buffer.length === 0) return;
    const lines = this._buffer.splice(0);
    try {
      await appendFile(this.logPath, lines.join(''));
    } catch { /* non-fatal */ }
  }

  /**
   * M4 FIX: Synchronous flush for process exit handler.
   */
  _flushBufferSync() {
    if (this._buffer.length === 0) return;
    try {
      appendFileSync(this.logPath, this._buffer.join(''));
      this._buffer.length = 0;
    } catch { /* non-fatal */ }
  }

  async _print(level, agent, message, data = null) {
    let c = getChalkSync();
    if (c === null && !chalkLoadFailed) {
      c = await getChalk();
    }
    const agentLabel = agent
      ? (c ? c.cyan(`[${agent}]`) : `[${agent}]`)
      : '';
    const ts = c
      ? c.gray(new Date().toLocaleTimeString())
      : new Date().toLocaleTimeString();

    if (!c) {
      const prefix = `${ts} ${level.padEnd(5)} ${agentLabel}`;
      switch (level) {
        case 'DEBUG':
          if (this.verbose) console.log(`${prefix} ${message}`);
          break;
        case 'PHASE':
          console.log(`\n━━━ ${message} ━━━\n`);
          break;
        case 'ERROR':
          console.error(`${prefix} ${message}`);
          if (data && this.verbose) console.error(data);
          break;
        case 'WARN':
          console.warn(`${prefix} ${message}`);
          break;
        case 'TOOL':
          if (this.verbose) console.log(`${prefix} ${message}`);
          break;
        default:
          console.log(`${prefix} ${message}`);
      }
      this._write(level, agent, message, data);
      return;
    }

    switch (level) {
      case 'DEBUG':
        if (this.verbose) console.log(`${ts} ${c.gray('DEBUG')} ${agentLabel} ${c.gray(message)}`);
        break;
      case 'INFO':
        console.log(`${ts} ${c.blue('INFO')}  ${agentLabel} ${message}`);
        break;
      case 'WARN':
        console.warn(`${ts} ${c.yellow('WARN')}  ${agentLabel} ${c.yellow(message)}`);
        break;
      case 'ERROR':
        console.error(`${ts} ${c.red('ERROR')} ${agentLabel} ${c.red(message)}`);
        if (data && this.verbose) console.error(data);
        break;
      case 'SUCCESS':
        console.log(`${ts} ${c.green('✔ OK')}  ${agentLabel} ${c.green(message)}`);
        break;
      case 'PHASE':
        console.log(`\n${c.bold.magenta('━━━ ' + message + ' ━━━')}\n`);
        break;
      case 'TOOL':
        if (this.verbose) console.log(`${ts} ${c.magenta('TOOL')}  ${agentLabel} ${c.magenta(message)}`);
        break;
    }

    this._write(level, agent, message, data);
  }

  debug(agent, msg, data) { return this._print('DEBUG', agent, msg, data); }
  info(agent, msg, data) { return this._print('INFO', agent, msg, data); }
  warn(agent, msg, data) { return this._print('WARN', agent, msg, data); }
  error(agent, msg, data) { return this._print('ERROR', agent, msg, data); }
  success(agent, msg, data) { return this._print('SUCCESS', agent, msg, data); }
  phase(label) { return this._print('PHASE', '', label); }
  tool(agent, msg) { return this._print('TOOL', agent, msg); }

  /**
   * FIX #10: Clean up the flush interval and process event handlers.
   * Prevents interval accumulation in test environments or when multiple
   * Logger instances are created.
   */
  destroy() {
    if (this._flushInterval) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
    }
    this._flushBufferSync();
    // FINDING-11 FIX: Remove from instance set so process handlers don't reference destroyed loggers
    _loggerInstances.delete(this);
  }
}
