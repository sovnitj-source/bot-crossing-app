import { spawn } from 'node:child_process'
import readline from 'node:readline'

const IDLE_TIMEOUT_MS = 2 * 60 * 1000
const MID_TURN_CEILING_MS = 10 * 60 * 1000

class Session {
  constructor(threadId, harnessId, protocol, command, poll) {
    this.threadId = threadId
    this.harnessId = harnessId
    this.protocol = protocol
    this.command = command
    this.poll = poll

    this.child = null
    this.clients = new Set()
    this.outBuffer = []
    this.lastActivityAt = Date.now()
    this.midTurn = false
    this.idleTimer = null
    this.pollTimer = null
    this.ended = false
  }

  start() {
    if (this.protocol === 'claude-stream-json') {
      this._startClaude()
    } else if (this.protocol === 'antigravity-async') {
      this._startGemini()
    }
  }

  _startClaude() {
    const { argv, cwd } = this.command
    try {
      this.child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this._broadcast({ type: 'error', error: err?.message || String(err) })
      this.ended = true
      return
    }

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line)
        this._bufferAndBroadcast({ type: 'event', event })
      } catch {
        // Malformed line in stream-json, skip it
      }
    })

    this.child.stderr.on('data', (chunk) => {
      this._bufferAndBroadcast({ type: 'stderr', text: String(chunk) })
    })

    this.child.on('exit', (code, signal) => {
      rl.close()
      this._bufferAndBroadcast({ type: 'ended', code, signal })
      this.ended = true
      this.child = null
    })

    this.child.on('error', (err) => {
      this._broadcast({ type: 'error', error: err?.message || String(err) })
      this.ended = true
    })
  }

  _startGemini() {
    // Gemini has no persistent child. Polling starts when the first client attaches.
  }

  _startPoll() {
    if (this.pollTimer) return
  }

  _stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  attach(ws) {
    this.clients.add(ws)
    this.lastActivityAt = Date.now()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    if (this.outBuffer.length) {
      ws.send(JSON.stringify({ type: 'replay', events: this.outBuffer }))
    }

    ws.send(JSON.stringify({ type: 'attached', threadId: this.threadId, live: this.protocol === 'claude-stream-json' }))
  }

  detach(ws) {
    this.clients.delete(ws)
    if (this.clients.size === 0) {
      this._startIdleTimeout()
      this._stopPoll()
    }
  }

  _startIdleTimeout() {
    if (this.idleTimer || !this.child || this.ended) return
    this.idleTimer = setTimeout(() => {
      this.stop()
    }, this.midTurn ? MID_TURN_CEILING_MS : IDLE_TIMEOUT_MS)
    this.idleTimer.unref?.()
  }

  stop() {
    this._stopPoll()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.child && !this.ended) {
      this.child.kill('SIGTERM')
      const killTimer = setTimeout(() => {
        if (!this.ended && this.child) {
          this.child.kill('SIGKILL')
        }
      }, 2000)
      killTimer.unref?.()
    }
  }

  _bufferAndBroadcast(msg) {
    this.outBuffer.push(msg)
    if (this.outBuffer.length > 200) {
      this.outBuffer = this.outBuffer.slice(-200)
    }
    this._broadcast(msg)
  }

  _broadcast(msg) {
    const text = JSON.stringify(msg)
    for (const ws of this.clients) {
      try {
        ws.send(text)
      } catch {
        // Client may have disconnected; detach will clean it up
      }
    }
  }

  async send(text) {
    if (this.protocol !== 'claude-stream-json') return

    if (this.child && !this.ended) {
      this.midTurn = true
      const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
      } catch (err) {
        this._broadcast({ type: 'error', error: err?.message || String(err) })
      }
    }
  }
}

const sessions = new Map()

export async function attachSession(threadId, harnessId, ref, driveThread, ws) {
  let session = sessions.get(threadId)

  if (session && session.ended) {
    sessions.delete(threadId)
    session = null
  }

  if (!session) {
    const result = await driveThread(ref)
    if (!result.ok) {
      ws.send(JSON.stringify({ type: 'error', error: result.error }))
      ws.close(4003)
      return
    }

    session = new Session(threadId, harnessId, result.protocol, result.command, result.poll)
    sessions.set(threadId, session)
    session.start()
  }

  session.attach(ws)
}

export function detachSession(threadId, ws) {
  const session = sessions.get(threadId)
  if (session) {
    session.detach(ws)
    if (session.clients.size === 0 && session.ended) {
      sessions.delete(threadId)
    }
  }
}

export async function sendToSession(threadId, text) {
  const session = sessions.get(threadId)
  if (session) {
    await session.send(text)
  }
}

export function stopSession(threadId) {
  const session = sessions.get(threadId)
  if (session) {
    session.stop()
  }
}

export function shutdownAll() {
  for (const session of sessions.values()) {
    session.stop()
  }
}
