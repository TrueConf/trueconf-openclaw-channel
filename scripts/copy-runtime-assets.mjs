#!/usr/bin/env node
// Copy non-TS runtime assets that `tsc` does not emit into dist/.
//
// `src/probe.mjs` is imported by value (src/channel-setup.ts -> './probe.mjs')
// and loaded at runtime, but `tsc` only compiles .ts files and leaves .mjs
// untouched — so without this copy the compiled dist/src/channel-setup.js would
// import a missing ./probe.mjs. Run after `tsc` (dist/src already exists).
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await cp(join(root, 'src', 'probe.mjs'), join(root, 'dist', 'src', 'probe.mjs'));
process.stdout.write('[copy-runtime-assets] src/probe.mjs -> dist/src/probe.mjs\n');
