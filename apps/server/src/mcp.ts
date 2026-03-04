import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import * as db from './db.js'
import {
  getInstallationToken,
  listIssues,
  getIssue,
  listIssueComments,
  addComment,
  addLabel,
  removeLabel,
} from './github.js'

type Role = 'developer' | 'designer'

interface AuthContext {
  role: Role
  installationId: string
  repo: { owner: string; repo: string }
  userId: string
}

function loadPrivateKey(): string {
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8')
  }
  const key = process.env.GITHUB_PRIVATE_KEY ?? ''
  if (!key) throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set')
  return key.replace(/\\n/g, '\n')
}

function getBaseUrl(req: Request): string {
  const host = req.get('host') ?? 'localhost'
  const proto = process.env.VERCEL ? 'https' : req.protocol
  return `${proto}://${host}`
}

function getInviteBaseUrl(): string {
  if (process.env.INVITE_BASE_URL) return process.env.INVITE_BASE_URL
  if (process.env.COLLAB_URL) return process.env.COLLAB_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`

  const port = process.env.PORT ?? '3000'
  const fallback = `http://localhost:${port}`
  console.warn(
    `[warn] VERCEL_URL is not set — invite URLs will use ${fallback}. ` +
      `Set INVITE_BASE_URL or COLLAB_URL to override.`
  )
  return fallback
}

async function resolveAuth(req: Request): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)

  // Try developer (api_key)
  const user = await db.getUserByApiKey(token)
  if (user) {
    if (!user.repo) return null
    const [owner, repo] = user.repo.split('/')
    if (!owner || !repo) return null
    return { role: 'developer', installationId: user.installation_id, repo: { owner, repo }, userId: user.id }
  }

  // Try designer (session token)
  const session = await db.getDesignerSessionByToken(token)
  if (session) {
    await db.updateDesignerLastSeen(session.id)
    const ownerUser = await db.getUserById(session.user_id)
    if (!ownerUser?.repo) return null
    const [owner, repo] = ownerUser.repo.split('/')
    if (!owner || !repo) return null
    return { role: 'designer', installationId: ownerUser.installation_id, repo: { owner, repo }, userId: session.user_id }
  }

  return null
}

function getToolSchemas(role: Role) {
  const tools: object[] = [
    {
      name: 'list_issues',
      description: 'List GitHub issues. Designer role only sees issues labeled "designer-input".',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Filter by issue state',
          },
        },
      },
    },
    {
      name: 'get_issue',
      description: 'Get details and comments for a specific GitHub issue',
      inputSchema: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number' },
        },
        required: ['issue_number'],
      },
    },
    {
      name: 'add_comment',
      description: 'Add a comment to a GitHub issue. Your role prefix is added automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number' },
          body: { type: 'string', description: 'Comment text' },
        },
        required: ['issue_number', 'body'],
      },
    },
    {
      name: 'record_decision',
      description: 'Record a design or technical decision as a structured comment on an issue',
      inputSchema: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number' },
          decision: { type: 'string', description: 'The decision that was made' },
          rationale: { type: 'string', description: 'The reasoning behind the decision' },
        },
        required: ['issue_number', 'decision'],
      },
    },
    {
      name: 'get_collaboration_info',
      description: 'Get active designer sessions and pending invite codes',
      inputSchema: { type: 'object', properties: {} },
    },
  ]

  if (role === 'developer') {
    tools.push({
      name: 'label_issue',
      description: 'Add or remove a label on a GitHub issue (developer only)',
      inputSchema: {
        type: 'object',
        properties: {
          issue_number: { type: 'number', description: 'The issue number' },
          label: { type: 'string', description: 'Label name' },
          action: { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove the label' },
        },
        required: ['issue_number', 'label', 'action'],
      },
    })
    tools.push({
      name: 'create_invite',
      description: 'Create a new designer invite link (developer only)',
      inputSchema: { type: 'object', properties: {} },
    })
  }

  return tools
}

function parseRolePrefix(text: string | null): { role?: string; text: string } {
  if (!text) return { text: '' }
  const match = text.match(/^\[(Developer|Designer)\]\s*/)
  if (match) return { role: match[1]!.toLowerCase(), text: text.slice(match[0].length) }
  return { text }
}

