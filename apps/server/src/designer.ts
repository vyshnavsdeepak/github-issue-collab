import { readFileSync } from 'fs'
import type { Request, Response } from 'express'
import * as db from './db.js'
import {
  getInstallationToken,
  listIssues,
  getIssue,
  listIssueComments,
  addComment,
} from './github.js'
import { put } from '@vercel/blob'

interface BriefData {
  open_questions: string[]
  decisions: string[]
  constraints: string[]
}

const briefCache = new Map<string, { data: BriefData; expiresAt: number }>()

async function generateIssueBrief(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
}): Promise<BriefData> {
  const cacheKey = `${params.owner}/${params.repo}#${params.issueNumber}`
  const cached = briefCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  const [issue, comments] = await Promise.all([
    getIssue(params),
    listIssueComments(params),
  ])

  const issueText = `Issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ''}`
  const commentsText = comments.map(c => `${c.user?.login ?? 'unknown'}: ${c.body}`).join('\n\n')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const prompt = `You are analyzing a GitHub issue thread to help a designer understand what input is needed.

${issueText}

Comments:
${commentsText}

Extract and return a JSON object with exactly these keys:
- open_questions: array of specific questions that still need designer input (max 5)
- decisions: array of design decisions already made that constrain the work (max 5)
- constraints: array of key requirements or constraints the designer must respect (max 5)

Return ONLY valid JSON, no other text.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${text}`)
  }

  const result = await response.json() as { content: Array<{ type: string; text: string }> }
  const text = result.content.find(c => c.type === 'text')?.text ?? ''

  let data: BriefData
  try {
    data = JSON.parse(text) as BriefData
  } catch {
    throw new Error(`Failed to parse brief JSON: ${text}`)
  }

  briefCache.set(cacheKey, { data, expiresAt: Date.now() + 60 * 60 * 1000 })
  return data
}

function loadPrivateKey(): string {
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8')
  }
  const key = process.env.GITHUB_PRIVATE_KEY ?? ''
  if (!key) throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set')
  return key.replace(/\\n/g, '\n')
}

function parseCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? ''
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v ?? '')
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function parseRolePrefix(text: string | null): { role?: string; text: string } {
  if (!text) return { text: '' }
  const match = text.match(/^\[(Developer|Designer)\]\s*/)
  if (match) return { role: match[1]!.toLowerCase(), text: text.slice(match[0].length) }
  return { text }
}

interface DesignerContext {
  session: db.DesignerSession
  ownerUser: db.User
  owner: string
  repo: string
  token: string
}

async function resolveDesignerContext(req: Request): Promise<DesignerContext | null> {
  const sessionToken = parseCookie(req, 'designer_session')
  if (!sessionToken) return null

  const session = await db.getDesignerSessionByToken(sessionToken)
  if (!session) return null

  await db.updateDesignerLastSeen(session.id)

  const ownerUser = await db.getUserById(session.user_id)
  if (!ownerUser?.repo) return null

  const parts = ownerUser.repo.split('/')
  if (parts.length < 2) return null
  const owner = parts[0]!
  const repo = parts[1]!

  const appId = process.env.GITHUB_APP_ID
  if (!appId) return null

  const privateKey = loadPrivateKey()
  const token = await getInstallationToken(ownerUser.installation_id, appId, privateKey)

  return { session, ownerUser, owner, repo, token }
}

