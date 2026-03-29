/**
 * Route Checker — Static analysis for dead routes after upgrade
 *
 * Ported from laravel-shift/console (MIT, archived).
 * Checks route files for references to controllers/methods that
 * don't exist, without requiring a running PHP/Laravel installation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';

/**
 * Check for dead routes after upgrade transforms.
 *
 * @param {string} projectRoot
 * @returns {{ deadRoutes: Array<{route, controller, method, reason}>, checked: number }}
 */
export async function checkRoutes(projectRoot) {
  const routeFiles = await findRouteFiles(projectRoot);
  const controllerMap = await buildControllerMap(projectRoot);

  const deadRoutes = [];
  let checked = 0;

  for (const routeFile of routeFiles) {
    const absPath = join(projectRoot, routeFile);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch { continue; }

    const routes = parseRoutes(content, routeFile);
    checked += routes.length;

    for (const route of routes) {
      const result = validateRoute(route, controllerMap, projectRoot);
      if (!result.valid) {
        deadRoutes.push({
          route: route.path || route.raw,
          controller: route.controller,
          method: route.method,
          reason: result.reason,
          file: routeFile,
          line: route.line,
        });
      }
    }
  }

  return { deadRoutes, checked };
}

/**
 * Find all route files in the project.
 */
async function findRouteFiles(projectRoot) {
  const patterns = [
    'routes/web.php',
    'routes/api.php',
    'routes/channels.php',
    'routes/console.php',
    'routes/*.php',
  ];

  const files = new Set();
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: projectRoot, nodir: true });
    for (const m of matches) files.add(m);
  }
  return [...files];
}

/**
 * Build a map of controller classes to their methods and visibility.
 */
async function buildControllerMap(projectRoot) {
  const controllerFiles = await glob('app/Http/Controllers/**/*.php', {
    cwd: projectRoot,
    nodir: true,
  });

  const map = new Map();

  for (const filePath of controllerFiles) {
    const absPath = join(projectRoot, filePath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch { continue; }

    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) continue;

    const className = classMatch[1];
    const methods = new Map();

    // Extract all methods with their visibility
    const methodRegex = /(public|protected|private)\s+function\s+(\w+)\s*\(/g;
    for (const match of content.matchAll(methodRegex)) {
      methods.set(match[2], { visibility: match[1] });
    }

    map.set(className, { filePath, methods });

    // Also map with namespace prefix
    const nsMatch = content.match(/namespace\s+([\w\\]+)\s*;/);
    if (nsMatch) {
      map.set(`${nsMatch[1]}\\${className}`, { filePath, methods });
    }
  }

  return map;
}

/**
 * Parse route definitions from a PHP file.
 */
function parseRoutes(content, filePath) {
  const routes = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Match: Route::get('/path', [Controller::class, 'method'])
    const tupleMatch = line.match(/Route::\w+\s*\(\s*['"]([^'"]*)['"]\s*,\s*\[([^,\]]+)::class\s*,\s*['"](\w+)['"]\s*\]/);
    if (tupleMatch) {
      routes.push({
        path: tupleMatch[1],
        controller: extractClassName(tupleMatch[2]),
        method: tupleMatch[3],
        type: 'tuple',
        line: lineNum,
        raw: line.trim(),
      });
      continue;
    }

    // Match: Route::get('/path', 'Controller@method')
    const stringMatch = line.match(/Route::\w+\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"](\w+)@(\w+)['"]\s*\)/);
    if (stringMatch) {
      routes.push({
        path: stringMatch[1],
        controller: stringMatch[2],
        method: stringMatch[3],
        type: 'string',
        line: lineNum,
        raw: line.trim(),
      });
      continue;
    }

    // Match: Route::resource('users', UserController::class) — MUST come before invokable
    const resourceMatch = line.match(/Route::(?:resource|apiResource)\s*\(\s*['"]([^'"]*)['"]\s*,\s*([A-Z]\w+)::class/);
    if (resourceMatch) {
      const isApi = line.includes('apiResource');
      const methods = isApi
        ? ['index', 'store', 'show', 'update', 'destroy']
        : ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];

      for (const method of methods) {
        routes.push({
          path: `${resourceMatch[1]}/${method}`,
          controller: extractClassName(resourceMatch[2]),
          method,
          type: 'resource',
          line: lineNum,
          raw: line.trim(),
        });
      }
      continue;
    }

    // Match: Route::get('/path', Controller::class) — invokable (after resource check)
    const invokableMatch = line.match(/Route::(?!resource|apiResource)\w+\s*\(\s*['"]([^'"]*)['"]\s*,\s*([A-Z]\w+)::class\s*\)/);
    if (invokableMatch) {
      routes.push({
        path: invokableMatch[1],
        controller: extractClassName(invokableMatch[2]),
        method: '__invoke',
        type: 'invokable',
        line: lineNum,
        raw: line.trim(),
      });
      continue;
    }

    // Match: Route::controller(Controller::class)->group(...)
    const controllerGroupMatch = line.match(/Route::controller\s*\(\s*([A-Z]\w+)::class\s*\)/);
    if (controllerGroupMatch) {
      const controllerName = extractClassName(controllerGroupMatch[1]);
      // Look ahead for route definitions in the group
      for (let j = i + 1; j < lines.length && j < i + 50; j++) {
        if (lines[j].includes('});')) break;
        const groupRouteMatch = lines[j].match(/Route::\w+\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"](\w+)['"]\s*\)/);
        if (groupRouteMatch) {
          routes.push({
            path: groupRouteMatch[1],
            controller: controllerName,
            method: groupRouteMatch[2],
            type: 'controller-group',
            line: j + 1,
            raw: lines[j].trim(),
          });
        }
      }
    }
  }

  return routes;
}

/**
 * Extract the simple class name from a potentially namespaced reference.
 */
function extractClassName(ref) {
  return ref.trim().replace(/.*\\/, '');
}

/**
 * Validate a single route against the controller map.
 */
function validateRoute(route, controllerMap, projectRoot) {
  const controllerInfo = controllerMap.get(route.controller);

  if (!controllerInfo) {
    return { valid: false, reason: 'Controller file not found' };
  }

  if (!controllerInfo.methods.has(route.method)) {
    return { valid: false, reason: `Method '${route.method}' not found in ${route.controller}` };
  }

  const methodInfo = controllerInfo.methods.get(route.method);
  if (methodInfo.visibility !== 'public') {
    return { valid: false, reason: `Method '${route.method}' is ${methodInfo.visibility} (must be public)` };
  }

  return { valid: true };
}

/**
 * Generate a route health check report section.
 * @param {object} result - Result from checkRoutes
 * @returns {string} Markdown report section
 */
export function generateRouteReport(result) {
  if (!result || result.checked === 0) {
    return 'No routes were checked (no route files found).';
  }

  if (result.deadRoutes.length === 0) {
    return `All ${result.checked} route(s) are valid.`;
  }

  const lines = [
    `| Route | Controller | Method | Status |`,
    `|-------|-----------|--------|--------|`,
  ];

  for (const dr of result.deadRoutes) {
    lines.push(`| ${dr.route} | ${dr.controller} | ${dr.method || '—'} | ${dr.reason} |`);
  }

  lines.push('');
  lines.push(`Dead routes found: ${result.deadRoutes.length} (require manual attention)`);

  return lines.join('\n');
}
