import Anthropic from '@anthropic-ai/sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Role } from './types.js'
import type * as DbModule from './db.js'
import {
  getInstallationToken,
  listIssues,
  getIssue,
  listIssueComments,
  addComment,
  addLabel,
  removeLabel,
} from './github.js'

async function generateIssueSummary(issue: {
  title: string
  body: string
  comments: Array<{ role?: string; body: string; user?: { login: string } | null }>
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const thread = [
    `Issue: ${issue.title}`,
    `\n${issue.body || '(no description)'}`,
    ...issue.comments.map((c) => {
      const author = c.role ? `[${c.role}]` : (c.user?.login ?? 'unknown')
      return `\n---\n${author}: ${c.body}`
    }),
  ].join('\n')

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `You are helping a designer understand a GitHub issue. Read the thread below and write a plain-English summary (3–5 sentences) covering:
1. What decision is currently pending
2. What context or discussion led here
3. What specific input or feedback is needed from the designer

Be concrete and direct. Do not use bullet points.

---
${thread}`,
        },
      ],
    })
    const block = msg.content[0]
    return block && block.type === 'text' ? block.text : null
  } catch {
    return null
  }
}

export interface ServerContext {
  appId: string
  privateKey: string
  installationId: string
  repo: { owner: string; repo: string }
  db: typeof DbModule
  port: number
}

export function createMcpServer(role: Role, ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: 'github-issue-collab',
    version: '1.0.0',
  })

  async function getToken(): Promise<string> {
    return getInstallationToken(ctx.installationId, ctx.appId, ctx.privateKey)
  }

  function parseRolePrefix(text: string | null): { role?: string; text: string } {
    if (!text) return { text: '' }
    const match = text.match(/^\[(Developer|Designer)\]\s*/)
    if (match) return { role: match[1]!.toLowerCase(), text: text.slice(match[0].length) }
    return { text }
  }

  server.tool(
    'list_issues',
    'List GitHub issues. Designer role only sees issues labeled "designer-input".',
    { state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by issue state') },
    async ({ state }) => {
      const token = await getToken()
      let issues = await listIssues({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        token,
        state: state ?? 'open',
      })
      if (role === 'designer') {
        issues = issues.filter((i) => i.labels.some((l) => l.name === 'designer-input'))
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(issues, null, 2) }],
      }
    }
  )

  server.tool(
    'get_issue',
    'Get details and comments for a specific GitHub issue',
    { issue_number: z.number().int().positive().describe('The issue number') },
    async ({ issue_number }) => {
      const token = await getToken()
      const [issue, comments] = await Promise.all([
        getIssue({ owner: ctx.repo.owner, repo: ctx.repo.repo, issueNumber: issue_number, token }),
        listIssueComments({ owner: ctx.repo.owner, repo: ctx.repo.repo, issueNumber: issue_number, token }),
      ])
      const bodyParsed = parseRolePrefix(issue.body)
      const enrichedComments = comments.map((c) => {
        const parsed = parseRolePrefix(c.body)
        return { ...c, role: parsed.role, body: parsed.text }
      })
      const enriched = {
        ...issue,
        body_role: bodyParsed.role,
        body: bodyParsed.text,
        comments: enrichedComments,
      }

      const content: Array<{ type: 'text'; text: string }> = [
        { type: 'text' as const, text: JSON.stringify(enriched, null, 2) },
      ]

      const isDesignerInput = issue.labels.some((l: { name: string }) => l.name === 'designer-input')
      if (role === 'designer' && isDesignerInput) {
        const summary = await generateIssueSummary({
          title: issue.title,
          body: bodyParsed.text,
          comments: enrichedComments,
        })
        if (summary) {
          content.push({
            type: 'text' as const,
            text: `\n## AI Summary for Designer\n\n${summary}`,
          })
        }
      }

      return { content }
    }
  )

  server.tool(
    'add_comment',
    'Add a comment to a GitHub issue. Your role prefix is added automatically.',
    {
      issue_number: z.number().int().positive().describe('The issue number'),
      body: z.string().min(1).describe('Comment text'),
    },
    async ({ issue_number, body }) => {
      const token = await getToken()
      const prefix = role === 'developer' ? '[Developer] ' : '[Designer] '
      const comment = await addComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        issueNumber: issue_number,
        token,
        body: `${prefix}${body}`,
      })
      return {
        content: [{ type: 'text' as const, text: `Comment added: ${comment.html_url}` }],
      }
    }
  )

  server.tool(
    'record_decision',
    'Record a design or technical decision as a structured comment on an issue',
    {
      issue_number: z.number().int().positive().describe('The issue number'),
      decision: z.string().min(1).describe('The decision that was made'),
      rationale: z.string().optional().describe('The reasoning behind the decision'),
    },
    async ({ issue_number, decision, rationale }) => {
      const token = await getToken()
      const prefix = role === 'developer' ? '[Developer] ' : '[Designer] '
      let body = `${prefix}## Decision\n${decision}`
      if (rationale) body += `\n\n**Rationale:** ${rationale}`
      const comment = await addComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        issueNumber: issue_number,
        token,
        body,
      })
      return {
        content: [{ type: 'text' as const, text: `Decision recorded: ${comment.html_url}` }],
      }
    }
  )

  server.tool(
    'get_collaboration_info',
    'Get server info, active sessions, and pending designer invite codes',
    {},
    async () => {
      const sessions = ctx.db.listActiveSessions()
      const pendingInvites = ctx.db.listUnusedInviteCodes()
      const info = {
        server_url: `http://localhost:${ctx.port}`,
        developer_mcp_url: `http://localhost:${ctx.port}/mcp/developer`,
        designer_mcp_url: `http://localhost:${ctx.port}/mcp/designer`,
        designer_auth_url: `http://localhost:${ctx.port}/auth`,
        active_sessions: sessions.map((s) => ({
          id: s.id,
          role: s.role,
          github_user: s.github_user,
          created_at: s.created_at,
          last_seen: s.last_seen,
        })),
        pending_invites: pendingInvites.map((i) => ({
          code: i.code,
          created_at: i.created_at,
          auth_url: `http://localhost:${ctx.port}/auth?invite=${i.code}`,
        })),
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      }
    }
  )

  if (role === 'developer') {
    server.tool(
      'label_issue',
      'Add or remove a label on a GitHub issue (developer only)',
      {
        issue_number: z.number().int().positive().describe('The issue number'),
        label: z.string().min(1).describe('Label name'),
        action: z.enum(['add', 'remove']).describe('Whether to add or remove the label'),
      },
      async ({ issue_number, label, action }) => {
        const token = await getToken()
        if (action === 'add') {
          await addLabel({
            owner: ctx.repo.owner,
            repo: ctx.repo.repo,
            issueNumber: issue_number,
            token,
            label,
          })
          return {
            content: [{ type: 'text' as const, text: `Label "${label}" added to issue #${issue_number}` }],
          }
        } else {
          await removeLabel({
            owner: ctx.repo.owner,
            repo: ctx.repo.repo,
            issueNumber: issue_number,
            token,
            label,
          })
          return {
            content: [{ type: 'text' as const, text: `Label "${label}" removed from issue #${issue_number}` }],
          }
        }
      }
    )
  }

  return server
}
