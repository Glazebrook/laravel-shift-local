/**
 * Shared utilities — extracted to avoid duplication across modules.
 * L1 FIX: sleep() was duplicated in base-agent.js and orchestrator.js.
 */

// P3-002 FIX: unref() the timer so it doesn't keep the process alive during shutdown
export function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
