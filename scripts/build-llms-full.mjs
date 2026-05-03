#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPARATOR = (rel) => `# === Source: ${rel} ===\n\n`;
const TOP_LEVEL = ['README.md', 'CHANGELOG.md'];
const EXCLUDED_PREFIXES = ['docs/superpowers/'];

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function applyFilters(paths) {
  return paths
    .filter((rel) => rel.endsWith('.md'))
    .filter((rel) => !EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)))
    .sort();
}

async function listDocsViaFs(root) {
  const docsRoot = join(root, 'docs');
  if (!(await fileExists(docsRoot))) return [];
  const entries = await readdir(docsRoot, { recursive: true, withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const parent = ent.parentPath ?? ent.path ?? docsRoot;
    const abs = join(parent, ent.name);
    const rel = relative(root, abs).split(sep).join('/');
    out.push(rel);
  }
  return applyFilters(out);
}

async function listDocsMarkdown(root) {
  // In a git repo, enumerate via `git ls-files` so the build is reproducible
  // across environments — filesystem traversal would pick up local-only docs
  // excluded via `.git/info/exclude` (e.g. internal planning notes that never
  // ship), causing the smoke test to diverge between developer machines and
  // CI checkouts. Outside a git repo (e.g. unit tests using mkdtemp), fall
  // back to filesystem traversal so the script remains drop-in usable.
  try {
    const stdout = execFileSync('git', ['ls-files', '--', 'docs/'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return applyFilters(stdout.split('\n').filter(Boolean));
  } catch {
    return await listDocsViaFs(root);
  }
}

export async function buildLlmsFull({ root }) {
  const sources = [];
  for (const name of TOP_LEVEL) {
    if (await fileExists(join(root, name))) sources.push(name);
  }
  sources.push(...(await listDocsMarkdown(root)));

  const parts = [];
  for (const rel of sources) {
    const body = await readFile(join(root, rel), 'utf8');
    parts.push(SEPARATOR(rel));
    parts.push(body.endsWith('\n') ? body : body + '\n');
  }
  return parts.join('\n');
}

const isCliEntry =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (isCliEntry) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const out = await buildLlmsFull({ root });
  await writeFile(join(root, 'llms-full.txt'), out, 'utf8');
  process.stdout.write(`[build-llms-full] wrote llms-full.txt (${out.length} bytes)\n`);
}
