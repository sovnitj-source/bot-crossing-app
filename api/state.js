/**
 * The demo has nothing to persist to — a Vercel function keeps no disk between requests — so a
 * save always "succeeds" and is simply handed back with a fresh timestamp. Archiving, dragging
 * plots, and hiding a project all work for as long as the tab stays open; a reload starts over
 * from the same sample colony.
 */
const emptyState = () => ({
  version: 2,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  hiddenProjects: [],
  viewedAt: {},
  settings: null,
  updatedAt: 0,
})

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    return res.status(200).json(emptyState())
  }

  if (req.method === 'PUT') {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const { baseUpdatedAt, ...state } = body
    return res.status(200).json({ ...emptyState(), ...state, updatedAt: Date.now() })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
