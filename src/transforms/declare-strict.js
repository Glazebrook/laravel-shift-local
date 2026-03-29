/**
 * Transform: Add declare(strict_types=1) to PHP files
 * Ported from Laravel Shift CLI (MIT)
 *
 * Opt-in transform (disabled by default) — can break loosely typed code.
 */

export default {
  name: 'declare-strict',
  description: 'Add declare(strict_types=1) to PHP files',
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src,database}/**/*.php',
  configKey: 'declare-strict',
  defaultEnabled: false,

  detect(content) {
    // File has <?php but NOT declare(strict_types=1)
    return /^<\?php/m.test(content) && !/declare\s*\(\s*strict_types\s*=\s*1\s*\)/m.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    // Insert declare(strict_types=1) after <?php tag
    const transformed = content.replace(
      /^(<\?php)\s*\n/m,
      '$1\n\ndeclare(strict_types=1);\n\n'
    );

    // If the replacement didn't change anything (unusual <?php format), try harder
    if (transformed === content) {
      const alt = content.replace(
        /^<\?php/m,
        '<?php\n\ndeclare(strict_types=1);'
      );
      return {
        content: alt,
        changed: alt !== content,
        description: 'Added declare(strict_types=1)',
      };
    }

    return {
      content: transformed,
      changed: true,
      description: 'Added declare(strict_types=1)',
    };
  },
};
