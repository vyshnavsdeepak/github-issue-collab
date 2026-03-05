import { readFileSync } from 'fs'
import type { Request, Response } from 'express'
import {
  runMigrations,
  createUser,
  getUserByInstallationId,
  getUserByApiKey,
  getUserByGithubUser,
  updateUserGithubUser,
  updateUserRepo,
  listSessionsForUser,
  listPendingInvitesForUser,
  createInviteCode,
  revokeDesignerSession,
} from './db.js'
import { getAppInstallation, getInstallationRepos, getAuthUser } from './github.js'

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

function parseCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? ''
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v ?? '')
  }
}

export function handleConnect(_req: Request, res: Response): void {
  const slug = process.env.GITHUB_APP_SLUG ?? 'issue-collab-vyshnavsdeepak'
  res.redirect(`https://github.com/apps/${slug}/installations/new`)
}

export async function handleConnectCallback(req: Request, res: Response): Promise<void> {
  const installationId = req.query['installation_id'] as string | undefined

  if (!installationId) {
    res.status(400).send('Missing installation_id')
    return
  }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(500).send('GITHUB_APP_ID not configured')
    return
  }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err))
    return
  }

  let githubUser: string
  let repos: Array<{ full_name: string }> = []
  try {
    const [installation, repoList] = await Promise.all([
      getAppInstallation(installationId, appId, privateKey),
      getInstallationRepos(installationId, appId, privateKey),
    ])
    githubUser = installation.account.login
    repos = repoList
  } catch (err) {
    res.status(502).send(`GitHub API error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const firstRepo = repos[0]?.full_name ?? null

  try {
    await runMigrations()
  } catch (err) {
    res.status(500).send(`DB migration error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  let user
  try {
    user = await getUserByInstallationId(installationId)
    if (user) {
      if (user.github_user !== githubUser) {
        await updateUserGithubUser(user.id, githubUser)
        user = { ...user, github_user: githubUser }
      }
      if (!user.repo && firstRepo) {
        await updateUserRepo(user.id, firstRepo)
        user = { ...user, repo: firstRepo }
      }
    } else {
      user = await createUser({ installationId, githubUser, repo: firstRepo ?? undefined })
    }
  } catch (err) {
    res.status(500).send(`DB error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  res.redirect('/dashboard')
}

export async function handleDashboard(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')

  if (!apiKey) {
    res.send(loginPage())
    return
  }

  const user = await getUserByApiKey(apiKey)
  if (!user) {
    res.status(401).send(loginPage('Session invalid. Please sign in again.'))
    return
  }

  const appId = process.env.GITHUB_APP_ID
  let installationRepos: Array<{ full_name: string }> = []
  if (appId && user.installation_id) {
    try {
      const privateKey = loadPrivateKey()
      installationRepos = await getInstallationRepos(user.installation_id, appId, privateKey)
    } catch {
      // degrade gracefully — repos section will be hidden
    }
  }

  const switchedRepo = req.query['switched'] as string | undefined

  const [sessions, invites] = await Promise.all([
    listSessionsForUser(user.id),
    listPendingInvitesForUser(user.id),
  ])

  const baseUrl = getBaseUrl(req)
  const mcpUrl = `${baseUrl}/mcp`
  const hostedConfig = JSON.stringify(
    { mcpServers: { 'github-collab': { url: mcpUrl, headers: { Authorization: `Bearer ${apiKey}` } } } },
    null, 2
  )
  const cliCommand = `claude mcp add github-collab \\\n  --transport http \\\n  --header "Authorization: Bearer ${apiKey}" \\\n  ${mcpUrl}`

  const designerRows = sessions.length
    ? sessions.map(s => `
      <tr class="border-t-2 border-black">
        <td class="p-3 border-r-2 border-black font-bold">${esc(s.github_user ?? '—')}</td>
        <td class="p-3 border-r-2 border-black text-xs text-gray-500">${timeAgo(s.created_at)}</td>
        <td class="p-3 border-r-2 border-black text-xs ${s.last_seen ? '' : 'text-gray-400'}">${timeAgo(s.last_seen)}</td>
        <td class="p-3">
          <form method="POST" action="/dashboard/revoke" class="inline">
            <input type="hidden" name="session_id" value="${esc(s.id)}">
            <button type="submit" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Revoke</button>
          </form>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="p-4 text-sm text-gray-400 text-center">No active designers yet — create an invite link below</td></tr>`

  const inviteRows = invites.length
    ? invites.map(i => {
        const url = `${baseUrl}/invite?code=${i.code}`
        return `
      <tr class="border-t-2 border-black">
        <td class="p-3 border-r-2 border-black font-mono text-xs text-gray-500">${i.code.slice(0, 8)}…</td>
        <td class="p-3 border-r-2 border-black">
          <span id="inv-${i.code}" class="font-mono text-xs">${esc(url)}</span>
        </td>
        <td class="p-3 border-r-2 border-black text-xs text-gray-500">${timeAgo(i.created_at)}</td>
        <td class="p-3">
          <button onclick="copyEl('inv-${i.code}', this)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Copy</button>
        </td>
      </tr>`
      }).join('')
    : `<tr><td colspan="4" class="p-4 text-sm text-gray-400 text-center">No pending invite links</td></tr>`

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    a { text-decoration: underline; }
    a:hover { background: #000; color: #fff; }
    pre, code { font-family: monospace; }
  </style>
</head>
<body class="bg-white text-black font-mono">

  <header class="border-b-4 border-black px-6 py-4 flex items-center justify-between">
    <a href="/" class="font-bold text-xl no-underline hover:bg-transparent hover:text-black">github-issue-collab</a>
    <div class="flex items-center gap-4 text-sm">
      <span class="text-gray-500">${esc(user.github_user ?? '')} / ${esc(user.repo ?? 'no repo')}</span>
      <span class="border-2 border-black px-2 py-0.5 text-xs">dashboard</span>
      <form method="POST" action="/dashboard/logout" class="inline">
        <button type="submit" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Sign out</button>
      </form>
    </div>
  </header>

  <section class="border-b-4 border-black px-6 py-8 bg-black text-white">
    <p class="text-xs uppercase tracking-widest mb-2 text-green-400">✓ Live</p>
    <h2 class="font-bold text-3xl mb-1">${esc(user.github_user ?? 'Developer')}</h2>
    <p class="text-gray-400 text-sm">${esc(user.repo ?? 'no repo configured')} &nbsp;·&nbsp; ${sessions.length} active designer${sessions.length === 1 ? '' : 's'} &nbsp;·&nbsp; ${invites.length} pending invite${invites.length === 1 ? '' : 's'}</p>
  </section>

  ${switchedRepo ? `<div class="bg-green-100 border-b-4 border-green-600 px-6 py-3 flex items-center gap-3 text-sm font-bold text-green-900">
    <span>✓ Active repo switched to <code class="font-mono bg-green-200 px-1">${esc(switchedRepo)}</code> — all MCP tools now operate on this repo.</span>
  </div>` : ''}

  <!-- REPOSITORIES -->
  ${installationRepos.length > 0 ? `<section class="border-b-4 border-black px-6 py-6">
    <div class="flex items-center justify-between mb-1">
      <h3 class="font-bold text-lg">Repositories</h3>
      <span class="text-xs text-gray-500 uppercase tracking-widest">MCP tool context</span>
    </div>
    <p class="text-xs text-gray-500 mb-4">The active repo is where all MCP tools (list issues, add labels, etc.) operate. Switch by clicking "Use this repo".</p>
    <div class="border-2 border-black">
      ${installationRepos.map((r, i) => {
        const isActive = r.full_name === user.repo
        return `<div class="flex items-center justify-between px-4 py-3${i > 0 ? ' border-t-2 border-black' : ''}${isActive ? ' bg-black text-white' : ' hover:bg-gray-50'}">
          <div class="flex items-center gap-3 min-w-0">
            ${isActive ? '<span class="shrink-0 text-green-400 font-bold text-sm">▶</span>' : '<span class="shrink-0 text-gray-300 text-sm">○</span>'}
            <span class="font-mono text-sm truncate">${esc(r.full_name)}</span>
          </div>
          <div class="shrink-0 ml-4">
            ${isActive
              ? '<span class="inline-flex items-center gap-1 border-2 border-green-400 text-green-400 text-xs font-bold px-2 py-0.5 uppercase tracking-widest">✓ Active</span>'
              : `<form method="POST" action="/dashboard/set-repo" class="inline"><input type="hidden" name="repo" value="${esc(r.full_name)}"><button type="submit" class="text-xs font-bold border-2 border-black bg-white text-black px-3 py-0.5 hover:bg-black hover:text-white">Use this repo</button></form>`
            }
          </div>
        </div>`
      }).join('')}
    </div>
  </section>` : ''}

  <!-- DESIGNERS -->
  <section class="border-b-4 border-black px-6 py-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-lg">Active Designers</h3>
      <form method="POST" action="/dashboard/invite" class="inline">
        <button type="submit" class="text-xs font-bold bg-black text-white border-2 border-black px-3 py-1.5 hover:bg-white hover:text-black">+ New Invite Link</button>
      </form>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white">Handle</th>
            <th class="text-left p-3 border-r-2 border-white">Joined</th>
            <th class="text-left p-3 border-r-2 border-white">Last Active</th>
            <th class="text-left p-3">Action</th>
          </tr>
        </thead>
        <tbody>${designerRows}</tbody>
      </table>
    </div>
  </section>

  <!-- INVITES -->
  <section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-4">Pending Invite Links</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white w-24">Code</th>
            <th class="text-left p-3 border-r-2 border-white">Link</th>
            <th class="text-left p-3 border-r-2 border-white w-28">Created</th>
            <th class="text-left p-3 w-20">Copy</th>
          </tr>
        </thead>
        <tbody>${inviteRows}</tbody>
      </table>
    </div>
  </section>

  <!-- MCP CONFIG -->
  <section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-4">MCP Config</h3>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-0 border-2 border-black">
      <div class="border-b-2 md:border-b-0 md:border-r-2 border-black p-4">
        <p class="text-xs text-gray-500 uppercase tracking-widest mb-2">Option A — CLI</p>
        <div class="flex items-start gap-2">
          <pre id="cli-cmd" class="bg-black text-white text-xs p-3 overflow-x-auto flex-1">${esc(cliCommand)}</pre>
          <button onclick="copyEl('cli-cmd', this)" class="text-xs font-bold border-2 border-black px-2 py-1 hover:bg-black hover:text-white shrink-0">Copy</button>
        </div>
      </div>
      <div class="p-4">
        <p class="text-xs text-gray-500 uppercase tracking-widest mb-2">Option B — JSON</p>
        <div class="flex items-start gap-2">
          <pre id="json-config" class="bg-black text-white text-xs p-3 overflow-x-auto flex-1">${esc(hostedConfig)}</pre>
          <button onclick="copyEl('json-config', this)" class="text-xs font-bold border-2 border-black px-2 py-1 hover:bg-black hover:text-white shrink-0">Copy</button>
        </div>
      </div>
    </div>
  </section>

  <footer class="px-6 py-4 border-t-2 border-black flex justify-between items-center text-xs text-gray-500">
    <span>API key: <code class="bg-gray-100 px-1">${esc(apiKey)}</code></span>
    <a href="/">← Home</a>
  </footer>

  <script>
function copyEl(id, btn) {
  navigator.clipboard.writeText(document.getElementById(id).textContent.trim())
    .then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy', 2000); });
}
  </script>
</body>
</html>`)
}

export function handleDashboardLogin(req: Request, res: Response): void {
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  if (!clientId) {
    res.status(500).send('GITHUB_APP_CLIENT_ID not configured')
    return
  }
  const baseUrl = getBaseUrl(req)
  const redirectUri = `${baseUrl}/dashboard/callback`
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user%3Aemail`
  res.redirect(authUrl)
}

export async function handleDashboardCallback(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string | undefined
  if (!code) {
    res.status(400).send('Missing code')
    return
  }

  const clientId = process.env.GITHUB_APP_CLIENT_ID
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    res.status(500).send('GitHub OAuth credentials not configured')
    return
  }

  // Exchange code for access token
  let accessToken: string
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenData.access_token) {
      res.status(400).send(`OAuth error: ${tokenData.error ?? 'no access_token'}`)
      return
    }
    accessToken = tokenData.access_token
  } catch (err) {
    res.status(502).send(`Token exchange error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Get GitHub user login
  let login: string
  try {
    const ghUser = await getAuthUser(accessToken)
    login = ghUser.login
  } catch (err) {
    res.status(502).send(`GitHub user error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Look up developer in DB
  let user
  try {
    user = await getUserByGithubUser(login)
  } catch (err) {
    res.status(500).send(`DB error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!user) {
    res.redirect('/connect')
    return
  }

  const maxAge = 30 * 24 * 60 * 60
  res.setHeader('Set-Cookie', `gh_session=${encodeURIComponent(user.api_key)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`)
  res.redirect('/dashboard')
}

export function handleDashboardLogout(_req: Request, res: Response): void {
  res.setHeader('Set-Cookie', 'gh_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/')
  res.redirect('/')
}

export async function handleCreateInvite(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  if (!apiKey) { res.status(401).send('Not authenticated'); return }

  const user = await getUserByApiKey(apiKey)
  if (!user) { res.status(401).send('Invalid session'); return }

  await createInviteCode(user.id)
  res.redirect('/dashboard')
}

export async function handleRevokeSession(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  const body = req.body as Record<string, unknown>
  const sessionId = body['session_id'] as string | undefined

  if (!apiKey) { res.status(401).send('Not authenticated'); return }
  if (!sessionId) { res.status(400).send('Missing session_id'); return }

  const user = await getUserByApiKey(apiKey)
  if (!user) { res.status(401).send('Invalid session'); return }

  await revokeDesignerSession(sessionId)
  res.redirect('/dashboard')
}

export async function handleDashboardSetRepo(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  if (!apiKey) { res.status(401).send('Not authenticated'); return }

  const user = await getUserByApiKey(apiKey)
  if (!user) { res.status(401).send('Invalid session'); return }

  const body = req.body as Record<string, unknown>
  const repo = body['repo'] as string | undefined
  if (!repo) { res.status(400).send('Missing repo'); return }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) { res.status(500).send('GITHUB_APP_ID not configured'); return }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err))
    return
  }

  let repos: Array<{ full_name: string }>
  try {
    repos = await getInstallationRepos(user.installation_id, appId, privateKey)
  } catch (err) {
    res.status(502).send(`GitHub API error: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!repos.some(r => r.full_name === repo)) {
    res.status(403).send('Repo not accessible via this installation')
    return
  }

  await updateUserRepo(user.id, repo)
  res.redirect(`/dashboard?switched=${encodeURIComponent(repo)}`)
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    a { text-decoration: underline; }
    a:hover { background: #000; color: #fff; }
  </style>
</head>
<body class="bg-white text-black font-mono min-h-screen flex flex-col">
  <header class="border-b-4 border-black px-6 py-4">
    <a href="/" class="font-bold text-xl no-underline hover:bg-transparent hover:text-black">github-issue-collab</a>
  </header>
  <main class="flex-1 flex items-center justify-center px-6 py-12">
    <div class="w-full max-w-sm border-4 border-black">
      <div class="bg-black text-white px-6 py-5">
        <h2 class="font-bold text-xl">Developer Login</h2>
        <p class="text-gray-400 text-xs mt-1">Sign in with your GitHub account</p>
      </div>
      <div class="p-6">
        ${error ? `<p class="text-red-600 text-sm font-bold mb-4 border-2 border-red-600 px-3 py-2">${esc(error)}</p>` : ''}
        <a href="/dashboard/login" class="block bg-black text-white font-bold text-sm px-6 py-3 border-2 border-black hover:bg-white hover:text-black text-center no-underline">
          Sign in with GitHub →
        </a>
        <p class="text-xs text-gray-500 mt-6">
          Don't have access yet? <a href="/connect">Connect your GitHub repo →</a>
        </p>
      </div>
    </div>
  </main>
  <footer class="border-t-2 border-black px-6 py-4 text-xs text-gray-500">
    github-issue-collab
  </footer>
</body>
</html>`
}
