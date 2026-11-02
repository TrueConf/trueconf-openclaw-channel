import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadOutboundMediaFromUrl } from '../../src/load-media'

describe('loadOutboundMediaFromUrl: local files', () => {
  let base: string
  let root: string
  let outside: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'trueconf-load-media-'))
    root = join(base, 'root')
    outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'reply.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'outside')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('reads a file under an allowed root', async () => {
    const media = await loadOutboundMediaFromUrl(join(root, 'reply.txt'), { mediaLocalRoots: [root] })
    expect(media.buffer.toString()).toBe('inside')
    expect(media.fileName).toBe('reply.txt')
  })

  it('refuses a local path when no roots are given', async () => {
    await expect(loadOutboundMediaFromUrl(join(outside, 'secret.txt'))).rejects.toMatchObject({ code: 'EACCES' })
    await expect(
      loadOutboundMediaFromUrl(pathToFileURL(join(outside, 'secret.txt')).href, { mediaLocalRoots: [] }),
    ).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a path outside every root', async () => {
    await expect(
      loadOutboundMediaFromUrl(join(outside, 'secret.txt'), { mediaLocalRoots: [root] }),
    ).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a link inside a root that points outside it', async () => {
    // A directory junction needs no extra privileges on Windows; elsewhere the
    // type is ignored and this is a plain directory symlink.
    await symlink(outside, join(root, 'escape'), 'junction')
    await expect(
      loadOutboundMediaFromUrl(join(root, 'escape', 'secret.txt'), { mediaLocalRoots: [root] }),
    ).rejects.toMatchObject({ code: 'EACCES' })
  })
})
