import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'crypto'

function sql() {
  const url = process.env.POSTGRES_URL
  if (!url) throw new Error('POSTGRES_URL is not set')
  return neon(url)
}

export async function runMigrations(): Promise<void> {
  const db = sql()
  await db`
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key         TEXT UNIQUE NOT NULL,
      installation_id TEXT NOT NULL,
      github_user     TEXT,
      repo            TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await db`
    CREATE TABLE IF NOT EXISTS designer_sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id),
      token       TEXT UNIQUE NOT NULL,
      github_user TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      last_seen   TIMESTAMPTZ
    )
  `
  await db`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       TEXT PRIMARY KEY,
      user_id    UUID REFERENCES users(id),
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await db`
    ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE
  `
  await db`ALTER TABLE designer_sessions ADD COLUMN IF NOT EXISTS invite_code TEXT REFERENCES invite_codes(code)`
  await db`
    CREATE TABLE IF NOT EXISTS invite_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invite_code TEXT NOT NULL REFERENCES invite_codes(code),
      event_type  TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await db`
    ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `
  await db`
    UPDATE invite_codes SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL
  `
  await db`
    ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ
  `
}

export interface User {
  id: string
  api_key: string
  installation_id: string
  github_user: string | null
  repo: string | null
  created_at: string
}

export interface DesignerSession {
  id: string
  user_id: string
  token: string
  github_user: string | null
  invite_code: string | null
  created_at: string
  last_seen: string | null
}

export interface FunnelRow {
  invite_code: string
  created_at: string
  invite_generated: boolean
  invite_opened: boolean
  config_started: boolean
  issue_viewed: boolean
  comment_submitted: boolean
}

export interface InviteCode {
  code: string
  user_id: string
  used: boolean
  is_demo: boolean
  created_at: string
  expires_at: string | null
  opened_at: string | null
}

export async function createUser(params: {
  installationId: string
  githubUser: string
  repo?: string
}): Promise<User> {
  const db = sql()
  const apiKey = randomUUID()
  const rows = await db`
    INSERT INTO users (api_key, installation_id, github_user, repo)
    VALUES (${apiKey}, ${params.installationId}, ${params.githubUser}, ${params.repo ?? null})
    RETURNING *
  `
  return rows[0] as User
}

export async function getUserByApiKey(apiKey: string): Promise<User | null> {
  const db = sql()
  const rows = await db`SELECT * FROM users WHERE api_key = ${apiKey} LIMIT 1`
  return (rows[0] as User) ?? null
}

export async function getUserByGithubUser(githubUser: string): Promise<User | null> {
  const db = sql()
  const rows = await db`SELECT * FROM users WHERE github_user = ${githubUser} LIMIT 1`
  return (rows[0] as User) ?? null
}

export async function getUserByInstallationId(installationId: string): Promise<User | null> {
  const db = sql()
  const rows = await db`SELECT * FROM users WHERE installation_id = ${installationId} LIMIT 1`
  return (rows[0] as User) ?? null
}

export async function getUserById(id: string): Promise<User | null> {
  const db = sql()
  const rows = await db`SELECT * FROM users WHERE id = ${id} LIMIT 1`
  return (rows[0] as User) ?? null
}

export async function updateUserGithubUser(id: string, githubUser: string): Promise<void> {
  const db = sql()
  await db`UPDATE users SET github_user = ${githubUser} WHERE id = ${id}`
}

export async function updateUserRepo(id: string, repo: string): Promise<void> {
  const db = sql()
  await db`UPDATE users SET repo = ${repo} WHERE id = ${id}`
}

export async function createDesignerSession(params: {
  userId: string
  token: string
  githubUser: string
  inviteCode?: string
}): Promise<DesignerSession> {
  const db = sql()
  const rows = await db`
    INSERT INTO designer_sessions (user_id, token, github_user, invite_code)
    VALUES (${params.userId}, ${params.token}, ${params.githubUser}, ${params.inviteCode ?? null})
    RETURNING *
  `
  return rows[0] as DesignerSession
}

export async function getDesignerSessionByToken(token: string): Promise<DesignerSession | null> {
  const db = sql()
  const rows = await db`SELECT * FROM designer_sessions WHERE token = ${token} LIMIT 1`
  return (rows[0] as DesignerSession) ?? null
}

export async function updateDesignerLastSeen(id: string): Promise<void> {
  const db = sql()
  await db`UPDATE designer_sessions SET last_seen = NOW() WHERE id = ${id}`
}

export async function listSessionsForUser(userId: string): Promise<DesignerSession[]> {
  const db = sql()
  const rows = await db`
    SELECT * FROM designer_sessions WHERE user_id = ${userId} ORDER BY created_at DESC
  `
  return rows as DesignerSession[]
}

export async function createInviteCode(userId: string, isDemo = false, ttlDays?: number): Promise<InviteCode> {
  const db = sql()
  const code = randomUUID()
  const days = ttlDays ?? Number(process.env.INVITE_TTL_DAYS ?? 7)
  const rows = await db`
    INSERT INTO invite_codes (code, user_id, is_demo, expires_at)
    VALUES (${code}, ${userId}, ${isDemo}, NOW() + (${days} || ' days')::INTERVAL)
    RETURNING *
  `
  return rows[0] as InviteCode
}

export async function resendInviteCode(oldCode: string, userId: string): Promise<InviteCode> {
  const db = sql()
  // Mark the old code as used so it disappears from the pending list
  await db`UPDATE invite_codes SET used = TRUE WHERE code = ${oldCode} AND user_id = ${userId}`
  return createInviteCode(userId)
}

export function isInviteExpired(invite: InviteCode): boolean {
  if (!invite.expires_at) return false
  return new Date(invite.expires_at) < new Date()
}

export async function getInviteCode(code: string): Promise<InviteCode | null> {
  const db = sql()
  const rows = await db`SELECT * FROM invite_codes WHERE code = ${code} LIMIT 1`
  return (rows[0] as InviteCode) ?? null
}

export async function markInviteOpened(code: string): Promise<void> {
  const db = sql()
  await db`UPDATE invite_codes SET opened_at = NOW() WHERE code = ${code} AND opened_at IS NULL`
}

export async function markInviteUsed(code: string): Promise<void> {
  const db = sql()
  await db`UPDATE invite_codes SET used = TRUE WHERE code = ${code}`
}

export async function revokeDesignerSession(sessionId: string): Promise<void> {
  const db = sql()
  await db`DELETE FROM designer_sessions WHERE id = ${sessionId}`
}

export async function listPendingInvitesForUser(userId: string): Promise<InviteCode[]> {
  const db = sql()
  const rows = await db`
    SELECT * FROM invite_codes
    WHERE user_id = ${userId} AND used = FALSE
    ORDER BY created_at DESC
  `
  return rows as InviteCode[]
}

export async function recordInviteEvent(inviteCode: string, eventType: string): Promise<void> {
  const db = sql()
  await db`
    INSERT INTO invite_events (invite_code, event_type) VALUES (${inviteCode}, ${eventType})
  `
}

export async function getFunnelForUser(userId: string): Promise<FunnelRow[]> {
  const db = sql()
  const rows = await db`
    SELECT
      ic.code        AS invite_code,
      ic.created_at,
      bool_or(ie.event_type = 'invite_generated')  AS invite_generated,
      bool_or(ie.event_type = 'invite_opened')     AS invite_opened,
      bool_or(ie.event_type = 'config_started')    AS config_started,
      bool_or(ie.event_type = 'issue_viewed')      AS issue_viewed,
      bool_or(ie.event_type = 'comment_submitted') AS comment_submitted
    FROM invite_codes ic
    LEFT JOIN invite_events ie ON ie.invite_code = ic.code
    WHERE ic.user_id = ${userId}
    GROUP BY ic.code, ic.created_at
    ORDER BY ic.created_at DESC
  `
  return rows as FunnelRow[]
}

export async function countInviteCodes(): Promise<number> {
  const db = sql()
  const rows = await db`SELECT COUNT(*)::int AS n FROM invite_codes`
  return (rows[0] as { n: number }).n
}

export async function getFirstUser(): Promise<User | null> {
  const db = sql()
  const rows = await db`SELECT * FROM users ORDER BY created_at ASC LIMIT 1`
  return (rows[0] as User) ?? null
}
