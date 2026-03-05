/**
 * Smoke test: end-to-end designer invite flow
 *
 * Covers the regression scenario from issue #56 where server startup / env
 * validation changes silently broke invite routes. Uses an in-memory DB mock
 * so no Neon connection is required.
 *
 * Steps exercised:
 *   1. Create an invite code via the dashboard API
 *   2. GET /invite?code=<token>  →  HTML with GitHub OAuth sign-in link (no name form)
 *   3. GET /invite/oauth/callback →  designer session created in DB + redirect to /designer
 *   4. GET /invite/oauth/callback sets a designer_session cookie
 */

import { vi, describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'

// Mock GitHub API calls used by the OAuth callback
vi.mock('../github.js', () => ({
  getInstallationToken: () => Promise.resolve('fake-gh-token'),
  listIssues: () => Promise.resolve([]),
  getIssue: () => Promise.resolve(null),
  listIssueComments: () => Promise.resolve([]),
  addComment: () => Promise.resolve({ html_url: 'https://github.com' }),
  addLabel: () => Promise.resolve(),
  removeLabel: () => Promise.resolve(),
  getAuthUser: (_token: string) => Promise.resolve({ login: 'alice' }),
}))

// ---------------------------------------------------------------------------
// In-memory DB state — hoisted so the vi.mock factory can reference it
// ---------------------------------------------------------------------------

const { users, inviteCodes, sessions, newId } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('crypto') as typeof import('crypto')
  return {
    users: new Map<string, Record<string, unknown>>(),
    inviteCodes: new Map<string, Record<string, unknown>>(),
    sessions: new Map<string, Record<string, unknown>>(),
    newId: randomUUID as () => string,
  }
})

// Mock the DB module with an in-memory implementation
vi.mock('../db.js', () => ({
  getUserByApiKey: (apiKey: string) =>
    Promise.resolve([...users.values()].find((u) => u['api_key'] === apiKey) ?? null),

  getUserById: (id: string) => Promise.resolve(users.get(id) ?? null),

  getInviteCode: (code: string) => Promise.resolve(inviteCodes.get(code) ?? null),

  createInviteCode: (userId: string, isDemo = false) => {
    const code = newId()
    const invite = { code, user_id: userId, used: false, is_demo: isDemo, created_at: new Date().toISOString() }
    inviteCodes.set(code, invite)
    return Promise.resolve(invite)
  },

  markInviteUsed: (code: string) => {
    const invite = inviteCodes.get(code)
    if (invite) invite['used'] = true
    return Promise.resolve()
  },

  createDesignerSession: (params: { userId: string; token: string; githubUser: string; inviteCode?: string }) => {
    const session = {
      id: newId(),
      user_id: params.userId,
      token: params.token,
      github_user: params.githubUser,
      invite_code: params.inviteCode ?? null,
      created_at: new Date().toISOString(),
      last_seen: null,
    }
    sessions.set(params.token, session)
    return Promise.resolve(session)
  },

  getDesignerSessionByToken: (token: string) => Promise.resolve(sessions.get(token) ?? null),
  updateDesignerLastSeen: () => Promise.resolve(),
  listSessionsForUser: () => Promise.resolve([]),
  listPendingInvitesForUser: () => Promise.resolve([]),
  isInviteExpired: (invite: Record<string, unknown>) => {
    if (!invite['expires_at']) return false
    return new Date(invite['expires_at'] as string) < new Date()
  },
  markInviteOpened: () => Promise.resolve(),
  recordInviteEvent: () => Promise.resolve(),
  resendInviteCode: () => Promise.resolve(null),
  runMigrations: () => Promise.resolve(),
  countInviteCodes: () => Promise.resolve(inviteCodes.size),
  getFirstUser: () => Promise.resolve([...users.values()][0] ?? null),
  createUser: (params: { installationId: string; githubUser: string; repo?: string }) => {
    const user = {
      id: newId(),
      api_key: newId(),
      installation_id: params.installationId,
      github_user: params.githubUser,
      repo: params.repo ?? null,
      created_at: new Date().toISOString(),
    }
    users.set(user.id as string, user)
    return Promise.resolve(user)
  },
}))

