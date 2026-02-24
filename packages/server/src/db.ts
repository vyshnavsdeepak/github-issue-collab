import Database from 'better-sqlite3'
import type { Role, Session, InviteCode } from './types.js'

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    const dbPath = process.env.COLLAB_DB_PATH ?? './collab.db'
    _db = new Database(dbPath)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        github_user TEXT,
        created_at TEXT NOT NULL,
        last_seen TEXT
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_number INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }
  return _db
}

export function createSession(params: {
  id: string
  role: Role
  token: string
  github_user?: string
}): Session {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO sessions (id, role, token, github_user, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(params.id, params.role, params.token, params.github_user ?? null, now)
  return { ...params, created_at: now }
}

export function getSessionByToken(token: string): Session | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as Session | undefined
}

export function updateLastSeen(id: string): void {
  const db = getDb()
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), id)
}

export function listActiveSessions(): Session[] {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as Session[]
}

export function createInviteCode(code: string): InviteCode {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO invite_codes (code, used, created_at) VALUES (?, 0, ?)').run(code, now)
  return { code, used: 0, created_at: now }
}

export function getInviteCode(code: string): InviteCode | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as InviteCode | undefined
}

export function markInviteCodeUsed(code: string): void {
  const db = getDb()
  db.prepare('UPDATE invite_codes SET used = 1 WHERE code = ?').run(code)
}

export function listUnusedInviteCodes(): InviteCode[] {
  const db = getDb()
  return db.prepare('SELECT * FROM invite_codes WHERE used = 0 ORDER BY created_at DESC').all() as InviteCode[]
}
