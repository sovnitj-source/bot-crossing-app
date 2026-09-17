import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

export function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}

export const DRIVE_TOKEN = crypto.randomBytes(32).toString('hex')

export function isValidDriveToken(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(DRIVE_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function announceDriveToken(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true })
  const file = path.join(dataDir, '.drive-token')
  await fsp.writeFile(file, DRIVE_TOKEN + '\n', { mode: 0o600 })
  console.log(`bot-crossing: drive token (paste into a thread's "Drive" panel) → ${DRIVE_TOKEN}`)
  console.log(`bot-crossing: also written to ${file}`)
}
