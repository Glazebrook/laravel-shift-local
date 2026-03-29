/**
 * Transform: Replace orderBy('column', 'desc') with orderByDesc('column')
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'explicit-orderby',
  description: "Replace orderBy('column', 'desc') with orderByDesc('column')",
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src}/**/*.php',

  detect(content) {
    // Match orderBy with 'desc' direction but NOT 'created_at' (handled by latest-oldest)
    return /->orderBy\(\s*['"](?!created_at)[^'"]+['"]\s*,\s*['"]desc['"]\s*\)/i.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    const transformed = content.replace(
      /->orderBy\(\s*['"](?!created_at)([^'"]+)['"]\s*,\s*['"]desc['"]\s*\)/gi,
      (_match, column) => {
        count++;
        return `->orderByDesc('${column}')`;
      }
    );

    return {
      content: transformed,
      changed: count > 0,
      description: `Replaced ${count} orderBy(..., 'desc') with orderByDesc()`,
    };
  },
};
