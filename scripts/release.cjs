#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const ROOT_MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const PLUGIN_MANIFEST_PATH = path.join(ROOT, 'packages', 'plugin', 'manifest.json');
const VERSIONS_PATH = path.join(ROOT, 'versions.json');
const BUMP_TYPES = new Set(['patch', 'minor', 'major']);

function run(command, args = [], opts = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function runInherit(command, args = []) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function printHelp() {
  console.log(`
  obsidian-mcp release

  Usage:
    npm run release

  Steps:
    1. Require a clean main branch
    2. Fetch tags and choose patch/minor/major
    3. Create release/X.Y.Z (no v prefix; matches Obsidian tag convention)
    4. Bump package.json, package-lock.json, manifest.json,
       packages/plugin/manifest.json, and append to versions.json
    5. Run npm run build to confirm the bundle still produces a clean zip
    6. Commit, push, and open a PR

  After the PR is merged, GitHub Actions tags X.Y.Z, creates a GitHub Release,
  and uploads main.js, manifest.json, styles.css, and the plugin zip.
`);
}

function fail(message, detail = '') {
  console.error(`\n  Error: ${message}\n`);
  if (detail) {
    console.error(detail);
    console.error('');
  }
  process.exit(1);
}

function checkDependencies() {
  try {
    run('gh', ['--version']);
  } catch {
    fail('gh CLI is not installed or not in PATH.', '  Install it from https://cli.github.com and run "gh auth login" first.');
  }

  try {
    run('gh', ['auth', 'status']);
  } catch {
    fail('gh CLI is not authenticated. Run "gh auth login" first.');
  }
}

function assertSemver(version, label) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`${label} must be a plain semver version like 1.2.3. Found "${version}".`);
  }
}

function bumpVersion(current, type) {
  assertSemver(current, 'Current version');
  const [major, minor, patch] = current.split('.').map(Number);

  if (type === 'major') {
    return `${major + 1}.0.0`;
  }
  if (type === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function latestVersionTag() {
  const tags = run('git', ['tag', '--sort=-v:refname'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);

  return tags.find((tag) => /^\d+\.\d+\.\d+$/.test(tag)) || null;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const status = run('git', ['status', '--porcelain']);
  if (status) {
    fail('Working tree has uncommitted changes. Commit or stash them first.', status);
  }

  const currentBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== 'main') {
    fail(`Must be on main branch to create a release. Currently on "${currentBranch}".`);
  }

  checkDependencies();

  run('git', ['fetch', '--tags']);

  const pkg = readJson(PKG_PATH);
  const rootManifest = readJson(ROOT_MANIFEST_PATH);
  const pluginManifest = readJson(PLUGIN_MANIFEST_PATH);
  assertSemver(pkg.version, 'package.json version');
  assertSemver(rootManifest.version, 'manifest.json version');
  assertSemver(pluginManifest.version, 'packages/plugin/manifest.json version');

  if (rootManifest.version !== pkg.version || pluginManifest.version !== pkg.version) {
    fail(
      'Versions are out of sync. Align package.json, manifest.json, and packages/plugin/manifest.json before releasing.',
      `  package.json:                 ${pkg.version}\n  manifest.json:                ${rootManifest.version}\n  packages/plugin/manifest.json: ${pluginManifest.version}`
    );
  }

  let current = pkg.version;
  const latestTag = latestVersionTag();
  if (latestTag) {
    if (latestTag !== pkg.version) {
      console.log(`\n  package.json (${pkg.version}) is behind latest tag (${latestTag}); using tag as base.`);
    }
    current = latestTag;
  }

  console.log(`\n  Current version: ${current}`);
  console.log('  Bump type: patch | minor | major\n');

  const input = await prompt('  Bump type (patch): ');
  const bumpType = input || 'patch';
  if (!BUMP_TYPES.has(bumpType)) {
    fail(`Invalid bump type "${bumpType}". Must be patch, minor, or major.`);
  }

  const next = bumpVersion(current, bumpType);
  const tag = next; // No v prefix — Obsidian convention
  const branch = `release/${tag}`;
  const minAppVersion = rootManifest.minAppVersion;

  console.log(`\n  ${current} -> ${next}`);
  console.log(`  Tag: ${tag} (no v prefix, Obsidian convention)`);
  console.log(`  minAppVersion: ${minAppVersion}`);
  console.log(`  Branch: ${branch}\n`);

  run('git', ['checkout', '-b', branch]);

  pkg.version = next;
  writeJson(PKG_PATH, pkg);

  rootManifest.version = next;
  writeJson(ROOT_MANIFEST_PATH, rootManifest);

  pluginManifest.version = next;
  writeJson(PLUGIN_MANIFEST_PATH, pluginManifest);

  const versions = fs.existsSync(VERSIONS_PATH) ? readJson(VERSIONS_PATH) : {};
  versions[next] = minAppVersion;
  writeJson(VERSIONS_PATH, versions);

  if (fs.existsSync(LOCK_PATH)) {
    run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
    console.log(`  OK package.json + package-lock.json + manifest.json + plugin manifest + versions.json -> ${next}`);
  } else {
    console.log(`  OK package.json + manifest.json + plugin manifest + versions.json -> ${next}`);
  }

  console.log('\n  Running npm run build to verify the bundle is clean...');
  try {
    runInherit('npm', ['run', 'build']);
  } catch {
    fail('Build failed. Fix build errors before releasing.');
  }

  // Build leaves files under build/ — they're gitignored, but verify just in case.
  const dirty = run('git', ['status', '--porcelain']);
  if (dirty.split('\n').some((line) => line && !line.match(/(package\.json|package-lock\.json|manifest\.json|versions\.json)$/))) {
    fail(
      'Unexpected files would be committed (anything beyond version files).',
      dirty
    );
  }

  const filesToCommit = [
    'package.json',
    'manifest.json',
    'packages/plugin/manifest.json',
    'versions.json'
  ];
  if (fs.existsSync(LOCK_PATH)) {
    filesToCommit.push('package-lock.json');
  }

  run('git', ['add', ...filesToCommit]);
  run('git', ['commit', '-m', `chore: release ${tag}`]);
  console.log(`  OK commit: chore: release ${tag}`);

  run('git', ['push', '-u', 'origin', branch]);
  console.log(`  OK pushed branch: ${branch}`);

  const prBody = [
    `Bump version to ${next}.`,
    '',
    `Once merged, CI will tag \`${tag}\` (no v prefix, Obsidian convention),`,
    `create a GitHub Release with auto-generated notes, and upload the plugin`,
    `assets (\`main.js\`, \`manifest.json\`, \`styles.css\`, and the zip archive).`
  ].join('\n');
  const prBodyPath = path.join(os.tmpdir(), `obsidian-mcp-release-${next}.md`);
  fs.writeFileSync(prBodyPath, prBody, 'utf8');
  try {
    run('gh', ['pr', 'create', '--title', `chore: release ${tag}`, '--body-file', prBodyPath, '--base', 'main']);
  } finally {
    fs.unlinkSync(prBodyPath);
  }
  console.log('  OK PR opened against main');

  console.log('\n  Done. Merge the PR to trigger tagging and release asset upload.\n');
}

main().catch((err) => {
  fail(`Release failed: ${err.message}`);
});
