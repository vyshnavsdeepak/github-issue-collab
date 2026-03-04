import 'dotenv/config'
import { validateEnv } from './validateEnv'
validateEnv()
import { readFileSync } from 'fs'
import { join } from 'path'
import express from 'express'
import { z } from 'zod'
import { getInstallationToken } from './github'
import { getUserByApiKey, runMigrations, countInviteCodes, getFirstUser, createInviteCode } from './db'
import { handleConnect, handleConnectCallback, handleDashboard, handleDashboardLogin, handleDashboardCallback, handleDashboardLogout, handleCreateInvite, handleResendInvite, handleRevokeSession, handleDashboardSetRepo } from './connect'
import { handleMcp, handleInvite, handleInviteOAuthCallback } from './mcp'
import multer from 'multer'
import { handleDesignerPortal, handleDesignerIssue, handleDesignerComment, handleDesignerDecision } from './designer'
import { handleWebhook } from './webhook'

const app = express()
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf
  },
}))
app.use(express.urlencoded({ extended: false }))
app.use(express.static(join(__dirname, '../public')))

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

function loadPrivateKey(): string {
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8')
  }
  const key = process.env.GITHUB_PRIVATE_KEY ?? ''
  if (!key) throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set')
  // Handle escaped newlines from .env files
  return key.replace(/\\n/g, '\n')
}

const TokenRequest = z.object({
  installationId: z.string().min(1),
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/webhook', (req, res) => {
  void handleWebhook(req, res)
})

app.get('/connect', (req, res) => {
  handleConnect(req, res)
})

app.get('/connect/callback', (req, res) => {
  void handleConnectCallback(req, res)
})

app.get('/dashboard', (req, res) => {
  void handleDashboard(req, res)
})

app.get('/dashboard/login', (req, res) => {
  handleDashboardLogin(req, res)
})

app.get('/dashboard/callback', (req, res) => {
  void handleDashboardCallback(req, res)
})

app.post('/dashboard/logout', (req, res) => {
  handleDashboardLogout(req, res)
})

app.post('/dashboard/invite', (req, res) => {
  void handleCreateInvite(req, res)
})

app.post('/dashboard/resend-invite', (req, res) => {
  void handleResendInvite(req, res)
})

app.post('/dashboard/revoke', (req, res) => {
  void handleRevokeSession(req, res)
})

app.post('/dashboard/set-repo', (req, res) => {
  void handleDashboardSetRepo(req, res)
})

app.get('/invite', (req, res) => {
  void handleInvite(req, res)
})

app.get('/invite/oauth/callback', (req, res) => {
  void handleInviteOAuthCallback(req, res)
})

app.get('/designer', (req, res) => {
  void handleDesignerPortal(req, res)
})

app.get('/designer/issue/:number', (req, res) => {
  void handleDesignerIssue(req, res)
})

app.post('/designer/comment', upload.array('screenshots', 5), (req, res) => {
  void handleDesignerComment(req, res)
})

app.post('/designer/decision', (req, res) => {
  void handleDesignerDecision(req, res)
})

app.post('/mcp', (req, res) => {
  void handleMcp(req, res)
})

app.post('/token', async (req, res) => {
  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(500).json({ error: 'GITHUB_APP_ID not configured' })
    return
  }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  // New path: Authorization: Bearer <api_key>
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7)
    try {
      const user = await getUserByApiKey(apiKey)
      if (!user) {
        res.status(401).json({ error: 'Invalid API key' })
        return
      }
      const token = await getInstallationToken(user.installation_id, appId, privateKey)
      res.json({ token })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  // Legacy path: { installationId } in body (backwards compat)
  const parsed = TokenRequest.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

  try {
    const token = await getInstallationToken(parsed.data.installationId, appId, privateKey)
    res.json({ token })
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

async function seedDemoInviteIfNeeded(): Promise<void> {
  if (!process.env.POSTGRES_URL) return
  try {
    await runMigrations()
    const count = await countInviteCodes()
    if (count > 0) return
    const user = await getFirstUser()
    if (!user) {
      console.log('[demo] Invites table is empty but no users found — complete the /connect flow first.')
      return
    }
    const invite = await createInviteCode(user.id, true)
    const baseUrl =
      process.env.INVITE_BASE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 3000}`)
    console.log(`[demo] Invites table was empty — created demo invite for ${user.github_user ?? user.id}:`)
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      console.log('[demo] Demo invite created — retrieve URL from your developer dashboard')
    } else {
      console.log(`[demo]   ${baseUrl}/invite?code=${invite.code}`)
    }
  } catch (err) {
    console.warn(`[demo] Could not seed demo invite: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Warn if invite base URL cannot be derived from environment
if (!process.env.INVITE_BASE_URL && !process.env.VERCEL_URL) {
  console.warn(
    'Warning: INVITE_BASE_URL and VERCEL_URL are not set. ' +
    'Invite links will fall back to http://localhost:3000. ' +
    'Set INVITE_BASE_URL (or deploy on Vercel) for correct invite URLs in production.'
  )
}

// Export for Vercel serverless
export default app

// Listen locally when not running on Vercel
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`)
    console.log(`  GET  /health`)
    console.log(`  GET  /connect`)
    console.log(`  GET  /connect/callback`)
    console.log(`  GET  /invite`)
    console.log(`  GET  /invite/oauth/callback`)
    console.log(`  POST /mcp   (hosted MCP)`)
    console.log(`  POST /token (installation token broker)`)
    console.log(`  POST /webhook (GitHub webhook — set GITHUB_WEBHOOK_SECRET)`)
    void seedDemoInviteIfNeeded()
  })
} else {
  // On Vercel cold start, attempt seeding in the background
  void seedDemoInviteIfNeeded()
}
