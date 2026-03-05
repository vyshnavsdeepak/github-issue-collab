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
  resendInviteCode,
  isInviteExpired,
  revokeDesignerSession,
  recordInviteEvent,
  getFunnelForUser,
  type FunnelRow,
} from './db.js'
import { getAppInstallation, getInstallationRepos, getAuthUser, getInstallationToken, listIssues, getSuggestedDesigners } from './github.js'
import type { Issue } from './github.js'
import { errorPage } from './ui.js'

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
  return (
    process.env.INVITE_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  )
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

function timeUntilExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'no expiry'
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'expired'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
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
    res.status(400).send(errorPage({
      title: 'App installation not detected',
      message: 'The GitHub App installation ID is missing. This usually means the installation did not complete successfully.',
      hint: 'Try installing the GitHub App again. If the problem persists, contact support.',
      action: { label: 'Install GitHub App', href: '/connect' },
    }))
    return
  }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(500).send(errorPage({
      title: 'Server misconfiguration',
      message: 'The GITHUB_APP_ID environment variable is not set. This is a server configuration issue.',
      hint: 'Contact the site administrator to configure the GitHub App credentials.',
    }))
    return
  }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).send(errorPage({
      title: 'Server misconfiguration',
      message: 'The GitHub App private key is not configured correctly on this server.',
      hint: 'Contact the site administrator to set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH.',
    }))
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
    res.status(502).send(errorPage({
      title: 'Could not verify GitHub App installation',
      message: 'We were unable to communicate with GitHub to confirm your app installation. The installation may be incomplete or the app credentials may be incorrect.',
      hint: 'Check that the GitHub App is installed on your account and that the correct repositories are selected. Then try connecting again.',
      action: { label: 'Try again', href: '/connect' },
    }))
    return
  }

  const firstRepo = repos[0]?.full_name ?? null

  try {
    await runMigrations()
  } catch (err) {
    res.status(500).send(errorPage({
      title: 'Database error',
      message: 'We could not initialize the database. This is a server-side issue.',
      hint: 'Contact the site administrator. The database may need to be configured or repaired.',
    }))
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
    res.status(500).send(errorPage({
      title: 'Database error',
      message: 'We could not save your account information. Please try connecting again.',
      hint: 'If this keeps happening, contact the site administrator.',
      action: { label: 'Try again', href: '/connect' },
    }))
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
  let privateKey: string | null = null
  try { privateKey = loadPrivateKey() } catch { /* skip if key missing */ }

  let issues: Issue[] = []
  let installationRepos: Array<{ full_name: string }> = []
  if (appId && privateKey && user.installation_id) {
    try {
      installationRepos = await getInstallationRepos(user.installation_id, appId, privateKey)
    } catch { /* degrade gracefully */ }
    if (user.repo) {
      const [owner, repo] = user.repo.split('/')
      try {
        const token = await getInstallationToken(user.installation_id, appId, privateKey)
        issues = await listIssues({ owner, repo, token, state: 'open', per_page: 25 })
        issues = issues.filter(i => !(i as unknown as { pull_request?: unknown }).pull_request)
      } catch { /* non-fatal */ }
    }
  }

  const [sessions, invites, funnel] = await Promise.all([
    listSessionsForUser(user.id),
    listPendingInvitesForUser(user.id),
    getFunnelForUser(user.id),
  ])

  let suggestions: Array<{ login: string; issueNumbers: number[] }> = []
  if (user.repo && user.installation_id) {
    const [owner, repo] = user.repo.split('/')
    if (owner && repo) {
      try {
        const appId = process.env.GITHUB_APP_ID ?? ''
        let privateKey = ''
        try { privateKey = loadPrivateKey() } catch { /* skip suggestions if key unavailable */ }
        if (appId && privateKey) {
          const installToken = await getInstallationToken(user.installation_id, appId, privateKey)
          suggestions = await getSuggestedDesigners({ owner, repo, token: installToken })
        }
      } catch { /* suggestions are non-critical; ignore errors */ }
    }
  }

  const baseUrl = getBaseUrl(req)
  const mcpUrl = `${baseUrl}/mcp`
  const hostedConfig = JSON.stringify(
    { mcpServers: { 'github-collab': { url: mcpUrl, headers: { Authorization: `Bearer ${apiKey}` } } } },
    null, 2
  )
  const cliCommand = `claude mcp add github-collab \\\n  --transport http \\\n  --header "Authorization: Bearer ${apiKey}" \\\n  ${mcpUrl}`

  const check = (v: boolean) => v ? '<span class="text-green-600 font-bold">✓</span>' : '<span class="text-gray-300">—</span>'
  const funnelRows = funnel.length
    ? funnel.map((f: FunnelRow) => `
      <tr class="border-t-2 border-black">
        <td class="p-3 border-r-2 border-black font-mono text-xs text-gray-500">${f.invite_code.slice(0, 8)}…</td>
        <td class="p-3 border-r-2 border-black text-xs text-gray-500">${timeAgo(f.created_at)}</td>
        <td class="p-3 border-r-2 border-black text-center">${check(f.invite_generated)}</td>
        <td class="p-3 border-r-2 border-black text-center">${check(f.invite_opened)}</td>
        <td class="p-3 border-r-2 border-black text-center">${check(f.config_started)}</td>
        <td class="p-3 border-r-2 border-black text-center">${check(f.issue_viewed)}</td>
        <td class="p-3 border-r-2 border-black text-center">${check(f.comment_submitted)}</td>
        <td class="p-3 text-center text-xs ${f.time_to_comment ? 'font-bold' : 'text-gray-300'}">${f.time_to_comment ?? '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="p-4 text-sm text-gray-400 text-center">No invites yet — create one below</td></tr>`

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

  const issueRows = issues.length
    ? issues.map(issue => `
      <tr class="border-t-2 border-black">
        <td class="p-3 border-r-2 border-black text-xs text-gray-500 whitespace-nowrap">#${issue.number}</td>
        <td class="p-3 border-r-2 border-black">
          <a href="${esc(issue.html_url)}" target="_blank" rel="noopener" class="font-bold hover:bg-black hover:text-white">${esc(issue.title)}</a>
          ${issue.labels.length ? `<div class="mt-1">${issue.labels.map(labelBadge).join('')}</div>` : ''}
        </td>
        <td class="p-3 border-r-2 border-black text-xs text-gray-500 whitespace-nowrap">${esc(issue.user?.login ?? '—')}</td>
        <td class="p-3 text-xs text-gray-500 whitespace-nowrap">${timeAgo(issue.updated_at)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="p-4 text-sm text-gray-400 text-center">${user.repo ? 'No open issues' : 'No repo configured'}</td></tr>`

  const inviteRows = invites.length
    ? invites.map(i => {
        const url = `${getInviteBaseUrl()}/invite?code=${i.code}`
        const msgTemplate = `Hey [name], I'd love your input on some UI decisions. No GitHub account needed — just click this link: ${url}`
        const expired = isInviteExpired(i)
        const expiryLabel = timeUntilExpiry(i.expires_at)
        const expiryCell = expired
          ? `<span class="text-xs font-bold text-red-600">expired</span>`
          : `<span class="text-xs text-gray-500">expires in ${esc(expiryLabel)}</span>`
        const actionCell = i.is_demo
          ? `<span class="text-xs font-bold border-2 border-gray-400 px-2 py-0.5 text-gray-400">Demo — do not share</span>`
          : expired
            ? `<button onclick="resendInvite('${esc(i.code)}', this)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Resend</button>`
            : `<div class="flex gap-2 flex-wrap">
                <button onclick="copyEl('inv-${i.code}', this)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Copy URL</button>
                <button onclick="copyText('inv-msg-${i.code}', this)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Copy msg</button>
                <button onclick="resendInvite('${esc(i.code)}', this)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Resend</button>
               </div>`
        const recipientCell = i.recipient_label
          ? `<span class="text-xs">sent to <span class="font-bold">${esc(i.recipient_label)}</span>${!expired && !i.used ? ' — pending response' : ''}</span>`
          : `<span class="text-xs text-gray-400">—</span>`
        return `
      <tr class="border-t-2 border-black${i.is_demo ? ' opacity-50' : ''}${expired ? ' bg-red-50' : ''}">
        <td class="p-3 border-r-2 border-black font-mono text-xs text-gray-500">${i.code.slice(0, 8)}…</td>
        <td class="p-3 border-r-2 border-black">${recipientCell}</td>
        <td class="p-3 border-r-2 border-black">
          <span id="inv-${i.code}" class="font-mono text-xs${expired ? ' text-gray-400 line-through' : ''}">${esc(url)}</span>
          <span id="inv-msg-${i.code}" class="hidden">${esc(msgTemplate)}</span>
        </td>
        <td class="p-3 border-r-2 border-black text-xs">${expiryCell}</td>
        <td class="p-3">
          ${actionCell}
        </td>
      </tr>`
      }).join('')
    : `<tr><td colspan="5" class="p-4 text-sm text-gray-400 text-center">No pending invite links</td></tr>`

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
    <p class="text-gray-400 text-sm">${esc(user.repo ?? 'no repo configured')} &nbsp;·&nbsp; ${sessions.length} active designer${sessions.length === 1 ? '' : 's'} &nbsp;·&nbsp; ${invites.length} pending invite${invites.length === 1 ? '' : 's'} &nbsp;·&nbsp; ${issues.length} open issue${issues.length === 1 ? '' : 's'}</p>
  </section>

  <!-- FUNNEL -->
  <section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-4">Invite Funnel</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white w-28">Code</th>
            <th class="text-left p-3 border-r-2 border-white w-24">Created</th>
            <th class="text-center p-3 border-r-2 border-white">Generated</th>
            <th class="text-center p-3 border-r-2 border-white">Opened</th>
            <th class="text-center p-3 border-r-2 border-white">Config</th>
            <th class="text-center p-3 border-r-2 border-white">Issue Viewed</th>
            <th class="text-center p-3 border-r-2 border-white">Comment</th>
            <th class="text-center p-3">Time to Comment</th>
          </tr>
        </thead>
        <tbody>${funnelRows}</tbody>
      </table>
    </div>
  </section>

  <!-- DESIGNERS -->
  <section class="border-b-4 border-black px-6 py-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-lg">Active Designers</h3>
      <div class="flex flex-col items-end gap-2">
        <input id="recipient-label-input" type="text" placeholder="Recipient name (optional)" class="text-xs border-2 border-black px-2 py-1 font-mono w-48 focus:outline-none" maxlength="120">
        <input id="invite-note-input" type="text" placeholder="Optional note for the designer…" class="text-xs border-2 border-black px-2 py-1 font-mono w-64 bg-white">
        <button id="new-invite-btn" onclick="createInvite()" class="text-xs font-bold bg-black text-white border-2 border-black px-3 py-1.5 hover:bg-white hover:text-black">+ New Invite Link</button>
        <div id="invite-url-display" class="text-xs border-2 border-black p-3 max-w-lg hidden"></div>
      </div>
      <script>
        async function createInvite() {
          const btn = document.getElementById('new-invite-btn');
          const display = document.getElementById('invite-url-display');
          const labelInput = document.getElementById('recipient-label-input');
          const recipientLabel = labelInput ? labelInput.value.trim() : '';
          const noteInput = document.getElementById('invite-note-input');
          const note = noteInput ? noteInput.value.trim() : '';
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const res = await fetch('/dashboard/invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ recipient_label: recipientLabel || undefined, note: note || undefined }),
            });
            const data = await res.json();
            display.innerHTML =
              '<span class="font-mono break-all">' + data.url + '</span>' +
              '<div class="mt-2 flex gap-2 flex-wrap">' +
                '<button onclick="navigator.clipboard.writeText(document.getElementById(\'new-invite-url-text\').textContent)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Copy URL</button>' +
                '<button onclick="navigator.clipboard.writeText(document.getElementById(\'new-invite-msg-text\').textContent)" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Copy msg</button>' +
              '</div>' +
              '<p class="mt-2 text-xs text-gray-500 border-l-2 border-black pl-2 leading-relaxed" id="new-invite-msg-text">' + (data.message_template || '') + '</p>' +
              '<span id="new-invite-url-text" class="hidden">' + data.url + '</span>';
            display.classList.remove('hidden');
            await navigator.clipboard.writeText(data.url).catch(() => {});
            btn.textContent = '+ New Invite Link';
          } catch (e) {
            btn.textContent = 'Error';
          }
          btn.disabled = false;
          setTimeout(() => location.reload(), 5000);
        }
      </script>
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

  <!-- SUGGESTED INVITEES -->
  <section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-1">Suggested Invitees</h3>
    <p class="text-xs text-gray-500 mb-4">GitHub users who engaged with <code>designer-input</code> issues but have no commits to this repo</p>
    ${suggestions.length > 0 ? `
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white">GitHub Handle</th>
            <th class="text-left p-3 border-r-2 border-white">Issues</th>
            <th class="text-left p-3 w-28">Action</th>
          </tr>
        </thead>
        <tbody>
          ${suggestions.map(s => `
          <tr class="border-t-2 border-black">
            <td class="p-3 border-r-2 border-black font-bold">
              <a href="https://github.com/${esc(s.login)}" target="_blank" rel="noopener">@${esc(s.login)}</a>
            </td>
            <td class="p-3 border-r-2 border-black text-xs text-gray-500">
              ${s.issueNumbers.map(n => `<a href="https://github.com/${esc(user.repo ?? '')}/${n}" target="_blank" rel="noopener">#${n}</a>`).join(', ')}
            </td>
            <td class="p-3">
              <form method="POST" action="/dashboard/invite" class="inline">
                <button type="submit" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Invite →</button>
              </form>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<p class="text-sm text-gray-400">No suggestions yet — users who comment on or open <code>designer-input</code>-labeled issues without committing to the repo will appear here.</p>`}
  </section>

  <!-- INVITES -->
  <section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-4">Pending Invite Links</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white w-24">Code</th>
            <th class="text-left p-3 border-r-2 border-white w-40">Recipient</th>
            <th class="text-left p-3 border-r-2 border-white">Link</th>
            <th class="text-left p-3 border-r-2 border-white w-32">Expiry</th>
            <th class="text-left p-3 w-36">Actions</th>
          </tr>
        </thead>
        <tbody>${inviteRows}</tbody>
      </table>
    </div>
  </section>

  <!-- ISSUES -->
  <section class="border-b-4 border-black px-6 py-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-lg">Open Issues</h3>
      ${user.repo ? `<a href="https://github.com/${esc(user.repo)}/issues" target="_blank" rel="noopener" class="text-xs font-bold border-2 border-black px-3 py-1.5 hover:bg-black hover:text-white no-underline">View on GitHub →</a>` : ''}
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm border-2 border-black">
        <thead class="bg-black text-white">
          <tr>
            <th class="text-left p-3 border-r-2 border-white w-16">#</th>
            <th class="text-left p-3 border-r-2 border-white">Title / Labels</th>
            <th class="text-left p-3 border-r-2 border-white w-32">Author</th>
            <th class="text-left p-3 w-28">Updated</th>
          </tr>
        </thead>
        <tbody>${issueRows}</tbody>
      </table>
    </div>
  </section>

  <!-- REPOSITORIES -->
  ${installationRepos.length > 0 ? `<section class="border-b-4 border-black px-6 py-6">
    <h3 class="font-bold text-lg mb-4">Repositories</h3>
    <div class="border-2 border-black">
      ${installationRepos.map((r, i) => {
        const isActive = r.full_name === user.repo
        return `<div class="${i > 0 ? 'border-t-2 border-black ' : ''}flex items-center justify-between px-4 py-3 ${isActive ? 'bg-black text-white' : ''}">
          <span class="font-mono text-sm">${esc(r.full_name)}</span>
          <span class="text-xs ml-4 shrink-0">${isActive
            ? '<span class="border-2 border-white px-2 py-0.5">active</span>'
            : `<form method="POST" action="/dashboard/set-repo" class="inline"><input type="hidden" name="repo" value="${esc(r.full_name)}"><button type="submit" class="text-xs font-bold border-2 border-black px-2 py-0.5 hover:bg-black hover:text-white">Use this repo</button></form>`
          }</span>
        </div>`
      }).join('')}
    </div>
  </section>` : ''}

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
    .then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy URL', 2000); });
}
function copyText(id, btn) {
  navigator.clipboard.writeText(document.getElementById(id).textContent.trim())
    .then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy msg', 2000); });
}
async function resendInvite(code, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch('/dashboard/resend-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    await navigator.clipboard.writeText(data.message_template || data.url).catch(() => {});
    btn.textContent = 'Copied ✓';
  } catch (e) {
    btn.textContent = 'Error';
  }
  setTimeout(() => location.reload(), 2000);
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

  const body = req.body as Record<string, unknown>
  const recipientLabel = typeof body['recipient_label'] === 'string' ? body['recipient_label'] : undefined
  const note = typeof body['note'] === 'string' ? body['note'] : undefined

  const invite = await createInviteCode(user.id, false, undefined, recipientLabel, undefined, note)
  void recordInviteEvent(invite.code, 'invite_generated')
  const inviteUrl = `${getInviteBaseUrl()}/invite?code=${invite.code}`
  const messageTemplate = `Hey [name], I'd love your input on some UI decisions. No GitHub account needed — just click this link: ${inviteUrl}`
  res.json({ code: invite.code, url: inviteUrl, recipient_label: invite.recipient_label, message_template: messageTemplate })
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

export async function handleResendInvite(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  if (!apiKey) { res.status(401).send('Not authenticated'); return }

  const user = await getUserByApiKey(apiKey)
  if (!user) { res.status(401).send('Invalid session'); return }

  const body = req.body as Record<string, unknown>
  const oldCode = body['code'] as string | undefined
  if (!oldCode) { res.status(400).send('Missing code'); return }

  const newInvite = await resendInviteCode(oldCode, user.id)
  const inviteUrl = `${getInviteBaseUrl()}/invite?code=${newInvite.code}`
  const messageTemplate = `Hey [name], I'd love your input on some UI decisions. No GitHub account needed — just click this link: ${inviteUrl}`
  res.json({ code: newInvite.code, url: inviteUrl, message_template: messageTemplate })
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
  res.redirect('/dashboard')
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function labelBadge(label: { name: string; color: string }): string {
  const bg = `#${label.color}`
  // Perceived luminance to pick readable text color
  const r = parseInt(label.color.slice(0, 2), 16)
  const g = parseInt(label.color.slice(2, 4), 16)
  const b = parseInt(label.color.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  const fg = lum > 0.5 ? '#000' : '#fff'
  return `<span style="background:${esc(bg)};color:${fg};border:1px solid rgba(0,0,0,0.2)" class="inline-block text-xs px-1.5 py-0.5 font-mono font-bold mr-1">${esc(label.name)}</span>`
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
