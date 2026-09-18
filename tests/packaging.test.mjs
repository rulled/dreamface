// Guards the packaging surface: a new module that nobody ships, a manifest pointing at
// a missing file, or a syntax error in any extension script must fail here, not in Chrome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SCRIPT_KINDS = {
  'background.js': 'classic',
  'popup.js': 'classic',
  'content_script.js': 'classic',
  'injected.js': 'classic',
  'offscreen.js': 'module',
  'dreamface-api.js': 'module',
  'media-transform.js': 'module',
  'trace.js': 'module',
  'features.js': 'module',
  'popup-trace.js': 'module',
};

function readReleaseWhitelist() {
  const source = readFileSync(join(root, 'package-release.ps1'), 'utf8');
  const block = source.match(/\$runtimeFiles = @\(([\s\S]*?)\)/);
  assert.ok(block, 'package-release.ps1 must list runtime files');
  const files = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(files.includes('manifest.json'), 'release whitelist must include the manifest');
  return files;
}

test('every extension script is classified and parses', () => {
  // `Users_*.js` are reverse-engineering dumps, ignored by .gitignore and not part of the extension.
  const scripts = readdirSync(root)
    .filter((name) => name.endsWith('.js') && !name.startsWith('Users_'));
  const unclassified = scripts.filter((name) => !SCRIPT_KINDS[name]);
  assert.deepEqual(unclassified, [], 'classify new scripts in SCRIPT_KINDS');

  const directory = mkdtempSync(join(tmpdir(), 'dreamface-syntax-'));
  for (const name of scripts) {
    const extension = SCRIPT_KINDS[name] === 'module' ? '.mjs' : '.cjs';
    const target = join(directory, `${name}${extension}`);
    copyFileSync(join(root, name), target);
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (error) {
      assert.fail(`${name} failed to parse:\n${error.stderr || error.message}`);
    }
  }
});

test('release whitelist ships every module reachable from a shipped script', () => {
  const whitelist = readReleaseWhitelist();
  const shipped = new Set(whitelist);
  const queue = whitelist.filter((name) => name.endsWith('.js'));
  const missing = [];

  while (queue.length > 0) {
    const name = queue.shift();
    const source = readFileSync(join(root, name), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([A-Za-z0-9_.-]+\.js)['"]/g)) {
      const dependency = match[1];
      if (!existsSync(join(root, dependency))) {
        missing.push(`${name} imports missing file ${dependency}`);
        continue;
      }
      if (!shipped.has(dependency)) {
        missing.push(`${name} imports ${dependency}, which the release whitelist omits`);
        continue;
      }
      if (!queue.includes(dependency) && name !== dependency) queue.push(dependency);
    }
  }

  assert.deepEqual(missing, []);
});

test('manifest entry points and page scripts exist on disk', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
  ].filter((value) => typeof value === 'string' && !value.includes('*'));

  for (const relativePath of referenced) {
    assert.ok(existsSync(join(root, relativePath)), `manifest references missing ${relativePath}`);
  }

  for (const page of ['popup.html', 'offscreen.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    for (const match of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
      assert.ok(existsSync(join(root, match[1])), `${page} loads missing script ${match[1]}`);
    }
  }
});

test('popup trace controls resolve to real elements', () => {
  const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
  const traceSource = readFileSync(join(root, 'popup-trace.js'), 'utf8');
  const ids = [...traceSource.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 3, 'popup-trace.js must wire the export, clear and status elements');

  for (const id of ids) {
    assert.ok(popupHtml.includes(`id="${id}"`), `popup.html has no element with id ${id}`);
  }
});
