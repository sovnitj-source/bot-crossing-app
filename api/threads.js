import { demoThreads } from './_demo-data.js'

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({ threads: demoThreads(), scannedAt: Date.now(), warnings: [] })
}
