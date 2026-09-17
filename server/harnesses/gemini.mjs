/**
 * Harness adapter: Gemini — the Antigravity app, which is what "Gemini" means on disk today.
 *
 * Google stopped serving Gemini CLI to individual accounts (see server/harnesses/README.md);
 * what actually runs Gemini-family agent threads now is Antigravity, and it keeps its state
 * under `~/.gemini/antigravity` — same home directory Gemini CLI used, new app. This adapter
 * reads that store, id `gemini`, so a Gemini thread shows up as a Gemini astronaut whichever
 * app underneath produced it.
 *
 * Unlike Claude Code and Codex, Antigravity's on-disk shape is not documented anywhere public:
 * one SQLite database per conversation, under `conversations/<id>.db`, whose interesting
 * columns (`step_payload`, `render_info`, executor metadata, …) are opaque protobuf blobs with
 * no published schema. There is no cwd, no git branch, no title field, and no lifecycle enum
 * we can decode with confidence — so this adapter does not invent them. What it does do:
 * protobuf still writes string fields as raw length-prefixed UTF-8, so scanning a blob for the
 * longest run of printable text recovers a usable preview/title/model most of the time. That is
 * a heuristic, not a parser, and it is written to degrade to "skip this field" rather than to a
 * wrong answer — same rule as every other adapter in this directory.
 *
 * Read-only, without exception, like every harness here.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, listFiles, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const GEMINI_HOME = process.env.GEMINI_HOME || path.join(HOME, '.gemini')
const ANTIGRAVITY_HOME = path.join(GEMINI_HOME, 'antigravity')
const CONVERSATIONS_DIR = path.join(ANTIGRAVITY_HOME, 'conversations')
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, 'brain')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `gemini:${raw}`

/** Same lazy, survivable import as codex.mjs — an older Node costs this harness, not the server. */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/**
 * Pull the longest printable runs out of a protobuf blob. String fields in proto3's wire format
 * are length-prefixed UTF-8 with no other framing, so real prose survives this even without the
 * message schema; binary noise (varints, embedded messages) does not decode as printable text
 * and falls out on its own. Short runs are almost always field names or ids, not content.
 */
function printableRuns(buf, minLen = 20) {
  const runs = []
  let start = -1
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0
    const printable = b === 0x09 || b === 0x0a || (b >= 0x20 && b < 0x7f)
    if (printable) {
      if (start === -1) start = i
    } else {
      if (start !== -1 && i - start >= minLen) runs.push(buf.toString('utf8', start, i))
      start = -1
    }
  }
  return runs
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * A run that reads as a sentence rather than an id, a flag dump, or protobuf framing bytes that
 * happened to land in the printable ASCII range (`"` and `$` are common ones, at 0x22 and 0x24).
 * Rejecting on those and requiring a letter-heavy, multi-word run is what keeps the heuristic
 * from mistaking a run of ids-with-punctuation for a sentence — cheap, but it is what the sample
 * data actually needed: real task text passes easily, id soup does not.
 */
function looksLikeProse(s) {
  if (UUID_ANYWHERE.test(s) || /["$]/.test(s)) return false
  const letters = (s.match(/[A-Za-z]/g) || []).length
  if (letters / s.length < 0.6) return false
  return s.split(/\s+/).filter(Boolean).length >= 4
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/**
 * Best-effort facts from one conversation database: a preview/title candidate from the earliest
 * step that has one, and a model name if one of the scanned blobs happens to carry it. Every
 * read is bounded and every failure just means a field stays blank — see the module note above.
 */
async function readConversationFacts(file) {
  const facts = { preview: '', model: '', planTitle: '' }
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return facts

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    return facts // WAL sidecars mid-write can refuse a read-only open; try again next scan
  }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    )

    if (tables.has('steps')) {
      try {
        const rows = db
          .prepare('SELECT step_payload, render_info FROM steps ORDER BY idx LIMIT 40')
          .all()
        outer: for (const row of rows) {
          for (const col of ['step_payload', 'render_info']) {
            const blob = row[col]
            if (!blob) continue
            for (const run of printableRuns(Buffer.from(blob))) {
              const text = clean(run)
              if (looksLikeProse(text)) {
                facts.preview = text.slice(0, 400)
                break outer
              }
            }
          }
        }
      } catch {
        /* schema drifted — leave preview blank rather than guess at a different shape */
      }
    }

    if (tables.has('executor_metadata')) {
      try {
        const rows = db.prepare('SELECT data FROM executor_metadata LIMIT 3').all()
        for (const row of rows) {
          if (!row.data) continue
          const text = Buffer.from(row.data).toString('latin1')
          const m = /gemini-[a-z0-9][a-z0-9.-]*/i.exec(text)
          if (m) {
            facts.model = m[0]
            break
          }
        }
      } catch {
        /* no readable model string this pass */
      }
    }
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }

  return facts
}

