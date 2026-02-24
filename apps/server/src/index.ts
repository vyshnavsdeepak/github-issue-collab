import 'dotenv/config'
import { readFileSync } from 'fs'
import express from 'express'
import { z } from 'zod'
import { getInstallationToken } from './github'

const app = express()
app.use(express.json())

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

app.post('/token', async (req, res) => {
  const parsed = TokenRequest.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }

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
    console.log(`  POST /token  { installationId: "..." }`)
  })
}
