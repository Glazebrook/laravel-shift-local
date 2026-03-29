/**
 * Transform: Remove redundant $table properties from Eloquent models
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'model-table',
  description: 'Remove redundant $table properties that match Laravel convention',
  appliesFrom: '8',
  appliesTo: null,
  glob: 'app/Models/**/*.php',

  detect(content) {
    return /protected\s+\$table\s*=\s*['"][^'"]+['"]\s*;/.test(content);
  },

  transform(content, filePath) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    // Extract class name
    const classMatch = content.match(/class\s+(\w+)\s+extends/);
    if (!classMatch) {
      return { content, changed: false, description: '' };
    }
    const className = classMatch[1];

    // Extract table name from $table property
    const tableMatch = content.match(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]\s*;/);
    if (!tableMatch) {
      return { content, changed: false, description: '' };
    }
    const tableName = tableMatch[1];

    // Compute Laravel's conventional table name:
    // PascalCase -> snake_case -> pluralise (basic: add 's')
    const snaked = className
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');

    // Basic pluralisation (handles most common cases)
    let conventional;
    if (snaked.endsWith('y') && !snaked.endsWith('ay') && !snaked.endsWith('ey') && !snaked.endsWith('oy') && !snaked.endsWith('uy')) {
      conventional = snaked.slice(0, -1) + 'ies';
    } else if (snaked.endsWith('s') || snaked.endsWith('x') || snaked.endsWith('z') || snaked.endsWith('sh') || snaked.endsWith('ch')) {
      conventional = snaked + 'es';
    } else {
      conventional = snaked + 's';
    }

    if (tableName !== conventional) {
      return { content, changed: false, description: '' };
    }

    // Remove the redundant $table line
    const transformed = content.replace(
      /\n?\s*protected\s+\$table\s*=\s*['"][^'"]+['"]\s*;\n?/,
      '\n'
    );

    return {
      content: transformed,
      changed: transformed !== content,
      description: `Removed redundant $table = '${tableName}' (matches convention)`,
    };
  },
};
