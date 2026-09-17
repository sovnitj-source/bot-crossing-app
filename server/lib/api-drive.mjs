import { WebSocketServer } from 'ws'
import { isLocalRequest, isValidDriveToken } from './security.mjs'
import { attachSession, detachSession, sendToSession, stopSession } from './drive.mjs'
import { HARNESSES } from '../harnesses/index.mjs'

const wss = new WebSocketServer({ noServer: true })

function rejectAuth(socket) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

export function handleDriveUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/drive') return

  if (!isLocalRequest(req)) return rejectAuth(socket)

  const protocols = Array.isArray(req.headers['sec-websocket-protocol'])
    ? req.headers['sec-websocket-protocol']
    : (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
  const tokenProtocol = protocols.find((p) => p.startsWith('bc.token.'))
  if (!tokenProtocol || !isValidDriveToken(tokenProtocol.slice(9))) return rejectAuth(socket)

  const harness = url.searchParams.get('harness')
  const thread = url.searchParams.get('thread')
  const refRaw = url.searchParams.get('ref')

  if (!harness || !thread || !refRaw) return rejectAuth(socket)

  let ref
  try {
    ref = JSON.parse(decodeURIComponent(refRaw))
  } catch {
    return rejectAuth(socket)
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg.type === 'input') {
          sendToSession(thread, msg.text)
        } else if (msg.type === 'stop') {
          stopSession(thread)
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Malformed message' }))
      }
    })

    ws.on('close', () => {
      detachSession(thread, ws)
    })

    ws.on('error', () => {
      detachSession(thread, ws)
    })

    const adapter = HARNESSES.find((h) => h.id === harness)
    const driveThread = adapter?.driveThread || (async () => ({ ok: false, error: 'Harness does not support driving' }))

    attachSession(thread, harness, ref, driveThread, ws)
  })
}