/** `brain/<id>/implementation_plan.md` is written for some threads and, when present, gives a
 *  far cleaner title than anything recoverable from the blobs above. */
async function readPlanTitle(id) {
  try {
    const text = await fsp.readFile(path.join(BRAIN_DIR, id, 'implementation_plan.md'), 'utf8')
    const m = /^#\s+(.+)$/m.exec(text)
    return m ? clean(m[1]).replace(/^Implementation Plan:\s*/i, '') : ''
  } catch {
    return ''
  }
}

/** Facts are expensive to re-derive (opens a database, scans blobs), so keep them until the
 *  conversation's own files stop changing — the same trade `transcriptMeta` makes in codex.mjs. */
const factsCache = new Map()
async function cachedFacts(id, file, sizeBytes, mtimeMs) {
  const cached = factsCache.get(id)
  if (cached && cached.size === sizeBytes && cached.mtime === mtimeMs) return cached.facts
  const [conv, planTitle] = await Promise.all([readConversationFacts(file), readPlanTitle(id)])
  const facts = { ...conv, planTitle }
  factsCache.set(id, { size: sizeBytes, mtime: mtimeMs, facts })
  return facts
}

async function scanThreads() {
  const files = await listFiles(CONVERSATIONS_DIR, (n) => n.endsWith('.db'))
  const out = []

  for (const file of files) {
    const id = path.basename(file, '.db')
    if (!UUID.test(id)) continue

    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue // vanished between listing and stat
    }
    // A WAL sidecar holds the most recent, not-yet-checkpointed writes — its mtime is the truer
    // "last touched" and its size is part of how much this thread actually holds right now.
    let walSize = 0
    let walMtime = 0
    try {
      const wal = await fsp.stat(`${file}-wal`)
      walSize = wal.size
      walMtime = wal.mtimeMs
    } catch {
      /* checkpointed, or never wrote one this session — fine either way */
    }

    const facts = await cachedFacts(id, file, stat.size + walSize, Math.max(stat.mtimeMs, walMtime))
    const title = facts.planTitle || facts.preview.split(/(?<=[.!?])\s/)[0] || ''

    out.push({
      id: ID(id),
      title: (title || 'Untitled thread').slice(0, 120),
      preview: facts.preview.slice(0, 240),
      // Antigravity's on-disk store has no field and no side file mapping a conversation back to
      // the folder it worked in (checked: app_storage.json, the per-conversation `brain/` and
      // `scratch/` directories, the pbtxt state file — none of it carries the path). Reporting a
      // guess here would be worse than reporting nothing; see the module note above.
      project: 'unknown',
      projectPath: '',
      worktree: '',
      cwd: '',
      gitBranch: '',
      model: facts.model,
      effort: '',
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      lastActivityAt: Math.max(stat.mtimeMs, walMtime),
      lastFocusedAt: 0,
      // The `steps.status` column is real but its integer values are an undocumented enum we
      // have not cross-checked against enough examples to trust — reporting a guessed "running"
      // or "hasError" would be exactly the wrong-answer failure mode this adapter is written to
      // avoid. Honestly false until that enum is confirmed, per the harness README's own rule.
      running: false,
      unread: false,
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: stat.size + walSize,
      source: 'antigravity',
      // No confirmed deep link back into a specific conversation — see openThread().
      canOpen: false,
      ref: { conversationId: id },
    })
  }
  return out
}

function openThread() {
  return {
    ok: false,
    error: 'Bot Crossing has not confirmed a working deep link back into a specific Antigravity conversation yet',
  }
}

/**
 * Antigravity registers the `antigravity://` scheme (role: Editor), the same family as
 * `vscode://file/<path>` and `cursor://file/<path>` in every other VS Code-based app — but that
 * is an inference from the app bundle's own Info.plist, not a confirmed behaviour, and this
 * adapter would rather say so than launch a GUI app on an unverified guess.
 */
function newSession() {
  return {
    ok: false,
    error: 'Bot Crossing has not confirmed a working "new session" deep link for Antigravity yet',
  }
}

async function detect() {
  return exists(CONVERSATIONS_DIR)
}

/** Why a present Gemini might still show threads with blank titles/models. */
async function diagnostic() {
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Gemini threads need Node 22.13 or newer to read their databases (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'gemini',
  name: 'Gemini',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { ANTIGRAVITY_HOME, CONVERSATIONS_DIR },
}
