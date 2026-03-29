/**
 * Transform: Replace Carbon\Carbon with Illuminate\Support\Carbon
 * Ported from Laravel Shift CLI (MIT)
 */

export default {
  name: 'laravel-carbon',
  description: 'Replace Carbon\\Carbon with Illuminate\\Support\\Carbon',
  appliesFrom: '8',
  appliesTo: null,
  glob: '{app,src,database,config}/**/*.php',

  detect(content) {
    return /Carbon\\Carbon/m.test(content);
  },

  transform(content) {
    if (!this.detect(content)) {
      return { content, changed: false, description: '' };
    }

    let count = 0;

    // Replace use statement
    let transformed = content.replace(
      /use\s+Carbon\\Carbon\s*;/g,
      () => { count++; return 'use Illuminate\\Support\\Carbon;'; }
    );

    // Replace inline references
    transformed = transformed.replace(
      /Carbon\\Carbon::/g,
      () => { count++; return 'Carbon::'; }
    );

    // If we replaced an inline Carbon\Carbon:: but there's no use statement yet, add one
    if (count > 0 && !/use\s+Illuminate\\Support\\Carbon\s*;/.test(transformed)) {
      // Add use statement after the namespace declaration
      transformed = transformed.replace(
        /(namespace\s+[^;]+;\s*\n)/,
        '$1\nuse Illuminate\\Support\\Carbon;\n'
      );
    }

    return {
      content: transformed,
      changed: count > 0,
      description: `Replaced ${count} Carbon\\Carbon reference(s) with Illuminate\\Support\\Carbon`,
    };
  },
};
