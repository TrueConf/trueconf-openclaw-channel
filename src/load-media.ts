import { readFile as fsReadFile, realpath as fsRealpath } from 'node:fs/promises'
import { basename, isAbsolute as pathIsAbsolute, resolve as pathResolve, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchWithSsrFGuard } from 'openclaw/plugin-sdk/ssrf-runtime'

export type WebMediaResult = {
  buffer: Buffer
  contentType?: string
  fileName?: string
}

export type OutboundMediaLoadOptions = {
  maxBytes?: number
  mediaLocalRoots?: readonly string[]
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
}

function contentTypeFromExtension(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = filePath.slice(dot + 1).toLowerCase()
  return EXT_TO_MIME[ext]
}

const FILENAME_RE = /filename\*?=(?:UTF-8'')?"?([^";]+?)"?(?:;|$)/i

function parseFilenameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = FILENAME_RE.exec(header)
  if (!match) return undefined
  const raw = match[1]
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isUnderRoot(filePath: string, root: string): boolean {
  const resolvedFile = pathResolve(filePath)
  const resolvedRoot = pathResolve(root)
  if (resolvedFile === resolvedRoot) return true
  const rootWithSep = resolvedRoot.endsWith(pathSep) ? resolvedRoot : resolvedRoot + pathSep
  return resolvedFile.startsWith(rootWithSep)
}

function withCode(message: string, code: NodeJS.ErrnoException['code']): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

async function loadLocalFile(
  localPath: string,
  options: OutboundMediaLoadOptions,
): Promise<WebMediaResult> {
  // Fail closed: the path comes from the agent, so without roots any file the
  // gateway can read would be sent to the chat. realpath on both sides keeps a
  // link inside a root from pointing outside it.
  const roots = options.mediaLocalRoots ?? []
  if (roots.length === 0) {
    throw withCode(`Local media is not allowed without mediaLocalRoots: ${localPath}`, 'EACCES')
  }
  const realFile = await fsRealpath(localPath)
  const realRoots = await Promise.all(roots.map((root) => fsRealpath(root).catch(() => pathResolve(root))))
  if (!realRoots.some((root) => isUnderRoot(realFile, root))) {
    throw withCode(`Local media path is not under any allowed root: ${localPath}`, 'EACCES')
  }
  const buffer = await fsReadFile(realFile)
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new Error(`Media exceeds maxBytes (${buffer.byteLength} > ${options.maxBytes})`)
  }
  return {
    buffer,
    contentType: contentTypeFromExtension(localPath),
    fileName: basename(localPath),
  }
}

// The URL comes from the agent, so the fetch goes through OpenClaw's SSRF guard:
// it refuses private, loopback and link-local targets, checks every redirect and
// pins the resolved address, so the bot cannot be used to read internal services
// and post the response to a chat.
async function loadHttpMedia(
  mediaUrl: string,
  options: OutboundMediaLoadOptions,
): Promise<WebMediaResult> {
  const { response, finalUrl, release } = await fetchWithSsrFGuard({ url: mediaUrl, timeoutMs: 60_000 })
  try {
    if (!response.ok) {
      throw new Error(`Failed to fetch media: HTTP ${response.status}`)
    }
    const cap = options.maxBytes
    const chunks: Buffer[] = []
    let total = 0
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.byteLength
        if (cap !== undefined && total > cap) {
          throw new Error(`Media exceeds maxBytes (${total} > ${cap})`)
        }
        chunks.push(Buffer.from(chunk))
      }
    }
    const buffer = Buffer.concat(chunks, total)

    let fileName = parseFilenameFromContentDisposition(response.headers.get('content-disposition') ?? undefined)
    if (!fileName) {
      try {
        const parsedName = basename(new URL(finalUrl).pathname)
        if (parsedName) fileName = parsedName
      } catch {
        /* ignore — URL was not parseable for fileName extraction */
      }
    }

    return {
      buffer,
      contentType: response.headers.get('content-type') ?? undefined,
      fileName,
    }
  } finally {
    await release()
  }
}

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
): Promise<WebMediaResult> {
  if (mediaUrl.startsWith('file://')) {
    let localPath: string
    try {
      localPath = fileURLToPath(mediaUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw withCode(`Invalid file:// URL: ${message}`, 'ENOENT')
    }
    return loadLocalFile(localPath, options)
  }
  if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
    return loadHttpMedia(mediaUrl, options)
  }
  if (pathIsAbsolute(mediaUrl)) {
    return loadLocalFile(mediaUrl, options)
  }
  throw withCode(`Unsupported media URL scheme: ${mediaUrl}`, 'ENOENT')
}