// Mock validateEnv so missing real env vars don't abort the process
vi.mock('../validateEnv.js', () => ({ validateEnv: () => {} }))

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let app: Express
let testApiKey: string
let testUserId: string

beforeAll(async () => {
  // Prevent the server from binding to a port when imported
  process.env.VERCEL = '1'

  // Satisfy any env-var checks inside route handlers that aren't mocked
  process.env.GITHUB_APP_ID = 'test-app-id'
  process.env.GITHUB_APP_CLIENT_ID = 'test-client-id'
  process.env.GITHUB_APP_CLIENT_SECRET = 'test-secret'
  process.env.POSTGRES_URL = 'postgres://localhost/test'
  process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----'

  // Mock global fetch for the GitHub OAuth token exchange in /invite/oauth/callback
  global.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ access_token: 'fake-access-token' }),
  } as unknown as Response)

  // Seed a developer user so the dashboard invite endpoint can authenticate
  testApiKey = newId()
  testUserId = newId()
  users.set(testUserId, {
    id: testUserId,
    api_key: testApiKey,
    installation_id: 'inst-test',
    github_user: 'testdev',
    repo: 'testdev/testrepo',
    created_at: new Date().toISOString(),
  })

  // Dynamic import so env vars are set before module-level code runs
  const mod = await import('../index.js')
  app = (mod as unknown as { default: Express }).default
})

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('Designer invite flow', () => {
  let inviteCode: string

  it('step 1 — POST /dashboard/invite creates an invite code', async () => {
    const res = await supertest(app)
      .post('/dashboard/invite')
      .set('Cookie', `gh_session=${encodeURIComponent(testApiKey)}`)

    // The route now returns JSON with the invite URL
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('code')
    expect(res.body).toHaveProperty('url')
    expect(res.body.url).toContain('/invite?code=')

    inviteCode = res.body.code as string
  })

  it('step 2 — GET /invite?code=<token> returns HTML with GitHub OAuth sign-in link', async () => {
    const res = await supertest(app).get(`/invite?code=${inviteCode}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/html/)

    // The page must contain the GitHub OAuth sign-in link, not a name form
    expect(res.text).toContain('Sign in with GitHub')
    expect(res.text).toContain('github.com/login/oauth/authorize')
    expect(res.text).not.toContain('name="name"')
    // Inviter's handle and repo should appear
    expect(res.text).toContain('testdev')
    expect(res.text).toContain('testdev/testrepo')
  })

  it('step 3 — GET /invite/oauth/callback creates a designer session and redirects to /designer', async () => {
    const res = await supertest(app)
      .get(`/invite/oauth/callback?code=gh-oauth-code&state=${inviteCode}`)

    // Callback redirects to /designer after creating the session
    expect(res.status).toBe(302)
    expect(res.headers['location']).toBe('/designer')

    // The invite should now be marked used
    const invite = inviteCodes.get(inviteCode)
    expect(invite!['used']).toBe(true)

    // A designer session must exist in the DB (github_user comes from mocked getAuthUser → 'alice')
    const session = [...sessions.values()].find((s) => s['github_user'] === 'alice')
    expect(session).toBeDefined()
    expect(session!['user_id']).toBe(testUserId)
    expect(typeof session!['token']).toBe('string')
  })

  it('step 4 — GET /invite/oauth/callback sets a designer_session cookie', async () => {
    // Use a fresh invite code for this assertion
    const freshInvite = { code: newId(), user_id: testUserId, used: false, is_demo: false, created_at: new Date().toISOString() }
    inviteCodes.set(freshInvite.code, freshInvite)

    const res = await supertest(app)
      .get(`/invite/oauth/callback?code=gh-oauth-code-2&state=${freshInvite.code}`)

    expect(res.status).toBe(302)

    // A Set-Cookie header with designer_session must be present
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '')
    expect(cookieStr).toMatch(/designer_session=/)
  })
})
