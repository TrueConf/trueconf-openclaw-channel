import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

type Json = Record<string, unknown>

export interface FakeRequest {
  id: number
  method: string
  payload: Json
}

export interface FakeFile {
  body: Buffer
  mimeType: string
}

export interface FakeHttpUpload {
  uploadTaskId: string
  bytes: Buffer
  contentType: string | null
}

export type FakeFileInfoReply = Partial<{
  errorCode: number
  readyState: number
  size: number
  mimeType: string
  downloadUrl: string | null
}>

export interface FakeOAuthResponse {
  status: number
  body?: unknown
}

export interface FakeOAuthRequest {
  headers: Record<string, string | undefined>
  body: string
}

export interface FakeServer {
  host: string
  port: number
  serverUrl: string
  authRequests: FakeRequest[]
  messageRequests: FakeRequest[]
  uploadFileRequests: FakeRequest[]
  sendFileRequests: FakeRequest[]
  getChatByIdRequests: FakeRequest[]
  subscribeFileProgressRequests: FakeRequest[]
  unsubscribeFileProgressRequests: FakeRequest[]
  httpUploads: FakeHttpUpload[]
  oauthRequests: FakeOAuthRequest[]
  oauthResponse: FakeOAuthResponse
  clientAcks: number[]
  connections: Set<WebSocket>
  pushInbound: (envelope: Json) => void
  pushFileProgress: (fileId: string, progress: number) => void
  dropAll: () => void
  setFile: (fileId: string, file: FakeFile) => void
  setFileInfoSequence: (fileId: string, sequence: FakeFileInfoReply[]) => void
  respondUploadTaskId: (value: string) => void
  respondTemporalFileId: (value: string) => void
  setChatType: (chatId: string, chatType: number) => void
  setOauthResponse: (response: FakeOAuthResponse) => void
  close: () => Promise<void>
}

export interface FakeServerOptions {
  botUserId?: string
  failAuthOnce?: boolean
  oauthResponse?: FakeOAuthResponse
}

