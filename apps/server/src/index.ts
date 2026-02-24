import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import express from 'express'
import { z } from 'zod'
import { getInstallationToken } from './github'
import { getUserByApiKey } from './db'
import { handleConnect, handleConnectCallback, handleDashboard, handleCreateInvite, handleRevokeSession } from './connect'
import { handleMcp, handleInvite, handleInviteCallback } from './mcp'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(join(__dirname, '../public')))

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

app.get('/connect', (req, res) => {
  handleConnect(req, res)
})

app.get('/connect/callback', (req, res) => {
  void handleConnectCallback(req, res)
})

app.get('/dashboard', (req, res) => {
  void handleDashboard(req, res)
})

app.post('/dashboard/invite', (req, res) => {
  void handleCreateInvite(req, res)
})

app.post('/dashboard/revoke', (req, res) => {
  void handleRevokeSession(req, res)
})

app.get('/invite', (req, res) => {
  void handleInvite(req, res)
})

app.post('/invite/callback', (req, res) => {
  void handleInviteCallback(req, res)
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
    console.log(`  POST /invite/callback`)
    console.log(`  POST /mcp   (hosted MCP)`)
    console.log(`  POST /token (installation token broker)`)
  })
}
