/**
 * Transform: Convert string class references to ::class syntax
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'class-strings',
  description: 'Convert string class references to ::class syntax',
  appliesFrom: '8',
  appliesTo: null,
  glob: 'app/**/*.php',

  detect(content) {
    // Match strings like 'App\Models\User' or "App\Models\User"
    // Must have at least one backslash (namespace separator)
    return /['"]App\\[A-Z][^'"]*['"]/g.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    const transformed = content.replace(
      /['"]((App|Illuminate)\\[A-Z][a-zA-Z0-9\\]*)['"]/g,
      (match, className, _prefix, offset) => {
        // Skip if inside a comment
        const lineStart = content.lastIndexOf('\n', offset) + 1;
        const linePrefix = content.substring(lineStart, offset).trimStart();
        if (linePrefix.startsWith('//') || linePrefix.startsWith('*') || linePrefix.startsWith('/*')) {
          return match;
        }

        // Skip if this looks like an array key (e.g., 'App\Models\User' => ...)
        const afterMatch = content.substring(offset + match.length, offset + match.length + 10).trimStart();
        if (afterMatch.startsWith('=>')) {
          return match;
        }

        count++;
        return `\\${className}::class`;
      }
    );

    return {
      content: transformed,
      changed: count > 0,
      description: `Converted ${count} string class reference(s) to ::class syntax`,
    };
  },
};