function layout(title: string, body: string, handle: string, repo: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    a { text-decoration: underline; }
    a:hover { background: #000; color: #fff; }
    pre, code { font-family: monospace; }
    textarea { outline: none; resize: vertical; }
    input, textarea { font-family: monospace; }
  </style>
</head>
<body class="bg-white text-black font-mono">
  <header class="border-b-4 border-black px-6 py-4 flex items-center justify-between">
    <a href="/designer" class="font-bold text-xl no-underline hover:bg-transparent hover:text-black">github-issue-collab</a>
    <div class="flex items-center gap-4 text-sm">
      <span class="text-gray-500">${esc(handle)} / ${esc(repo)}</span>
      <span class="border-2 border-black px-2 py-0.5 text-xs">designer</span>
    </div>
  </header>
  ${body}
</body>
</html>`
}

export async function handleDesignerPortal(req: Request, res: Response): Promise<void> {
  let ctx: DesignerContext | null
  try {
    ctx = await resolveDesignerContext(req)
  } catch (err) {
    res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!ctx) {
    res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Access Required</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>* { border-radius: 0 !important; }</style></head>
<body class="bg-white text-black font-mono min-h-screen flex items-center justify-center">
<div class="border-4 border-black p-8 max-w-sm w-full text-center">
  <h2 class="font-bold text-xl mb-4">Access Required</h2>
  <p class="text-sm text-gray-600">You need a designer invite link to access this portal.</p>
</div></body></html>`)
    return
  }

  let issues
  try {
    const allIssues = await listIssues({ owner: ctx.owner, repo: ctx.repo, token: ctx.token, per_page: 50 })
    issues = allIssues.filter(i => i.labels.some(l => l.name === 'designer-input'))
  } catch (err) {
    res.status(502).send(`GitHub error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const issueRows = issues.length
    ? issues.map(issue => {
        const labelBadges = issue.labels.map(l =>
          `<span class="text-xs border border-gray-400 px-1">${esc(l.name)}</span>`
        ).join(' ')
        return `
        <tr class="border-t-2 border-black hover:bg-gray-50">
          <td class="p-3 border-r-2 border-black w-12">
            <a href="/designer/issue/${issue.number}" class="font-bold no-underline hover:bg-black hover:text-white px-1">#${issue.number}</a>
          </td>
          <td class="p-3 border-r-2 border-black">
            <a href="/designer/issue/${issue.number}" class="font-bold no-underline hover:bg-black hover:text-white">${esc(issue.title)}</a>
            <div class="mt-1 flex flex-wrap gap-1">${labelBadges}</div>
          </td>
          <td class="p-3 border-r-2 border-black text-xs text-gray-500 whitespace-nowrap">${esc(issue.user?.login ?? '—')}</td>
          <td class="p-3 text-xs text-gray-500 whitespace-nowrap">${timeAgo(issue.updated_at)}</td>
        </tr>`
      }).join('')
    : `<tr><td colspan="4" class="p-8 text-center text-gray-400 text-sm">No issues labeled <code>designer-input</code> found.</td></tr>`

  const body = `
  <section class="border-b-4 border-black px-6 py-8 bg-black text-white">
    <p class="text-xs uppercase tracking-widest mb-2 text-yellow-400">Designer Portal</p>
    <h2 class="font-bold text-3xl mb-1">${esc(ctx.owner)}/${esc(ctx.repo)}</h2>
    <p class="text-gray-400 text-sm">${issues.length} issue${issues.length === 1 ? '' : 's'} awaiting designer input</p>
  </section>

  <section class="px-6 py-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-lg">Issues needing your input</h3>
      <span class="text-xs text-gray-500 border-2 border-gray-300 px-2 py-0.5">designer-input label</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white w-12">#</th>
            <th class="text-left p-3 border-r-2 border-white">Title</th>
            <th class="text-left p-3 border-r-2 border-white w-28">Author</th>
            <th class="text-left p-3 w-28">Updated</th>
          </tr>
        </thead>
        <tbody>${issueRows}</tbody>
      </table>
    </div>
  </section>`

  res.send(layout('Designer Portal', body, ctx.session.github_user ?? 'designer', `${ctx.owner}/${ctx.repo}`))
}

export async function handleDesignerIssue(req: Request, res: Response): Promise<void> {
  let ctx: DesignerContext | null
  try {
    ctx = await resolveDesignerContext(req)
  } catch (err) {
    res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!ctx) {
    res.redirect('/designer')
    return
  }

  const issueNumber = Number(req.params['number'])
  if (!issueNumber) {
    res.status(400).send('Invalid issue number')
    return
  }

  let issue, comments
  try {
    ;[issue, comments] = await Promise.all([
      getIssue({ owner: ctx.owner, repo: ctx.repo, issueNumber, token: ctx.token }),
      listIssueComments({ owner: ctx.owner, repo: ctx.repo, issueNumber, token: ctx.token }),
    ])
  } catch (err) {
    res.status(502).send(`GitHub error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Check if designer is allowed to see this issue
  const hasLabel = issue.labels.some(l => l.name === 'designer-input')
  if (!hasLabel) {
    res.status(403).send('This issue is not labeled designer-input')
    return
  }

  const { text: issueBody, role: issueRole } = parseRolePrefix(issue.body)

  const roleBadge = (role?: string) => role
    ? `<span class="text-xs border px-1 ${role === 'designer' ? 'border-yellow-500 text-yellow-700' : 'border-blue-500 text-blue-700'}">${role}</span>`
    : ''

  const labelBadges = issue.labels.map(l =>
    `<span class="text-xs border border-gray-400 px-1">${esc(l.name)}</span>`
  ).join(' ')

  const commentItems = comments.map(c => {
    const { text, role } = parseRolePrefix(c.body)
    const isDecision = text.includes('## Decision')
    return `
    <div class="border-2 border-black p-4 ${isDecision ? 'bg-yellow-50' : ''}">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="font-bold text-sm">${esc(c.user?.login ?? '—')}</span>
          ${roleBadge(role)}
          ${isDecision ? '<span class="text-xs border border-yellow-500 text-yellow-700 px-1">decision</span>' : ''}
        </div>
        <span class="text-xs text-gray-500">${timeAgo(c.created_at)}</span>
      </div>
      <div class="text-sm whitespace-pre-wrap">${esc(text)}</div>
    </div>`
  }).join('')

  const successMsg = req.query['success']
    ? `<div class="border-2 border-green-600 bg-green-50 text-green-800 px-4 py-3 text-sm font-bold mb-4">✓ ${esc(req.query['success'] as string)}</div>`
    : ''

  const body = `
  <section class="border-b-4 border-black px-6 py-6 bg-black text-white">
    <a href="/designer" class="text-xs text-gray-400 hover:text-white no-underline mb-3 inline-block">← Back to issues</a>
    <div class="flex items-start gap-3">
      <span class="text-gray-500 text-xl mt-0.5">#${issue.number}</span>
      <div>
        <h2 class="font-bold text-2xl mb-2">${esc(issue.title)}</h2>
        <div class="flex flex-wrap gap-2">${labelBadges}</div>
      </div>
    </div>
  </section>

  <div class="px-6 py-6 border-b-4 border-black">
    <div class="flex items-center gap-2 mb-3">
      <span class="font-bold text-sm">${esc(issue.user?.login ?? '—')}</span>
      ${roleBadge(issueRole)}
      <span class="text-xs text-gray-500">${timeAgo(issue.created_at)}</span>
    </div>
    ${issueBody ? `<div class="text-sm whitespace-pre-wrap border-l-4 border-gray-300 pl-4">${esc(issueBody)}</div>` : '<p class="text-sm text-gray-400 italic">No description</p>'}
  </div>

  <div class="px-6 py-6 border-b-4 border-black">
    <h3 class="font-bold text-lg mb-4">${comments.length} Comment${comments.length === 1 ? '' : 's'}</h3>
    <div class="flex flex-col gap-3">
      ${comments.length ? commentItems : '<p class="text-sm text-gray-400">No comments yet. Be the first to respond!</p>'}
    </div>
  </div>

  <div id="brief-section" class="px-6 py-6 border-b-4 border-black bg-yellow-50">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold text-lg">AI Brief</h3>
      <span class="text-xs text-gray-500 border border-gray-400 px-2 py-0.5">synthesized from thread</span>
    </div>
    <div id="brief-loading" class="text-sm text-gray-500">Loading brief…</div>
    <div id="brief-content" class="hidden">
      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <p class="text-xs font-bold uppercase tracking-widest mb-2 text-red-700">Open Questions</p>
          <ul id="brief-questions" class="text-sm list-disc list-inside space-y-1 text-gray-800"></ul>
        </div>
        <div>
          <p class="text-xs font-bold uppercase tracking-widest mb-2 text-blue-700">Decisions Made</p>
          <ul id="brief-decisions" class="text-sm list-disc list-inside space-y-1 text-gray-800"></ul>
        </div>
        <div>
          <p class="text-xs font-bold uppercase tracking-widest mb-2 text-green-700">Constraints</p>
          <ul id="brief-constraints" class="text-sm list-disc list-inside space-y-1 text-gray-800"></ul>
        </div>
      </div>
    </div>
    <div id="brief-error" class="hidden text-sm text-red-600"></div>
    <script>
      (function() {
        fetch('/api/issues/${issueNumber}/brief', { method: 'POST' })
          .then(function(r) { return r.json() })
          .then(function(d) {
            document.getElementById('brief-loading').classList.add('hidden')
            if (d.error) {
              var el = document.getElementById('brief-error')
              el.textContent = 'Brief unavailable: ' + d.error
              el.classList.remove('hidden')
              return
            }
            function fill(id, items) {
              var ul = document.getElementById(id)
              ;(items || []).forEach(function(item) {
                var li = document.createElement('li')
                li.textContent = item
                ul.appendChild(li)
              })
            }
            fill('brief-questions', d.open_questions)
            fill('brief-decisions', d.decisions)
            fill('brief-constraints', d.constraints)
            document.getElementById('brief-content').classList.remove('hidden')
          })
          .catch(function(err) {
            document.getElementById('brief-loading').classList.add('hidden')
            var el = document.getElementById('brief-error')
            el.textContent = 'Brief unavailable: ' + err.message
            el.classList.remove('hidden')
          })
      })()
    </script>
  </div>

  <div class="px-6 py-6 border-b-4 border-black">
    <h3 class="font-bold text-lg mb-4">Add a Comment</h3>
    ${successMsg}
    <form method="POST" action="/designer/comment" enctype="multipart/form-data" class="flex flex-col gap-3 max-w-2xl">
      <input type="hidden" name="issue_number" value="${issueNumber}">
      <textarea name="body" rows="4" required placeholder="Share your design thoughts…"
        class="border-2 border-black px-3 py-2 text-sm w-full bg-white"></textarea>
      <div>
        <label class="text-xs uppercase tracking-widest block mb-1">Screenshots (optional, up to 5)</label>
        <input type="file" name="screenshots" multiple accept="image/*"
          class="text-sm border-2 border-black px-2 py-1 w-full bg-white cursor-pointer">
        <p class="text-xs text-gray-500 mt-1">Attach screenshots or mockups — they'll be embedded in the comment.</p>
      </div>
      <div class="flex gap-3">
        <button type="submit" class="bg-black text-white font-bold text-sm px-5 py-2 border-2 border-black hover:bg-white hover:text-black">
          Post Comment
        </button>
      </div>
    </form>
  </div>

  <div class="px-6 py-6">
    <h3 class="font-bold text-lg mb-1">Record a Decision</h3>
    <p class="text-xs text-gray-500 mb-4">Use this for formal design decisions that should be tracked.</p>
    <form method="POST" action="/designer/decision" class="flex flex-col gap-3 max-w-2xl">
      <input type="hidden" name="issue_number" value="${issueNumber}">
      <div>
        <label class="text-xs uppercase tracking-widest block mb-1">Decision <span class="text-red-500">*</span></label>
        <textarea name="decision" rows="2" required placeholder="The decision that was made…"
          class="border-2 border-black px-3 py-2 text-sm w-full bg-white"></textarea>
      </div>
      <div>
        <label class="text-xs uppercase tracking-widest block mb-1">Rationale (optional)</label>
        <textarea name="rationale" rows="2" placeholder="The reasoning behind this decision…"
          class="border-2 border-black px-3 py-2 text-sm w-full bg-white"></textarea>
      </div>
      <div>
        <button type="submit" class="font-bold text-sm px-5 py-2 border-2 border-black hover:bg-black hover:text-white">
          Record Decision
        </button>
      </div>
    </form>
  </div>`

  res.send(layout(`#${issueNumber} ${issue.title}`, body, ctx.session.github_user ?? 'designer', `${ctx.owner}/${ctx.repo}`))
}

async function uploadScreenshots(files: Express.Multer.File[]): Promise<string[]> {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token || files.length === 0) return []

  const urls: string[] = []
  for (const file of files) {
    try {
      const ext = file.originalname.split('.').pop() ?? 'png'
      const filename = `designer-screenshots/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { url } = await put(filename, file.buffer, {
        access: 'public',
        contentType: file.mimetype,
        token,
      })
      urls.push(url)
    } catch (err) {
      console.warn(`[designer] Failed to upload screenshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return urls
}

export async function handleDesignerComment(req: Request, res: Response): Promise<void> {
  let ctx: DesignerContext | null
  try {
    ctx = await resolveDesignerContext(req)
  } catch (err) {
    res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!ctx) {
    res.redirect('/designer')
    return
  }

  const body = req.body as Record<string, unknown>
  const issueNumber = Number(body['issue_number'])
  const commentBody = ((body['body'] as string | undefined) ?? '').trim()

  if (!issueNumber || !commentBody) {
    res.status(400).send('Missing issue_number or body')
    return
  }

  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  let imageMarkdown = ''
  if (files.length > 0) {
    const urls = await uploadScreenshots(files)
    if (urls.length > 0) {
      imageMarkdown = '\n\n' + urls.map((url, i) => `![Screenshot ${i + 1}](${url})`).join('\n')
    }
  }

  try {
    await addComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issueNumber,
      token: ctx.token,
      body: `[Designer] ${commentBody}${imageMarkdown}`,
    })
  } catch (err) {
    res.status(502).send(`GitHub error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  res.redirect(`/designer/issue/${issueNumber}?success=Comment+posted`)
}

export async function handleDesignerDecision(req: Request, res: Response): Promise<void> {
  let ctx: DesignerContext | null
  try {
    ctx = await resolveDesignerContext(req)
  } catch (err) {
    res.status(500).send(`Error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!ctx) {
    res.redirect('/designer')
    return
  }

  const body = req.body as Record<string, unknown>
  const issueNumber = Number(body['issue_number'])
  const decision = ((body['decision'] as string | undefined) ?? '').trim()
  const rationale = ((body['rationale'] as string | undefined) ?? '').trim()

  if (!issueNumber || !decision) {
    res.status(400).send('Missing issue_number or decision')
    return
  }

  let commentBody = `[Designer] ## Decision\n${decision}`
  if (rationale) commentBody += `\n\n**Rationale:** ${rationale}`

  try {
    await addComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issueNumber,
      token: ctx.token,
      body: commentBody,
    })
  } catch (err) {
    res.status(502).send(`GitHub error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  res.redirect(`/designer/issue/${issueNumber}?success=Decision+recorded`)
}

export async function handleIssueBrief(req: Request, res: Response): Promise<void> {
  let ctx: DesignerContext | null
  try {
    ctx = await resolveDesignerContext(req)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  if (!ctx) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const issueNumber = Number(req.params['id'])
  if (!issueNumber) {
    res.status(400).json({ error: 'Invalid issue number' })
    return
  }

  try {
    const brief = await generateIssueBrief({
      owner: ctx.owner,
      repo: ctx.repo,
      issueNumber,
      token: ctx.token,
    })
    res.json(brief)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
