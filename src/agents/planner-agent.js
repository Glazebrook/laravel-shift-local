/**
 * PlannerAgent - Creates a detailed, ordered upgrade plan
 * Uses Opus for strategic planning
 */

import { BaseAgent } from './base-agent.js';
import { getCombinedMatrix } from '../../config/upgrade-matrix.js';

export class PlannerAgent extends BaseAgent {
  constructor(deps) {
    const model = deps.config?.models?.planner || 'claude-opus-4-6';
    // H12 FIX: Opus agents get 16384 max_tokens to handle large project plans
    super('PlannerAgent', { model, ...deps, maxTokens: 16384 });
    this.fileTools = deps.fileTools;
  }

  /**
   * H6 FIX: Now accepts completedFiles parameter so the planner knows
   * which files have already been transformed on resume.
   */
  async plan(analysis, fromVersion, toVersion, completedFiles = []) {
    await this.logger.phase('PHASE 2: Planning Upgrade');

    const matrix = getCombinedMatrix(
      String(fromVersion).split('.')[0],
      String(toVersion).split('.')[0]
    );
    const matrixHints = matrix.hints || [];
    const matrixBreaking = matrix.breaking || [];

    // M10 FIX: For wide jumps (5+ breaking changes), summarise by version step
    // to avoid overwhelming the planner's context
    let breakingSection;
    if (matrixBreaking.length > 40) {
      breakingSection = `NOTE: This is a wide upgrade jump with ${matrixBreaking.length} breaking changes across multiple versions.\n` +
        `Key breaking changes (summarised — full list available in upgrade matrix):\n` +
        matrixBreaking.slice(0, 30).map(b => `- ${b}`).join('\n') +
        `\n... and ${matrixBreaking.length - 30} more. Focus on the CRITICAL items first.`;
    } else {
      breakingSection = matrixBreaking.map(b => `- ${b}`).join('\n');
    }

    // H6 FIX: Build context about already-completed transformations
    let completedContext = '';
    if (completedFiles.length > 0) {
      completedContext = `\n\nALREADY COMPLETED TRANSFORMATIONS (from a previous partial run — DO NOT re-plan these):\n` +
        completedFiles.map(f => `- ${f.filepath}: ${f.description}`).join('\n') +
        `\n\nYour plan should account for these already-applied changes. Do not generate conflicting steps.`;
    }

    const systemPrompt = `You are a senior Laravel architect creating a precise, ordered upgrade execution plan.

You understand all breaking changes between Laravel versions and how to safely migrate applications.

Known breaking changes for this upgrade path:
${breakingSection}

Additional upgrade hints:
${matrixHints.map(h => `- ${h}`).join('\n')}

Your plan must be executable by automated agents — be specific, ordered, and safe.

Output a JSON object with this structure:
{
  "phases": [
    {
      "phase": "dependencies",
      "description": "Update composer.json",
      "steps": [
        {
          "id": "dep_1",
          "type": "composer_update",
          "description": "...",
          "composerRequire": {},
          "composerRequireDev": {},
          "composerRemove": []
        }
      ]
    },
    {
      "phase": "code_transforms",
      "description": "Transform PHP files",
      "steps": [
        {
          "id": "transform_001",
          "type": "file_transform",
          "filepath": "app/Http/Kernel.php",
          "description": "Remove Kernel class - replaced by bootstrap/app.php middleware",
          "priority": "critical|high|medium|low",
          "searchPatterns": [],
          "replacePatterns": [],
          "fullRewrite": false,
          "instructions": "Specific instructions for the transformer agent"
        }
      ]
    },
    {
      "phase": "config_transforms",
      "steps": []
    },
    {
      "phase": "validation",
      "steps": [
        { "id": "val_1", "type": "artisan_check", "command": "php artisan config:clear" }
      ]
    }
  ],
  "composerJsonTarget": {
    "require": { "php": ">=8.2", "laravel/framework": "^13.0" },
    "require-dev": {}
  },
  "totalEstimatedChanges": 0,
  "criticalItems": [],
  "notes": []
}

IMPORTANT: When you are done, your FINAL message must be ONLY the JSON object. Start with { and end with }. Do not write anything before or after the JSON.`;

    const messages = [{
      role: 'user',
      content: `Based on this project analysis, create a complete upgrade plan from Laravel ${fromVersion} to ${toVersion}.

Analysis:
${JSON.stringify(analysis, null, 2)}
${completedContext}

Create a precise, ordered plan covering every file that needs changing. Be exhaustive — missing changes cause production failures.`,
    }];

    const tools = this.fileTools.getAgentTools();

    return this.runForJson(systemPrompt, messages, tools);
  }
}
