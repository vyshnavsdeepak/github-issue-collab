import express from 'express'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { requireDeveloper, requireSession, setupAuthRoutes } from './auth.js'
import { createMcpServer, type ServerContext } from './tools.js'
import * as db from './db.js'

export { createInviteCode, listActiveSessions } from './db.js'

function loadPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
  }
  const key = process.env.GITHUB_APP_PRIVATE_KEY ?? ''
  if (!key) throw new Error('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be set')
  return key.replace(/\\n/g, '\n')
}

function buildContext(port: number): ServerContext {
  const githubRepo = process.env.GITHUB_REPO
  if (!githubRepo) throw new Error('GITHUB_REPO is required (format: owner/repo)')
  const [owner, repo] = githubRepo.split('/')
  if (!owner || !repo) throw new Error('GITHUB_REPO must be in format owner/repo')

  // Power-user path: COLLAB_KEY fetches installation tokens from the hosted server
  if (process.env.COLLAB_KEY) {
    return { appId: '', privateKey: '', installationId: '', repo: { owner, repo }, db, port }
  }

  const appId = process.env.GITHUB_APP_ID
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID
  if (!appId) throw new Error('GITHUB_APP_ID is required (or set COLLAB_KEY)')
  if (!installationId) throw new Error('GITHUB_APP_INSTALLATION_ID is required (or set COLLAB_KEY)')
  return {
    appId,
    privateKey: loadPrivateKey(),
    installationId,
    repo: { owner, repo },
    db,
    port,
  }
}

export function createApp() {
  const app = express()
  app.use(express.json())

  app.use(express.static(join(process.cwd(), 'public')))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  setupAuthRoutes(app)

  const developerTransports = new Map<string, StreamableHTTPServerTransport>()
  const designerTransports = new Map<string, StreamableHTTPServerTransport>()

  function makeMcpHandlers(
    transports: Map<string, StreamableHTTPServerTransport>,
    role: 'developer' | 'designer'
  ) {
    return {
      async post(req: Request, res: Response): Promise<void> {
        const port = Number(process.env.PORT) || 3000
        let ctx: ServerContext
        try {
          ctx = buildContext(port)
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
          return
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined
        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, req.body)
          return
        }

        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => { transports.set(id, transport) },
        })
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId)
        }
        const server = createMcpServer(role, ctx)
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
      },

      async get(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        if (!sessionId || !transports.has(sessionId)) {
          res.status(400).json({ error: 'No active session. Start with POST.' })
          return
        }
        await transports.get(sessionId)!.handleRequest(req, res)
      },

      async del(req: Request, res: Response): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        if (sessionId) {
          const transport = transports.get(sessionId)
          if (transport) {
            await transport.close()
            transports.delete(sessionId)
          }
        }
        res.status(204).send()
      },
    }
  }

  const devHandlers = makeMcpHandlers(developerTransports, 'developer')
  const desHandlers = makeMcpHandlers(designerTransports, 'designer')

  app.post('/mcp/developer', requireDeveloper, (req, res) => {
    void devHandlers.post(req, res)
  })
  app.get('/mcp/developer', requireDeveloper, (req, res) => {
    void devHandlers.get(req, res)
  })
  app.delete('/mcp/developer', requireDeveloper, (req, res) => {
    void devHandlers.del(req, res)
  })

  app.post('/mcp/designer', requireSession, (req, res) => {
    void desHandlers.post(req, res)
  })
  app.get('/mcp/designer', requireSession, (req, res) => {
    void desHandlers.get(req, res)
  })
  app.delete('/mcp/designer', requireSession, (req, res) => {
    void desHandlers.del(req, res)
  })

  function startServer(port: number) {
    return app.listen(port, () => {
      console.log(`\ngithub-issue-collab MCP server on http://localhost:${port}`)
      console.log(`\n  Developer MCP:  http://localhost:${port}/mcp/developer`)
      console.log(`  Designer OAuth: http://localhost:${port}/auth`)
      console.log(`  Health:         http://localhost:${port}/health`)
      console.log(`\n  Authorization:  Bearer $DEV_SECRET`)
    })
  }

  return { app, startServer }
}
