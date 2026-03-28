/**
 * ReporterAgent - Generates the final SHIFT_REPORT.md
 * H7 FIX: Uses structured JSON from AI + template rendering
 * instead of writing raw AI text directly to the report file.
 */

import { BaseAgent } from './base-agent.js';
import { join } from 'node:path';

export class ReporterAgent extends BaseAgent {
  constructor(deps) {
    const model = deps.config?.models?.reporter || 'claude-sonnet-4-6';
    super('ReporterAgent', { model, ...deps });
    this.fileTools = deps.fileTools;
    this.projectPath = deps.projectPath;
    this.git = deps.git;
  }

  async generateReport(state) {
    await this.logger.phase('PHASE 6: Generating Report');

    const {
      fromVersion, toVersion, analysis,
      transformations, validation, branchName, phaseTimings,
      tokenUsage,
    } = state;

    const gitLog = await this.git.getLog(20);

    // H7 FIX: Ask the AI to return structured JSON, then render from template
    const systemPrompt = `You are a technical writer creating structured data for a shift upgrade report.
Return a JSON object with these fields:
{
  "executiveSummary": "2-3 sentence overview of the upgrade",
  "automaticChanges": [
    { "file": "filepath", "description": "what was changed" }
  ],
  "manualReviewItems": [
    { "file": "filepath", "issue": "description", "suggestedPrompt": "a prompt the developer can paste into Claude for help" }
  ],
  "testSummary": "summary of test results",
  "warnings": ["list of warnings"],
  "nextSteps": ["ordered list of things the developer should do"]
}

Be thorough and accurate. Only reference files and changes that actually exist in the data provided.
Do NOT hallucinate file paths or error messages — only report what's in the input data.`;

    const messages = [{
      role: 'user',
      content: `Generate report data for this upgrade:

FROM: Laravel ${fromVersion}
TO: Laravel ${toVersion}
BRANCH: ${branchName}

ANALYSIS SUMMARY:
${JSON.stringify(analysis?.summary || 'N/A')}
Complexity: ${analysis?.upgradeComplexity}

TRANSFORMATIONS:
- Total files: ${transformations.total}
- Completed: ${transformations.completed}
- Failed: ${transformations.failed}
- Skipped: ${transformations.skipped}

COMPLETED FILES:
${Object.entries(transformations.files || {})
  .filter(([, v]) => v.status === 'done')
  .map(([k, v]) => `- ${k}: ${(v.changesApplied || []).join(', ')}`)
  .join('\n') || 'None'}

FAILED FILES:
${Object.entries(transformations.files || {})
  .filter(([, v]) => v.status === 'failed')
  .map(([k, v]) => `- ${k}: ${v.error}`)
  .join('\n') || 'None'}

VALIDATION:
- Passed: ${validation?.passed}
- Syntax errors: ${validation?.syntaxErrors?.length || 0}
- Artisan errors: ${validation?.artisanErrors?.length || 0}
- Tests: ${validation?.testsRun ? (validation.testsRun.passed ? 'PASSING' : 'FAILING') : 'Not run'}

MANUAL REVIEW REQUIRED:
${analysis?.manualReviewRequired?.join('\n') || 'None identified'}

SUGGESTIONS:
${validation?.suggestions?.join('\n') || 'None'}

Return the structured JSON now.`,
    }];

    let reportData;
    try {
      reportData = await this.runForJson(systemPrompt, messages);
    } catch (err) {
      // H7 FIX: Fallback to basic report if AI fails
      await this.logger.warn(this.name, `AI report generation failed: ${err.message}. Generating basic report.`);
      reportData = {
        executiveSummary: `Upgrade from Laravel ${fromVersion} to ${toVersion}. ${transformations.completed}/${transformations.total} files transformed.`,
        automaticChanges: Object.entries(transformations.files || {})
          .filter(([, v]) => v.status === 'done')
          .map(([k, v]) => ({ file: k, description: v.description || 'Transformed' })),
        manualReviewItems: (analysis?.manualReviewRequired || []).map(item => ({
          file: '', issue: item, suggestedPrompt: '',
        })),
        testSummary: validation?.testsRun
          ? (validation.testsRun.passed ? 'All tests passing' : 'Test failures detected')
          : 'Tests not run',
        warnings: validation?.suggestions || [],
        nextSteps: [
          'Review the manual review items below',
          'Run php artisan to verify the application boots',
          'Run php artisan test to verify the test suite',
          `Create a PR from ${branchName}`,
        ],
      };
    }

    // H7 FIX: Render report from template with validated data
    const report = this._renderReport(reportData, {
      fromVersion, toVersion, branchName, transformations, validation,
      gitLog, phaseTimings: phaseTimings || {}, tokenUsage: tokenUsage || {},
    });

    const reportRelPath = 'SHIFT_REPORT.md';
    this.fileTools.backup(reportRelPath);
    this.fileTools.writeFile(reportRelPath, report);
    const reportPath = join(this.projectPath, reportRelPath);

    await this.logger.success(this.name, `Report written to SHIFT_REPORT.md`);

    return { reportPath, report: report.substring(0, 500) + '...' };
  }

