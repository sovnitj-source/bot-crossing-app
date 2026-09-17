import { DEMO_MESSAGE } from './_demo-data.js'

export default function handler(req, res) {
  res.status(400).json({ ok: false, error: DEMO_MESSAGE })
}
