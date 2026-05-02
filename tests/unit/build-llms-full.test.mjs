import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLlmsFull } from '../../scripts/build-llms-full.mjs';

async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'llms-test-'));
  for (const [relPath, body] of Object.entries(files)) {
    const abs = join(root, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

describe('buildLlmsFull', () => {
  it('concatenates README, CHANGELOG, and docs/**/*.md with separators in deterministic order', async () => {
    const root = await makeTree({
      'README.md': '# README\nbody-readme\n',
      'CHANGELOG.md': '# CHANGELOG\nbody-changelog\n',
      'docs/extra.md': '# Extra\nbody-extra\n',
      'docs/aaa.md': '# AAA\nbody-aaa\n',
      'docs/nested/deep.md': '# Deep\nbody-deep\n',
    });

    const out = await buildLlmsFull({ root });

    expect(out).toContain('# === Source: README.md ===');
    expect(out).toContain('body-readme');
    expect(out).toContain('# === Source: CHANGELOG.md ===');
    expect(out).toContain('body-changelog');
    expect(out).toContain('# === Source: docs/aaa.md ===');
    expect(out).toContain('# === Source: docs/extra.md ===');
    expect(out).toContain('# === Source: docs/nested/deep.md ===');

    const idxReadme = out.indexOf('=== Source: README.md');
    const idxChangelog = out.indexOf('=== Source: CHANGELOG.md');
    const idxAaa = out.indexOf('=== Source: docs/aaa.md');
    const idxExtra = out.indexOf('=== Source: docs/extra.md');
    const idxDeep = out.indexOf('=== Source: docs/nested/deep.md');
    expect(idxReadme).toBeLessThan(idxChangelog);
    expect(idxChangelog).toBeLessThan(idxAaa);
    expect(idxAaa).toBeLessThan(idxExtra);
    expect(idxExtra).toBeLessThan(idxDeep);
  });

  it('excludes docs/superpowers/ entirely', async () => {
    const root = await makeTree({
      'README.md': '# R\n',
      'CHANGELOG.md': '# C\n',
      'docs/public.md': 'PUBLIC',
      'docs/superpowers/specs/design.md': 'SECRET-SPEC',
      'docs/superpowers/plans/plan.md': 'SECRET-PLAN',
    });

    const out = await buildLlmsFull({ root });
    expect(out).toContain('PUBLIC');
    expect(out).not.toContain('SECRET-SPEC');
    expect(out).not.toContain('SECRET-PLAN');
    expect(out).not.toContain('superpowers');
  });

  it('produces byte-identical output across runs', async () => {
    const root = await makeTree({
      'README.md': '# R\nbody\n',
      'CHANGELOG.md': '# C\nbody\n',
      'docs/x.md': '# X\nbody\n',
    });

    const a = await buildLlmsFull({ root });
    const b = await buildLlmsFull({ root });
    expect(a).toEqual(b);
  });

  it('tolerates missing CHANGELOG.md and missing docs/', async () => {
    const root = await makeTree({
      'README.md': '# R only\n',
    });
    const out = await buildLlmsFull({ root });
    expect(out).toContain('# === Source: README.md ===');
    expect(out).toContain('R only');
    expect(out).not.toContain('CHANGELOG');
  });
});
