/**
 * Transform: Replace orderBy('created_at', ...) with latest()/oldest()
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'latest-oldest',
  description: "Replace orderBy('created_at', ...) with latest()/oldest()",
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src}/**/*.php',

  detect(content) {
    return /->orderBy\(\s*['"]created_at['"]\s*,\s*['"](desc|asc)['"]\s*\)/i.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    let transformed = content;

    // orderBy('created_at', 'desc') -> latest()
    transformed = transformed.replace(
      /->orderBy\(\s*['"]created_at['"]\s*,\s*['"]desc['"]\s*\)/gi,
      () => { count++; return '->latest()'; }
    );

    // orderBy('created_at', 'asc') -> oldest()
    transformed = transformed.replace(
      /->orderBy\(\s*['"]created_at['"]\s*,\s*['"]asc['"]\s*\)/gi,
      () => { count++; return '->oldest()'; }
    );

    return {
      content: transformed,
      changed: count > 0,
      description: `Replaced ${count} orderBy('created_at') call(s) with latest()/oldest()`,
    };
  },
};
