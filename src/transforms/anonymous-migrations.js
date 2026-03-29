/**
 * Transform: Convert class-based migrations to anonymous classes
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'anonymous-migrations',
  description: 'Convert class-based database migrations to anonymous classes',
  appliesFrom: '8',
  appliesTo: null,
  glob: 'database/migrations/**/*.php',

  detect(content) {
    return /class\s+\w+\s+extends\s+Migration/i.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    // Replace "class SomeName extends Migration" with "return new class extends Migration"
    let transformed = content.replace(
      /class\s+\w+\s+extends\s+Migration/i,
      'return new class extends Migration'
    );

    // If the file ends with just "}" on the last line (closing the class),
    // add a semicolon: "};"
    transformed = transformed.replace(/\}\s*$/, '};\n');

    return {
      content: transformed,
      changed: transformed !== content,
      description: 'Converted to anonymous migration class',
    };
  },
};
