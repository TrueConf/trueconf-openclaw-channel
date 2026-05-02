import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLlmsFull } from '../../scripts/build-llms-full.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('llms-full.txt staleness', () => {
  it('matches a freshly-built dump from README + CHANGELOG + docs', async () => {
    const expected = await buildLlmsFull({ root: repoRoot });
    const actual = await readFile(join(repoRoot, 'llms-full.txt'), 'utf8');
    if (actual !== expected) {
      throw new Error(
        "llms-full.txt is stale. Run `npm run build:llms` and commit the result."
      );
    }
    expect(actual).toEqual(expected);
  });
});
