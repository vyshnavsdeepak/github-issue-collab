import type { Request, Response, NextFunction, Express } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { Session } from './types.js'
import {
  getInviteCode,
  markInviteCodeUsed,
  createSession,
  getSessionByToken,
  updateLastSeen,
} from './db.js'
import { getAuthUser } from './github.js'

declare global {
  namespace Express {
    interface Request {
      session?: Session
    }
  }
}

export function requireDeveloper(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.DEV_SECRET
  const auth = req.headers.authorization
  if (!secret || !auth || auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const token = auth.slice(7)
  const session = getSessionByToken(token)
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session token' })
    return
  }
  updateLastSeen(session.id)
  req.session = session
  next()
}

export function setupAuthRoutes(app: Express): void {
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET

  app.get('/auth', (req: Request, res: Response) => {
    const invite = req.query['invite'] as string | undefined
    if (!invite) {
      res.status(400).send('Missing invite parameter')
      return
    }
    const inviteCode = getInviteCode(invite)
    if (!inviteCode || inviteCode.used) {
      res.status(400).send('Invalid or already used invite code')
      return
    }
    if (!clientId) {
      res.status(500).send('GITHUB_APP_CLIENT_ID not configured')
      return
    }
    const port = process.env.PORT ?? '3000'
    const redirectUri = `http://localhost:${port}/auth/callback`
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${invite}&scope=user:email`
    res.redirect(authUrl)
  })

  app.get('/auth/callback', async (req: Request, res: Response) => {
    const code = req.query['code'] as string | undefined
    const state = req.query['state'] as string | undefined
    if (!code || !state) {
      res.status(400).send('Missing code or state')
      return
    }
    if (!clientId || !clientSecret) {
      res.status(500).send('GitHub OAuth not configured — set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET')
      return
    }
    const inviteCode = getInviteCode(state)
    if (!inviteCode || inviteCode.used) {
      res.status(400).send('Invalid or already used invite code')
      return
    }
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      })
      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        res.status(400).send(`OAuth error: ${tokenData.error ?? 'unknown'}`)
        return
      }
      const user = await getAuthUser(tokenData.access_token)
      const sessionToken = uuidv4()
      createSession({
        id: uuidv4(),
        role: 'designer',
        token: sessionToken,
        github_user: user.login,
      })
      markInviteCodeUsed(state)
      const port = process.env.PORT ?? '3000'
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Auth Complete — GitHub Issue Collab</title>
  <style>
    * { border-radius: 0; box-shadow: none; }
    body { font-family: monospace; background: #fff; color: #000; max-width: 640px; margin: 60px auto; padding: 20px; border: 4px solid #000; }
    h1 { font-size: 2rem; margin: 0 0 1rem; border-bottom: 4px solid #000; padding-bottom: 0.5rem; }
    .token { background: #000; color: #fff; padding: 12px; word-break: break-all; font-size: 0.85rem; margin: 1rem 0; }
    p { margin: 0.5rem 0; }
    code { background: #f0f0f0; padding: 2px 4px; }
  </style>
</head>
<body>
  <h1>AUTH COMPLETE</h1>
  <p>Welcome, <strong>${user.login}</strong>.</p>
  <p>Your session token — add this to your MCP client config:</p>
  <div class="token">${sessionToken}</div>
  <p>MCP Server URL: <code>http://localhost:${port}/mcp/designer</code></p>
  <p>Set header: <code>Authorization: Bearer ${sessionToken}</code></p>
</body>
</html>`)
    } catch (err) {
      res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
