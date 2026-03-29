/**
 * Transform: Convert string validation rules to arrays
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'rules-arrays',
  description: 'Convert pipe-delimited validation rules to arrays',
  appliesFrom: '8',
  appliesTo: null,
  glob: 'app/**/*.php',

  detect(content) {
    // Match 'required|string|max:255' patterns inside validation contexts
    return /=>\s*['"][a-z_]+(\|[a-z_:,0-9]+)+['"]/i.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;
    // Match: 'key' => 'required|string|max:255'
    const transformed = content.replace(
      /(=>\s*)['"]([a-z_]+(?:\|[a-z_:,0-9]+)+)['"]/gi,
      (_match, arrow, rules) => {
        const parts = rules.split('|').map(r => `'${r}'`);
        count++;
        return `${arrow}[${parts.join(', ')}]`;
      }
    );

    return {
      content: transformed,
      changed: count > 0,
      description: `Converted ${count} validation rule string(s) to arrays`,
    };
  },
};
