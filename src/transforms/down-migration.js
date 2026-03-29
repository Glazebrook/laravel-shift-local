/**
 * Transform: Remove down() method from migrations
 * Ported from Laravel Shift CLI (MIT)
 *
 * Opt-in (disabled by default) — controversial, user-configurable.
 */

export default {
  name: 'down-migration',
  description: 'Remove down() method from migrations',
  appliesFrom: '8',
  appliesTo: null,
  glob: 'database/migrations/**/*.php',
  configKey: 'down-migration',
  defaultEnabled: false,

  detect(content) {
    return /public\s+function\s+down\s*\(/m.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    // Remove the entire down() method including its body
    // Match: public function down() { ... }
    // Use a brace-counting approach for nested braces
    const downMatch = content.match(/(\n\s*(?:\/\*\*[\s\S]*?\*\/\s*\n\s*)?public\s+function\s+down\s*\([^)]*\)[^{]*\{)/);
    if (!downMatch) {
      return { content, changed: false, description: '' };
    }

    const startIdx = downMatch.index;
    const braceStart = startIdx + downMatch[0].length - 1;
    let depth = 1;
    let i = braceStart + 1;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }

    // Remove the method and any trailing blank line
    let endIdx = i;
    while (endIdx < content.length && content[endIdx] === '\n') endIdx++;
    // Keep one newline
    if (endIdx > i) endIdx--;

    const transformed = content.substring(0, startIdx) + content.substring(endIdx);

    return {
      content: transformed,
      changed: transformed !== content,
      description: 'Removed down() method from migration',
    };
  },
};
