#!/usr/bin/env node

/**
 * Build Upgrade Guides — Development-time script
 *
 * Fetches official Laravel upgrade guides and parses them into
 * structured JSON. NOT run during upgrades — output is pre-built.
 *
 * Usage: node scripts/build-upgrade-guides.js
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OUTPUT_DIR = resolve(import.meta.dirname, '..', 'data', 'upgrade-guides');
const VERSIONS = ['9', '10', '11', '12'];

function log(msg) {
  console.log(`[build-upgrade-guides] ${msg}`);
}

/**
 * Fetch the raw upgrade guide HTML/markdown from Laravel docs.
 */
async function fetchGuide(version) {
  const url = `https://laravel.com/docs/${version}.x/upgrade`;
  log(`  Fetching ${url}...`);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'laravel-shift-local/1.0 (build script)' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      log(`  HTTP ${response.status} for version ${version} — skipping`);
      return null;
    }

    return await response.text();
  } catch (err) {
    log(`  Failed to fetch version ${version}: ${err.message}`);
    return null;
  }
}

/**
 * Parse HTML into structured sections.
 * This is a best-effort parser — Laravel docs use relatively consistent structure.
 */
function parseGuide(html, version) {
  const sections = [];

  // Extract main content area — look for heading patterns
  // Laravel docs use <h2>, <h3> for section headings
  const headingRegex = /<h([23])[^>]*>(.*?)<\/h\1>/gi;
  const matches = [...html.matchAll(headingRegex)];

  for (let i = 0; i < matches.length; i++) {
    const level = parseInt(matches[i][1]);
    const title = matches[i][2].replace(/<[^>]*>/g, '').trim();
    const startIdx = matches[i].index + matches[i][0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const rawContent = html.substring(startIdx, endIdx);

    // Strip HTML tags for plain text content
    const content = rawContent
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 2000); // Cap content length

    if (!title || !content || content.length < 10) continue;

    const breaking = /breaking|removed|renamed|changed|deprecated/i.test(title) ||
      /breaking/i.test(content.substring(0, 200));

    sections.push({
      title,
      level,
      content,
      breaking,
    });
  }

  return sections;
}

/**
 * Extract third-party package notes from the guide content.
 */
function extractThirdParty(sections) {
  const thirdParty = [];
  const pkgPatterns = [
    { name: 'laravel/cashier-stripe', pattern: /cashier/i },
    { name: 'laravel/passport', pattern: /passport/i },
    { name: 'laravel/sanctum', pattern: /sanctum/i },
    { name: 'laravel/scout', pattern: /scout/i },
    { name: 'laravel/socialite', pattern: /socialite/i },
    { name: 'laravel/telescope', pattern: /telescope/i },
    { name: 'laravel/horizon', pattern: /horizon/i },
    { name: 'laravel/dusk', pattern: /dusk/i },
    { name: 'laravel/pint', pattern: /pint/i },
    { name: 'laravel/sail', pattern: /sail/i },
    { name: 'laravel/breeze', pattern: /breeze/i },
    { name: 'laravel/jetstream', pattern: /jetstream/i },
    { name: 'spatie/laravel-permission', pattern: /spatie.*permission/i },
    { name: 'livewire/livewire', pattern: /livewire/i },
    { name: 'inertiajs/inertia-laravel', pattern: /inertia/i },
  ];

  for (const section of sections) {
    for (const pkg of pkgPatterns) {
      if (pkg.pattern.test(section.title) || pkg.pattern.test(section.content.substring(0, 200))) {
        thirdParty.push({
          package: pkg.name,
          notes: section.content.substring(0, 500),
        });
      }
    }
  }

  // Deduplicate by package name
  const seen = new Set();
  return thirdParty.filter(p => {
    if (seen.has(p.package)) return false;
    seen.add(p.package);
    return true;
  });
}

async function main() {
  log('Starting upgrade guide build...');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let built = 0;
  for (const version of VERSIONS) {
    const html = await fetchGuide(version);
    if (!html) continue;

    const sections = parseGuide(html, version);
    const thirdParty = extractThirdParty(sections);

    const guide = {
      version: `${version}.x`,
      url: `https://laravel.com/docs/${version}.x/upgrade`,
      fetchedAt: new Date().toISOString().split('T')[0],
      sections,
      thirdParty,
    };

    const outputPath = join(OUTPUT_DIR, `${version}.json`);
    writeFileSync(outputPath, JSON.stringify(guide, null, 2), 'utf8');
    log(`  Written: ${version}.json (${sections.length} sections, ${thirdParty.length} third-party)`);
    built++;
  }

  log(`Done! Built ${built} upgrade guide(s) in ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
