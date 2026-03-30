/**
 * Blueprint Exporter — Generate Blueprint-compatible YAML from project structure
 *
 * Analyses models and controllers post-upgrade and generates a YAML file
 * compatible with laravel-shift/blueprint for code generation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { glob } from 'glob';

/**
 * Analyse the upgraded project and generate a Blueprint-compatible YAML file.
 *
 * @param {string} projectRoot
 * @param {object} [options] - { includeControllers: true, outputPath: '.shift/blueprint.yaml', logger: null }
 * @returns {{ yaml: string, modelCount: number, controllerCount: number, outputPath: string }}
 */
export async function generateBlueprintYaml(projectRoot, options = {}) {
  const {
    includeControllers = true,
    outputPath = '.shift/blueprint.yaml',
    logger = null,
  } = options;

  // Parse models
  const models = await parseModels(projectRoot);
  if (logger) await logger.info('Blueprint', `Parsed ${models.length} model(s)`);

  // Parse controllers
  let controllers = [];
  if (includeControllers) {
    controllers = await parseControllers(projectRoot);
    if (logger) await logger.info('Blueprint', `Parsed ${controllers.length} controller(s)`);
  }

  // Generate YAML
  const yaml = buildYaml(models, controllers);

  // Write to file
  const absOutputPath = join(projectRoot, outputPath);
  const outputDir = dirname(absOutputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(absOutputPath, yaml, 'utf8');

  return {
    yaml,
    modelCount: models.length,
    controllerCount: controllers.length,
    outputPath,
  };
}

/**
 * Parse Eloquent models from app/Models/*.php
 */
async function parseModels(projectRoot) {
  const modelFiles = await glob('app/Models/**/*.php', {
    cwd: projectRoot,
    nodir: true,
    ignore: ['vendor/**'],
  });

  const models = [];

  for (const filePath of modelFiles) {
    const absPath = join(projectRoot, filePath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch { continue; }

    const model = parseModel(content, filePath);
    if (model) models.push(model);
  }

  return models;
}

/**
 * Parse a single model file.
 */
function parseModel(content, _filePath) {
  // Extract class name
  const classMatch = content.match(/class\s+(\w+)\s+extends\s+(?:\w+\\)*Model/);
  if (!classMatch) return null;

  const name = classMatch[1];
  const model = { name, properties: {}, relationships: {} };

  // Extract $fillable
  const fillableMatch = content.match(/protected\s+\$fillable\s*=\s*\[([\s\S]*?)\]/);
  if (fillableMatch) {
    const fields = fillableMatch[1].match(/'([^']+)'/g);
    if (fields) {
      for (const f of fields) {
        const fieldName = f.replace(/'/g, '');
        model.properties[fieldName] = 'string'; // Default type — Blueprint infers from name
      }
    }
  }

  // Extract $casts
  const castsMatch = content.match(/(?:protected\s+\$casts\s*=\s*\[|protected\s+function\s+casts\s*\([^)]*\)\s*:\s*array\s*\{[^r]*return\s*\[)([\s\S]*?)\]/);
  if (castsMatch) {
    const castEntries = castsMatch[1].matchAll(/'(\w+)'\s*=>\s*'([^']+)'/g);
    for (const [, field, type] of castEntries) {
      model.properties[field] = mapCastToBlueprint(type);
    }
  }

  // Extract relationships
  const relationshipPatterns = [
    { method: 'hasOne', regex: /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{[^}]*\$this->hasOne\(\s*([^,)]+)/g },
    { method: 'hasMany', regex: /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{[^}]*\$this->hasMany\(\s*([^,)]+)/g },
    { method: 'belongsTo', regex: /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{[^}]*\$this->belongsTo\(\s*([^,)]+)/g },
    { method: 'belongsToMany', regex: /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{[^}]*\$this->belongsToMany\(\s*([^,)]+)/g },
  ];

  for (const { method, regex } of relationshipPatterns) {
    for (const match of content.matchAll(regex)) {
      const relatedClass = match[2].trim()
        .replace(/::class/, '')
        .replace(/.*\\/, '') // Strip namespace
        .replace(/['"]/g, '');

      if (!model.relationships[method]) model.relationships[method] = [];
      model.relationships[method].push(relatedClass);
    }
  }

  // Extract $table if non-conventional
  const tableMatch = content.match(/protected\s+\$table\s*=\s*'([^']+)'/);
  if (tableMatch) {
    model.table = tableMatch[1];
  }

  return model;
}

/**
 * Map Laravel cast types to Blueprint column types.
 */
function mapCastToBlueprint(castType) {
  const mapping = {
    boolean: 'boolean',
    integer: 'integer',
    float: 'float',
    double: 'double',
    decimal: 'decimal:8,2',
    string: 'string',
    array: 'json',
    object: 'json',
    collection: 'json',
    date: 'date',
    datetime: 'datetime',
    timestamp: 'timestamp',
    immutable_date: 'date',
    immutable_datetime: 'datetime',
    encrypted: 'string',
  };

  const lower = castType.toLowerCase().split(':')[0];
  return mapping[lower] || 'string';
}

/**
 * Parse controllers from app/Http/Controllers/*.php
 */
async function parseControllers(projectRoot) {
  const controllerFiles = await glob('app/Http/Controllers/**/*.php', {
    cwd: projectRoot,
    nodir: true,
    ignore: ['vendor/**'],
  });

  const controllers = [];

  for (const filePath of controllerFiles) {
    const absPath = join(projectRoot, filePath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch { continue; }

    const controller = parseController(content, filePath);
    if (controller) controllers.push(controller);
  }

  return controllers;
}

/**
 * Parse a single controller file.
 */
function parseController(content, _filePath) {
  const classMatch = content.match(/class\s+(\w+)/);
  if (!classMatch) return null;

  const name = classMatch[1];

  // Skip the base Controller class
  if (name === 'Controller' && !content.includes('public function')) return null;

  const methods = [];
  const methodRegex = /public\s+function\s+(\w+)\s*\(([^)]*)\)/g;
  for (const match of content.matchAll(methodRegex)) {
    const methodName = match[1];
    if (methodName === '__construct') continue;

    const params = match[2].trim();
    methods.push({
      name: methodName,
      params: params || undefined,
    });
  }

  if (methods.length === 0) return null;

  return { name, methods };
}

/**
 * Build Blueprint-compatible YAML from parsed data.
 */
function buildYaml(models, controllers) {
  const lines = ['# Blueprint YAML — Generated by Laravel Shift Local', ''];

  if (models.length > 0) {
    lines.push('models:');
    for (const model of models) {
      lines.push(`  ${model.name}:`);

      if (model.table) {
        lines.push(`    table: ${model.table}`);
      }

      // Properties
      for (const [prop, type] of Object.entries(model.properties)) {
        lines.push(`    ${prop}: ${type}`);
      }

      // Relationships
      if (Object.keys(model.relationships).length > 0) {
        lines.push('    relationships:');
        for (const [method, targets] of Object.entries(model.relationships)) {
          lines.push(`      ${method}: ${targets.join(', ')}`);
        }
      }

      lines.push('');
    }
  }

  if (controllers.length > 0) {
    lines.push('controllers:');
    for (const ctrl of controllers) {
      lines.push(`  ${ctrl.name}:`);
      for (const method of ctrl.methods) {
        if (method.params) {
          lines.push(`    ${method.name}: ${method.params}`);
        } else {
          lines.push(`    ${method.name}:`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