  /**
   * H7 FIX: Template-driven report rendering from structured data.
   * Ensures the report has a consistent format regardless of AI output quirks.
   */
  /**
   * MED-2 FIX: Escape pipe and backtick characters in user-controlled data
   * to prevent markdown table/inline-code corruption.
   */
  _escMd(str) {
    return String(str).replace(/\|/g, '\\|').replace(/`/g, '\\`');
  }

  /** A2-006 FIX: Strip triple-backtick sequences from content embedded in code fences */
  _escCodeFence(str) {
    return String(str).replace(/`{3,}/g, '``');
  }

  _renderReport(data, context) {
    const { fromVersion, toVersion, branchName, transformations, validation, gitLog, phaseTimings, tokenUsage } = context;

    // M3 FIX: Calculate total duration
    const totalMs = Object.values(phaseTimings).reduce((sum, t) => sum + (t.durationMs || 0), 0);
    const durationLabel = totalMs > 0 ? ` (${(totalMs / 1000).toFixed(1)}s)` : '';

    let md = `# Laravel Shift Report\n\n`;
    md += `**Upgrade:** Laravel ${fromVersion} → ${toVersion}  \n`;
    md += `**Branch:** \`${branchName}\`  \n`;
    md += `**Generated:** ${new Date().toISOString()}${durationLabel}  \n\n`;

    // Executive Summary
    md += `## Executive Summary\n\n`;
    md += `${data.executiveSummary || 'No summary available.'}\n\n`;

    // Stats
    md += `## Transformation Summary\n\n`;
    md += `| Metric | Count |\n|--------|-------|\n`;
    md += `| Total files | ${transformations.total} |\n`;
    md += `| Completed | ${transformations.completed} |\n`;
    md += `| Failed | ${transformations.failed} |\n`;
    md += `| Skipped | ${transformations.skipped} |\n`;
    md += `| Validation | ${validation?.passed ? '✅ PASSED' : '⚠️ WARNINGS'} |\n\n`;

    // Phase timings
    if (Object.keys(phaseTimings).length > 0) {
      md += `## Phase Timings\n\n`;
      md += `| Phase | Duration |\n|-------|----------|\n`;
      for (const [phase, timing] of Object.entries(phaseTimings)) {
        md += `| ${phase} | ${(timing.durationMs / 1000).toFixed(1)}s |\n`;
      }
      md += `\n`;
    }

    // Token Usage
    if (tokenUsage && Object.keys(tokenUsage).length > 0) {
      md += `## Token Usage\n\n`;
      md += `| Agent | Input Tokens | Output Tokens | API Calls |\n`;
      md += `|-------|-------------|---------------|-----------|\n`;
      let totalInput = 0, totalOutput = 0, totalCalls = 0;
      for (const [agent, usage] of Object.entries(tokenUsage)) {
        const inp = usage.input || 0;
        const out = usage.output || 0;
        const calls = usage.calls || 0;
        totalInput += inp;
        totalOutput += out;
        totalCalls += calls;
        md += `| ${agent} | ${inp.toLocaleString()} | ${out.toLocaleString()} | ${calls} |\n`;
      }
      md += `| **Total** | **${totalInput.toLocaleString()}** | **${totalOutput.toLocaleString()}** | **${totalCalls}** |\n\n`;
    }

    // Automatic Changes
    if (data.automaticChanges?.length > 0) {
      md += `## Automatic Changes\n\n`;
      for (const change of data.automaticChanges) {
        // MED-2 FIX: Escape markdown in user-controlled data
        md += `- **\`${this._escMd(change.file)}\`**: ${this._escMd(change.description)}\n`;
      }
      md += `\n`;
    }

    // Manual Review Items
    if (data.manualReviewItems?.length > 0) {
      md += `## ⚠️ Manual Review Required\n\n`;
      for (const item of data.manualReviewItems) {
        md += `### ${this._escMd(item.file || 'General')}\n\n`;
        md += `${this._escMd(item.issue)}\n\n`;
        if (item.suggestedPrompt) {
          md += `<details>\n<summary>Claude prompt for this item</summary>\n\n\`\`\`\n${this._escCodeFence(item.suggestedPrompt)}\n\`\`\`\n\n</details>\n\n`;
        }
      }
    }

    // Test Results
    md += `## Test Results\n\n`;
    md += `${data.testSummary || 'Tests were not run.'}\n\n`;
    if (validation?.testsRun?.output) {
      md += `<details>\n<summary>Test output</summary>\n\n\`\`\`\n${this._escCodeFence(validation.testsRun.output)}\n\`\`\`\n\n</details>\n\n`;
    }

    // Warnings
    if (data.warnings?.length > 0) {
      md += `## Warnings\n\n`;
      for (const w of data.warnings) {
        md += `- ${this._escMd(w)}\n`;
      }
      md += `\n`;
    }

    // Failed files
    const failedFiles = Object.entries(transformations.files || {})
      .filter(([, v]) => v.status === 'failed');
    if (failedFiles.length > 0) {
      md += `## ❌ Failed Transformations\n\n`;
      for (const [filepath, info] of failedFiles) {
        // MED-2 FIX: Escape markdown in file paths and error messages
        md += `- **\`${this._escMd(filepath)}\`**: ${this._escMd(info.error)}\n`;
      }
      md += `\n`;
    }

    // Next Steps
    md += `## Next Steps\n\n`;
    const steps = data.nextSteps || [
      'Review manual review items above',
      'Run `php artisan` to verify the application boots',
      'Run `php artisan test` to verify the test suite',
      `Create a PR from \`${branchName}\``,
    ];
    steps.forEach((step, i) => {
      md += `${i + 1}. ${step}\n`;
    });
    md += `\n`;

    // Git Log
    if (gitLog) {
      md += `## Git Log\n\n\`\`\`\n${this._escCodeFence(gitLog)}\n\`\`\`\n`;
    }

    return md;
  }
}
