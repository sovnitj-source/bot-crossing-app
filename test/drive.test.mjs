import test from 'node:test'
import assert from 'node:assert/strict'
import { attachSession, detachSession, sendToSession, stopSession } from '../server/lib/drive.mjs'

const fixtureDriveThread = async () => ({
  ok: true,
  protocol: 'claude-stream-json',
  command: { argv: ['cat'], cwd: process.cwd() },
})

const rejectingDriveThread = async () => ({ ok: false, error: 'not drivable in this fixture' })

function fakeWs() {
  const messages = []
  let closedWith = null
  return {
    messages,
    send(text) {
      messages.push(JSON.parse(text))
    },
    close(code) {
      closedWith = code
    },
    get closedWith() {
      return closedWith
    },
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const uniqueId = (label) => `test-drive:${label}:${Math.random().toString(36).slice(2)}`

test('attach spawns the driven process and announces attached, live for claude-stream-json', async () => {
  const id = uniqueId('attach')
  const ws = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws)
  assert.equal(ws.messages.length, 1)
  assert.deepEqual(ws.messages[0], { type: 'attached', threadId: id, live: true })
  stopSession(id)
})

test('a rejected driveThread sends one error, closes with 4003, and never spawns anything', async () => {
  const id = uniqueId('reject')
  const ws = fakeWs()
  await attachSession(id, 'claude-code', {}, rejectingDriveThread, ws)
  assert.equal(ws.messages.length, 1)
  assert.equal(ws.messages[0].type, 'error')
  assert.equal(ws.messages[0].error, 'not drivable in this fixture')
  assert.equal(ws.closedWith, 4003)
})

test('input round-trips through the process as a buffered event, and a later attach replays it', async () => {
  const id = uniqueId('replay')
  const ws1 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws1)
  await sendToSession(id, 'hello')
  await wait(200)

  const events = ws1.messages.filter((m) => m.type === 'event')
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].event, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })

  const ws2 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws2)
  const replay = ws2.messages.find((m) => m.type === 'replay')
  assert.ok(replay, 'second attach receives a replay message')
  assert.equal(replay.events.length, 1)
  assert.deepEqual(replay.events[0], events[0])

  detachSession(id, ws1)
  detachSession(id, ws2)
  stopSession(id)
})

test('detaching the last client leaves the process alive — a reattach reuses it, not a new one', async () => {
  const id = uniqueId('idle')
  const ws1 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws1)
  detachSession(id, ws1)

  await sendToSession(id, 'still here')
  await wait(200)

  const ws2 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws2)
  const replay = ws2.messages.find((m) => m.type === 'replay')
  assert.ok(replay, 'the session survived the detach, so its buffered output is still there to replay')
  assert.ok(replay.events.some((e) => e.event?.message?.content?.[0]?.text === 'still here'))

  detachSession(id, ws2)
  stopSession(id)
})

test('an explicit stop ends the process, and attaching again afterward spawns a fresh one', async () => {
  const id = uniqueId('stop')
  const ws1 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws1)
  stopSession(id)
  await wait(300)

  const ended = ws1.messages.find((m) => m.type === 'ended')
  assert.ok(ended, 'stop() broadcasts an ended event to whoever is still attached')

  const ws2 = fakeWs()
  await attachSession(id, 'claude-code', {}, fixtureDriveThread, ws2)
  assert.equal(ws2.messages[0].type, 'attached')
  await sendToSession(id, 'still alive?')
  await wait(200)
  assert.ok(ws2.messages.some((m) => m.type === 'event'), 'the fresh process actually answers input')

  stopSession(id)
})

test('sending to a thread with no session at all is a silent no-op, not a throw', async () => {
  await assert.doesNotReject(sendToSession(uniqueId('missing'), 'hello'))
})

test('stopping a thread with no session at all is a silent no-op, not a throw', () => {
  assert.doesNotThrow(() => stopSession(uniqueId('missing')))
})
