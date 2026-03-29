/**
 * Transform: Remove debug function calls
 * Ported from Laravel Shift CLI (MIT)
 *
 * Removes: var_dump(), print_r(), dd(), dump(), ray(), debug()
 * Preserves: logger() calls (intentional logging), calls in test files
 */

export default {
  name: 'debug-calls',
  description: 'Remove debug function calls (dd, dump, var_dump, print_r, ray)',
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src,routes,config}/**/*.php',
  configKey: 'debug-calls',
  defaultEnabled: true,

  detect(content) {
    return /^\s*(var_dump|print_r|dd|dump|ray)\s*\(/m.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    // Remove entire lines that are standalone debug calls
    // Match: optional whitespace, debug function, arguments, semicolon, newline
    const transformed = content.replace(
      /^[ \t]*(var_dump|print_r|dd|dump|ray)\s*\([^;]*\);\s*\n?/gm,
      () => {
        count++;
        return '';
      }
    );

    return {
      content: transformed,
      changed: count > 0,
      description: `Removed ${count} debug call(s)`,
    };
  },
};
