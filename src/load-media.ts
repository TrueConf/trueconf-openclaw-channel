import { readFile as fsReadFile } from 'node:fs/promises'
import { basename, isAbsolute as pathIsAbsolute, resolve as pathResolve, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { request } from 'undici'

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
  if (options.mediaLocalRoots && options.mediaLocalRoots.length > 0) {
    const allowed = options.mediaLocalRoots.some((root) => isUnderRoot(localPath, root))
    if (!allowed) {
      throw withCode(`Local media path is not under any allowed root: ${localPath}`, 'EACCES')
    }
  }
  const buffer = await fsReadFile(localPath)
  if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
    throw new Error(`Media exceeds maxBytes (${buffer.byteLength} > ${options.maxBytes})`)
  }
  return {
    buffer,
    contentType: contentTypeFromExtension(localPath),
    fileName: basename(localPath),
  }
}

async function loadHttpMedia(
  mediaUrl: string,
  options: OutboundMediaLoadOptions,
): Promise<WebMediaResult> {
  const { statusCode, headers, body } = await request(mediaUrl, {
    method: 'GET',
    headersTimeout: 15_000,
    bodyTimeout: 60_000,
  })
  if (statusCode < 200 || statusCode >= 300) {
    body.destroy()
    throw new Error(`Failed to fetch media: HTTP ${statusCode}`)
  }
  const cap = options.maxBytes
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buf.byteLength
      if (cap !== undefined && total > cap) {
        body.destroy()
        throw new Error(`Media exceeds maxBytes (${total} > ${cap})`)
      }
      chunks.push(buf)
    }
  } catch (err) {
    if (!body.destroyed) body.destroy()
    throw err
  }
  const buffer = Buffer.concat(chunks, total)

  const contentTypeHeader = headers['content-type']
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
  const dispositionHeader = headers['content-disposition']
  const disposition = Array.isArray(dispositionHeader) ? dispositionHeader[0] : dispositionHeader

  let fileName = parseFilenameFromContentDisposition(disposition)
  if (!fileName) {
    try {
      const parsedName = basename(new URL(mediaUrl).pathname)
      if (parsedName) fileName = parsedName
    } catch {
      /* ignore — URL was not parseable for fileName extraction */
    }
  }

  return {
    buffer,
    contentType: typeof contentType === 'string' ? contentType : undefined,
    fileName,
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