async function callTool(
  ctx: AuthContext,
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const appId = process.env.GITHUB_APP_ID
  if (!appId) throw new Error('GITHUB_APP_ID not configured')
  const privateKey = loadPrivateKey()
  const token = await getInstallationToken(ctx.installationId, appId, privateKey)
  const { owner, repo } = ctx.repo

  switch (toolName) {
    case 'list_issues': {
      let issues = await listIssues({
        owner,
        repo,
        token,
        state: (args['state'] as 'open' | 'closed' | 'all') ?? 'open',
      })
      if (ctx.role === 'designer') {
        issues = issues.filter((i) => i.labels.some((l) => l.name === 'designer-input'))
      }
      return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] }
    }

    case 'get_issue': {
      const issueNumber = Number(args['issue_number'])
      const [issue, comments] = await Promise.all([
        getIssue({ owner, repo, issueNumber, token }),
        listIssueComments({ owner, repo, issueNumber, token }),
      ])
      const bodyParsed = parseRolePrefix(issue.body)
      const enriched = {
        ...issue,
        body_role: bodyParsed.role,
        body: bodyParsed.text,
        comments: comments.map((c) => {
          const parsed = parseRolePrefix(c.body)
          return { ...c, role: parsed.role, body: parsed.text }
        }),
      }
      return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] }
    }

    case 'add_comment': {
      const issueNumber = Number(args['issue_number'])
      const body = String(args['body'])
      const prefix = ctx.role === 'developer' ? '[Developer] ' : '[Designer] '
      const comment = await addComment({ owner, repo, issueNumber, token, body: `${prefix}${body}` })
      return { content: [{ type: 'text', text: `Comment added: ${comment.html_url}` }] }
    }

    case 'record_decision': {
      const issueNumber = Number(args['issue_number'])
      const decision = String(args['decision'])
      const rationale = args['rationale'] ? String(args['rationale']) : undefined
      const prefix = ctx.role === 'developer' ? '[Developer] ' : '[Designer] '
      let commentBody = `${prefix}## Decision\n${decision}`
      if (rationale) commentBody += `\n\n**Rationale:** ${rationale}`
      const comment = await addComment({ owner, repo, issueNumber, token, body: commentBody })
      return { content: [{ type: 'text', text: `Decision recorded: ${comment.html_url}` }] }
    }

    case 'get_collaboration_info': {
      const [sessions, pendingInvites] = await Promise.all([
        db.listSessionsForUser(ctx.userId),
        db.listPendingInvitesForUser(ctx.userId),
      ])
      const info = {
        hosted_mcp_url: `${baseUrl}/mcp`,
        active_sessions: sessions.map((s) => ({
          id: s.id,
          github_user: s.github_user,
          created_at: s.created_at,
          last_seen: s.last_seen,
        })),
        pending_invites: pendingInvites.map((i) => ({
          code: i.code,
          invite_url: `${getInviteBaseUrl()}/invite?code=${i.code}`,
          created_at: i.created_at,
        })),
      }
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
    }

    case 'create_invite': {
      if (ctx.role !== 'developer') {
        throw new Error('create_invite is only available to developers')
      }
      const invite = await db.createInviteCode(ctx.userId)
      const inviteUrl = `${getInviteBaseUrl()}/invite?code=${invite.code}`
      return { content: [{ type: 'text', text: JSON.stringify({ invite_url: inviteUrl, code: invite.code }, null, 2) }] }
    }

    case 'label_issue': {
      if (ctx.role !== 'developer') {
        throw new Error('label_issue is only available to developers')
      }
      const issueNumber = Number(args['issue_number'])
      const label = String(args['label'])
      const action = String(args['action']) as 'add' | 'remove'
      if (action === 'add') {
        await addLabel({ owner, repo, issueNumber, token, label })
        return { content: [{ type: 'text', text: `Label "${label}" added to issue #${issueNumber}` }] }
      } else {
        await removeLabel({ owner, repo, issueNumber, token, label })
        return { content: [{ type: 'text', text: `Label "${label}" removed from issue #${issueNumber}` }] }
      }
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

export async function handleMcp(req: Request, res: Response): Promise<void> {
  let authCtx: AuthContext | null
  try {
    authCtx = await resolveAuth(req)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  if (!authCtx) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = req.body as Record<string, unknown> | undefined
  if (!body || body['jsonrpc'] !== '2.0' || !body['method']) {
    res.status(400).json({ error: 'Invalid JSON-RPC request' })
    return
  }

  const method = body['method'] as string
  const id = body['id'] as string | number | null | undefined
  const params = (body['params'] ?? {}) as Record<string, unknown>

  // Notifications have no id — just acknowledge
  if (method.startsWith('notifications/')) {
    res.status(202).end()
    return
  }

  const sessionId = randomUUID()

  try {
    switch (method) {
      case 'initialize':
        res
          .header('Mcp-Session-Id', sessionId)
          .json({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: (params['protocolVersion'] as string) ?? '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'github-issue-collab', version: '1.0.0' },
            },
          })
        break

      case 'tools/list':
        res.json({ jsonrpc: '2.0', id, result: { tools: getToolSchemas(authCtx.role) } })
        break

      case 'tools/call': {
        const toolName = params['name'] as string
        const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>
        const baseUrl = getBaseUrl(req)
        const result = await callTool(authCtx, baseUrl, toolName, toolArgs)
        res.json({ jsonrpc: '2.0', id, result })
        break
      }

      case 'ping':
        res.json({ jsonrpc: '2.0', id, result: {} })
        break

      default:
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        })
    }
  } catch (err) {
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    })
  }
}