function makeDefaultOAuthResponse(): FakeOAuthResponse {
  return {
    status: 200,
    body: {
      access_token: 'TEST_TOKEN',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
    },
  }
}

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const botUserId = opts.botUserId ?? 'bot@srv'
  const files = new Map<string, FakeFile>()
  const fileInfoSequences = new Map<string, FakeFileInfoReply[]>()
  const connections = new Set<WebSocket>()
  const authRequests: FakeRequest[] = []
  const messageRequests: FakeRequest[] = []
  const uploadFileRequests: FakeRequest[] = []
  const sendFileRequests: FakeRequest[] = []
  const getChatByIdRequests: FakeRequest[] = []
  const subscribeFileProgressRequests: FakeRequest[] = []
  const unsubscribeFileProgressRequests: FakeRequest[] = []
  const chatTypeOverrides = new Map<string, number>()
  const httpUploads: FakeHttpUpload[] = []
  const oauthRequests: FakeOAuthRequest[] = []
  let oauthResponse: FakeOAuthResponse = opts.oauthResponse ?? makeDefaultOAuthResponse()
  const clientAcks: number[] = []
  let pendingAuthFailures = opts.failAuthOnce ? 1 : 0
  let nextServerRequestId = 10_000
  let nextUploadTaskId = 1
  let nextTemporalFileId = 1
  let nextSendFileMsgId = 1
  let uploadTaskIdOverride: string | null = null
  let temporalFileIdOverride: string | null = null

  const http: HttpServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/bridge/api/client/v1/oauth/token')) {
      drainBody(req).then((body) => {
        oauthRequests.push({
          headers: { ...req.headers } as Record<string, string | undefined>,
          body: body.toString('utf8'),
        })
        res.writeHead(oauthResponse.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(oauthResponse.body ?? {}))
      })
      return
    }
    if (req.method === 'POST' && req.url === '/bridge/api/client/v1/files') {
      drainBody(req).then((body) => {
        const uploadTaskId = (req.headers['upload-task-id'] as string | undefined) ?? ''
        const contentType = (req.headers['content-type'] as string | undefined) ?? null
        httpUploads.push({ uploadTaskId, bytes: body, contentType })
        const temporalFileId = temporalFileIdOverride ?? `temp_${nextTemporalFileId++}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ temporalFileId }))
      })
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/download/')) {
      const fileId = decodeURIComponent(req.url.slice('/download/'.length))
      const file = files.get(fileId)
      if (!file) { res.writeHead(404); res.end(); return }
      res.writeHead(200, {
        'content-type': file.mimeType,
        'content-length': String(file.body.length),
      })
      res.end(file.body)
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/websocket/chat_bot/',
    handleProtocols: (protocols) => (protocols.has('json.v1') ? 'json.v1' : false),
  })

  const send = (ws: WebSocket, obj: Json) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  const buildDownloadUrl = (fileId: string): string => {
    const addr = http.address() as { port: number }
    return `http://127.0.0.1:${addr.port}/download/${encodeURIComponent(fileId)}`
  }

  const replyFileInfo = (ws: WebSocket, id: number, fileId: string) => {
    const queue = fileInfoSequences.get(fileId)
    if (queue && queue.length > 0) {
      const next = queue.shift() as FakeFileInfoReply
      const payload: Json = { errorCode: next.errorCode ?? 0 }
      if (next.readyState !== undefined) payload.readyState = next.readyState
      if (next.size !== undefined) payload.size = next.size
      if (next.mimeType !== undefined) payload.mimeType = next.mimeType
      if (next.downloadUrl === null) payload.downloadUrl = null
      else if (next.downloadUrl !== undefined) payload.downloadUrl = next.downloadUrl
      else if (next.readyState === 2) payload.downloadUrl = buildDownloadUrl(fileId)
      send(ws, { type: 2, id, payload })
      return
    }
    const file = files.get(fileId)
    if (!file) {
      send(ws, { type: 2, id, payload: { errorCode: 0, readyState: 0 } })
      return
    }
    send(ws, {
      type: 2,
      id,
      payload: {
        errorCode: 0,
        readyState: 2,
        size: file.body.length,
        mimeType: file.mimeType,
        downloadUrl: buildDownloadUrl(fileId),
      },
    })
  }

  wss.on('connection', (ws) => {
    connections.add(ws)
    ws.on('message', (data) => {
      let msg: Json
      try { msg = JSON.parse(data.toString()) as Json } catch { return }
      const type = msg.type
      const id = msg.id as number
      if (type === 2) { clientAcks.push(id); return }
      if (type !== 1) return
      const method = msg.method as string
      const payload = (msg.payload as Json) ?? {}
      if (method === 'auth') {
        authRequests.push({ id, method, payload })
        if (pendingAuthFailures > 0) {
          pendingAuthFailures -= 1
          send(ws, { type: 2, id, payload: { errorCode: 1, errorDescription: 'forced' } })
          return
        }
        send(ws, { type: 2, id, payload: { errorCode: 0, userId: botUserId } })
        return
      }
      if (method === 'createP2PChat') {
        const userId = String(payload.userId ?? '')
        send(ws, { type: 2, id, payload: { errorCode: 0, chatId: `chat_${userId}` } })
        return
      }
      if (method === 'sendMessage') {
        messageRequests.push({ id, method, payload })
        send(ws, { type: 2, id, payload: { errorCode: 0, messageId: `msg_${id}` } })
        return
      }
      if (method === 'getFileInfo') {
        replyFileInfo(ws, id, String(payload.fileId ?? ''))
        return
      }
      if (method === 'subscribeFileProgress') {
        subscribeFileProgressRequests.push({ id, method, payload })
        send(ws, { type: 2, id, payload: { errorCode: 0, result: true } })
        return
      }
      if (method === 'unsubscribeFileProgress') {
        unsubscribeFileProgressRequests.push({ id, method, payload })
        send(ws, { type: 2, id, payload: { errorCode: 0 } })
        return
      }
      if (method === 'uploadFile') {
        uploadFileRequests.push({ id, method, payload })
        const uploadTaskId = uploadTaskIdOverride ?? `task_${nextUploadTaskId++}`
        send(ws, { type: 2, id, payload: { errorCode: 0, uploadTaskId } })
        return
      }
      if (method === 'sendFile') {
        sendFileRequests.push({ id, method, payload })
        const messageId = `fmsg_${nextSendFileMsgId++}`
        send(ws, { type: 2, id, payload: { errorCode: 0, messageId } })
        return
      }
      if (method === 'getChatByID') {
        getChatByIdRequests.push({ id, method, payload })
        const chatId = String(payload.chatId ?? '')
        const chatType = chatTypeOverrides.get(chatId) ?? 1
        send(ws, { type: 2, id, payload: { errorCode: 0, chatId, title: chatId, chatType, unreadMessages: 0 } })
        return
      }
      send(ws, { type: 2, id, payload: { errorCode: 0 } })
    })
    ws.on('close', () => { connections.delete(ws) })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const addr = http.address() as { port: number }

  const instance: FakeServer = {
    host: '127.0.0.1',
    port: addr.port,
    serverUrl: '127.0.0.1',
    authRequests,
    messageRequests,
    uploadFileRequests,
    sendFileRequests,
    getChatByIdRequests,
    subscribeFileProgressRequests,
    unsubscribeFileProgressRequests,
    httpUploads,
    oauthRequests,
    get oauthResponse() { return oauthResponse },
    set oauthResponse(value: FakeOAuthResponse) { oauthResponse = value },
    clientAcks,
    connections,
    setOauthResponse(value) { oauthResponse = value },
    setChatType(chatId, chatType) { chatTypeOverrides.set(chatId, chatType) },
    pushInbound(envelope) {
      const id = nextServerRequestId++
      for (const ws of connections) send(ws, { type: 1, id, method: 'sendMessage', payload: envelope })
    },
    pushFileProgress(fileId, progress) {
      const id = nextServerRequestId++
      for (const ws of connections) send(ws, { type: 1, id, method: 'uploadFileProgress', payload: { fileId, progress } })
    },
    dropAll() {
      for (const ws of connections) ws.terminate()
    },
    setFile(fileId, file) { files.set(fileId, file) },
    setFileInfoSequence(fileId, sequence) { fileInfoSequences.set(fileId, [...sequence]) },
    respondUploadTaskId(value) { uploadTaskIdOverride = value },
    respondTemporalFileId(value) { temporalFileIdOverride = value },
    async close() {
      for (const ws of connections) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }

  return instance
}

export async function stopFakeServer(server: FakeServer): Promise<void> {
  await server.close()
}

function drainBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((r) => setTimeout(r, stepMs))
  }
  throw new Error(`waitFor: predicate did not hold within ${timeoutMs}ms`)
}
