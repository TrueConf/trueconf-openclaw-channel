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

export interface FakeChat {
  chatId: string
  title: string
  chatType: 1 | 2 | 3 | 5 | 6
}

interface ChatRegistry {
  set(chats: FakeChat[]): void
  add(chat: FakeChat): void
  remove(chatId: string): void
  rename(chatId: string, newTitle: string): void
  getById(chatId: string): FakeChat | undefined
  getPage(page: number, count: number): FakeChat[]
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
  createP2PChatRequests: FakeRequest[]
  subscribeFileProgressRequests: FakeRequest[]
  unsubscribeFileProgressRequests: FakeRequest[]
  httpUploads: FakeHttpUpload[]
  oauthRequests: FakeOAuthRequest[]
  oauthResponse: FakeOAuthResponse
  clientAcks: number[]
  connections: Set<WebSocket>
  chats: ChatRegistry
  configureFailures: (opts: { getChats?: number; getChatByID?: number; getChatByIDOmitErrorCode?: number; getChatByIDErrorCode?: number }) => void
  delayAuthBy: (ms: number) => void
  // Schedules the next `count` auth requests to fail with errorCode=1.
  // Subsequent auths succeed normally. Used to exercise the reconnect-with-
  // failed-auth path that the OutboundQueue must park around.
  failNextAuth: (count: number) => void
  pushInbound: (envelope: Json) => void
  pushFileProgress: (fileId: string, progress: number) => void
  pushEvent: (method: string, payload: Json) => void
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
  // Used by tests/docker-e2e to bind on 0.0.0.0:fixed-port for cross-container
  // traffic. Defaults preserve in-process test behavior (loopback, ephemeral).
  host?: string
  port?: number
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
  const createP2PChatRequests: FakeRequest[] = []
  const subscribeFileProgressRequests: FakeRequest[] = []
  const unsubscribeFileProgressRequests: FakeRequest[] = []
  const chatTypeOverrides = new Map<string, number>()

  let chatList: FakeChat[] = []
  const chats: ChatRegistry = {
    set(next) { chatList = [...next] },
    add(chat) { chatList.push(chat) },
    remove(chatId) { chatList = chatList.filter((c) => c.chatId !== chatId) },
    rename(chatId, title) { const c = chatList.find((x) => x.chatId === chatId); if (c) c.title = title },
    getById(chatId) { return chatList.find((c) => c.chatId === chatId) },
    getPage(page, count) {
      const start = (page - 1) * count
      return chatList.slice(start, start + count)
    },
  }

  let getChatsFailures = 0
  let getChatByIDFailures = 0
  let getChatByIDOmitErrorCode = 0
  // Defaults to errorCode=1 (forced) to keep prior tests' semantics intact.
  // python-sdk-alignment scenario 1 sets it to 203 (CREDENTIALS_EXPIRED) so
  // WsClient triggers a forceReconnect on the next getChatByID.
  let getChatByIDErrorCode = 1
  function configureFailures(opts: { getChats?: number; getChatByID?: number; getChatByIDOmitErrorCode?: number; getChatByIDErrorCode?: number }): void {
    if (opts.getChats !== undefined) getChatsFailures = opts.getChats
    if (opts.getChatByID !== undefined) getChatByIDFailures = opts.getChatByID
    if (opts.getChatByIDOmitErrorCode !== undefined) getChatByIDOmitErrorCode = opts.getChatByIDOmitErrorCode
    if (opts.getChatByIDErrorCode !== undefined) getChatByIDErrorCode = opts.getChatByIDErrorCode
  }

  const httpUploads: FakeHttpUpload[] = []
  const oauthRequests: FakeOAuthRequest[] = []
  let oauthResponse: FakeOAuthResponse = opts.oauthResponse ?? makeDefaultOAuthResponse()
  const clientAcks: number[] = []
  let pendingAuthFailures = opts.failAuthOnce ? 1 : 0
  let authDelayMs = 0
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
        if (authDelayMs > 0) {
          const delay = authDelayMs
          setTimeout(() => {
            send(ws, { type: 2, id, payload: { errorCode: 0, userId: botUserId } })
          }, delay)
          return
        }
        send(ws, { type: 2, id, payload: { errorCode: 0, userId: botUserId } })
        return
      }
      if (method === 'createP2PChat') {
        createP2PChatRequests.push({ id, method, payload })
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
      if (method === 'getChats') {
        if (getChatsFailures > 0) {
          getChatsFailures -= 1
          send(ws, { type: 2, id, payload: { errorCode: 1, errorDescription: 'forced' } })
          return
        }
        const count = Number(payload.count ?? 100)
        const page = Number(payload.page ?? 1)
        const result = chats.getPage(page, count)
        // Real TrueConf returns the chat list as a bare array in `payload`,
        // not wrapped in `{ chats: [...] }`. Mirror that here so adapter
        // tests exercise the production envelope.
        send(ws, { type: 2, id, payload: result as unknown as Record<string, unknown> })
        return
      }
      if (method === 'getChatByID') {
        getChatByIdRequests.push({ id, method, payload })
        if (getChatByIDFailures > 0) {
          getChatByIDFailures -= 1
          send(ws, { type: 2, id, payload: { errorCode: getChatByIDErrorCode, errorDescription: 'forced' } })
          return
        }
        const chatId = String(payload.chatId ?? '')
        const reg = chats.getById(chatId)
        const basePayload: Json = reg
          ? { chatId, title: reg.title, chatType: reg.chatType, unreadMessages: 0 }
          : { chatId, title: chatId, chatType: chatTypeOverrides.get(chatId) ?? 1, unreadMessages: 0 }
        if (getChatByIDOmitErrorCode > 0) {
          getChatByIDOmitErrorCode -= 1
          send(ws, { type: 2, id, payload: basePayload })
          return
        }
        send(ws, { type: 2, id, payload: { errorCode: 0, ...basePayload } })
        return
      }
      send(ws, { type: 2, id, payload: { errorCode: 0 } })
    })
    ws.on('close', () => { connections.delete(ws) })
  })

  const bindHost = opts.host ?? '127.0.0.1'
  const bindPort = opts.port ?? 0
  await new Promise<void>((resolve) => http.listen(bindPort, bindHost, resolve))
  const addr = http.address() as { port: number }

  const instance: FakeServer = {
    host: bindHost,
    port: addr.port,
    serverUrl: bindHost,
    authRequests,
    messageRequests,
    uploadFileRequests,
    sendFileRequests,
    getChatByIdRequests,
    createP2PChatRequests,
    subscribeFileProgressRequests,
    unsubscribeFileProgressRequests,
    httpUploads,
    oauthRequests,
    get oauthResponse() { return oauthResponse },
    set oauthResponse(value: FakeOAuthResponse) { oauthResponse = value },
    clientAcks,
    connections,
    chats,
    configureFailures,
    delayAuthBy: (ms) => { authDelayMs = ms },
    failNextAuth: (count) => { pendingAuthFailures = count },
    setOauthResponse(value) { oauthResponse = value },
    setChatType(chatId, chatType) { chatTypeOverrides.set(chatId, chatType) },
    pushInbound(envelope) {
      const id = nextServerRequestId++
      for (const ws of connections) send(ws, { type: 1, id, method: 'sendMessage', payload: envelope })
    },
    pushEvent(method, payload) {
      const id = nextServerRequestId++
      for (const ws of connections) send(ws, { type: 1, id, method, payload })
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