// Designer invite flow

export async function handleInvite(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string | undefined
  if (!code) {
    res.status(400).send('Missing code parameter')
    return
  }

  let inviteRecord: Awaited<ReturnType<typeof db.getInviteCode>>
  try {
    inviteRecord = await db.getInviteCode(code)
  } catch (err) {
    res.status(500).send(`DB error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!inviteRecord || inviteRecord.used) {
    res.status(400).send('Invalid or already used invite code')
    return
  }

  const ownerUser = await db.getUserById(inviteRecord.user_id)

  const inviterName = ownerUser?.github_user ?? 'a developer'
  const repoName = ownerUser?.repo ?? 'their repository'

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Designer Invite — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    pre, code { font-family: monospace; }
    input { outline: none; }
  </style>
</head>
<body class="bg-white text-black font-mono p-0">
  <header class="border-b-4 border-black px-6 py-5">
    <h1 class="font-bold text-2xl">github-issue-collab</h1>
  </header>
  <section class="border-b-4 border-black px-6 py-10 bg-black text-white">
    <p class="text-xs uppercase tracking-widest mb-3 text-yellow-400">Designer Invite</p>
    <h2 class="font-bold text-4xl mb-2">You've been invited</h2>
    <p class="text-gray-300 text-lg mt-2">
      <strong>${inviterName}</strong> has invited you to collaborate on <strong>${repoName}</strong>
    </p>
  </section>
  <section class="px-6 py-10">
    <p class="text-sm text-gray-600 mb-6">You'll get designer access — issues labeled <code class="bg-gray-100 px-1">designer-input</code> only.</p>
    <form method="POST" action="/invite/callback" class="flex flex-col gap-4 max-w-sm">
      <input type="hidden" name="code" value="${code}">
      <div>
        <label class="text-xs uppercase tracking-widest block mb-2">Your name or handle</label>
        <input type="text" name="name" required placeholder="e.g. alice" class="border-2 border-black px-3 py-2 text-sm w-full bg-white font-mono">
      </div>
      <button type="submit" class="bg-black text-white font-bold text-sm px-6 py-3 border-2 border-black hover:bg-white hover:text-black">
        Accept Invite →
      </button>
    </form>
  </section>
</body>
</html>`)
}

// Handles POST from the invite landing page form (no GitHub OAuth required)
export async function handleInviteCallback(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown> | undefined
  const code = body?.['code'] as string | undefined
  const name = ((body?.['name'] as string | undefined) ?? '').trim()

  if (!code || !name) {
    res.status(400).send('Missing code or name')
    return
  }

  let inviteRecord: Awaited<ReturnType<typeof db.getInviteCode>>
  try {
    inviteRecord = await db.getInviteCode(code)
  } catch (err) {
    res.status(500).send(`DB error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!inviteRecord || inviteRecord.used) {
    res.status(400).send('Invalid or already used invite code')
    return
  }

  try {
    const sessionToken = randomUUID()

    await db.createDesignerSession({
      userId: inviteRecord.user_id,
      token: sessionToken,
      githubUser: name,
    })
    await db.markInviteUsed(code)

    const maxAge = 90 * 24 * 60 * 60
    res.setHeader('Set-Cookie', `designer_session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`)
    res.redirect('/designer')
  } catch (err) {
    res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}
