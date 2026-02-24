import { readFileSync } from 'fs'
import type { Request, Response } from 'express'
import {
  runMigrations,
  createUser,
  getUserByInstallationId,
  updateUserGithubUser,
  updateUserRepo,
} from './db.js'
import { getAppInstallation, getInstallationRepos } from './github.js'

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

  const baseUrl = getBaseUrl(req)
  const apiKey = user.api_key

  res.send(setupPage({ apiKey, githubUser, baseUrl, installationId, repos }))
}

function setupPage(params: { apiKey: string; githubUser: string; baseUrl: string; installationId: string; repos: Array<{ full_name: string }> }): string {
  const { apiKey, githubUser, baseUrl, installationId, repos } = params
  const repoList = repos.map(r => r.full_name).join(', ') || 'owner/repo'
  const firstRepo = repos[0]?.full_name ?? 'owner/repo'
  const hostedConfig = JSON.stringify(
    {
      mcpServers: {
        'github-collab': {
          url: `${baseUrl}/mcp`,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2
  )
  const cliCommand = `claude mcp add github-collab \\\n  --transport http \\\n  --header "Authorization: Bearer ${apiKey}" \\\n  ${baseUrl}/mcp`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Setup — github-issue-collab</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { border-radius: 0 !important; box-shadow: none !important; transition: none !important; }
    a { text-decoration: underline; }
    a:hover { background: #000; color: #fff; }
    pre, code { font-family: monospace; }
  </style>
</head>
<body class="bg-white text-black font-mono">

  <header class="border-b-4 border-black px-6 py-5 flex items-baseline justify-between">
    <h1 class="font-bold text-2xl tracking-tight">github-issue-collab</h1>
    <span class="text-sm border-2 border-black px-2 py-0.5">setup</span>
  </header>

  <section class="border-b-4 border-black px-6 py-10 bg-black text-white">
    <p class="text-xs uppercase tracking-widest mb-3 text-green-400">✓ Connected</p>
    <h2 class="font-bold text-4xl mb-2">Welcome, ${githubUser}</h2>
    <p class="text-gray-400 text-sm">Your GitHub App is installed. Choose your setup path below.</p>
    <p class="text-gray-500 text-xs mt-2">Accessible repos: ${repoList}</p>
  </section>

  <div class="grid grid-cols-1 md:grid-cols-2 border-b-4 border-black">

    <!-- HOSTED PATH -->
    <div class="border-b-4 md:border-b-0 md:border-r-4 border-black p-6">
      <div class="font-bold text-xs uppercase tracking-widest text-green-600 mb-2">RECOMMENDED</div>
      <h3 class="font-bold text-2xl mb-4">Hosted Path</h3>
      <p class="text-sm mb-6">Zero local setup. Copy the MCP config below and paste it into your Claude settings. Done.</p>

      <p class="text-xs text-gray-500 mb-2">Option A — CLI command:</p>
      <div class="flex items-start gap-3 mb-4">
        <pre id="cli-cmd" class="bg-black text-white text-xs p-4 overflow-x-auto flex-1">${cliCommand}</pre>
        <button onclick="copyEl('cli-cmd', this)" class="bg-black text-white text-xs font-bold px-3 py-2 border-2 border-black hover:bg-white hover:text-black shrink-0">Copy</button>
      </div>

      <p class="text-xs text-gray-500 mb-2">Option B — JSON config for <code>claude_desktop_config.json</code>:</p>
      <div class="flex items-start gap-3 mb-4">
        <pre id="hosted-config" class="bg-black text-white text-xs p-4 overflow-x-auto flex-1">${hostedConfig.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <button onclick="copyEl('hosted-config', this)" class="bg-black text-white text-xs font-bold px-3 py-2 border-2 border-black hover:bg-white hover:text-black shrink-0">Copy</button>
      </div>

      <p class="text-xs text-gray-500">Your API key: <code class="bg-gray-100 px-1">${apiKey}</code></p>
    </div>

    <!-- LOCAL PATH -->
    <div class="p-6">
      <div class="font-bold text-xs uppercase tracking-widest text-gray-500 mb-2">POWER USER</div>
      <h3 class="font-bold text-2xl mb-4">Local Path</h3>
      <p class="text-sm mb-6">Run the server locally. Only 3 env vars needed instead of 8.</p>

      <p class="text-xs text-gray-500 mb-2">Create a <code>.env</code> file:</p>
      <pre class="bg-black text-white text-xs p-4 mb-4">COLLAB_KEY=${apiKey}
GITHUB_REPO=${firstRepo}
DEV_SECRET=change-me-to-something-random</pre>

      <p class="text-xs text-gray-500 mb-2">Then start the server:</p>
      <pre class="bg-black text-white text-xs p-4">npm run dev</pre>
    </div>

  </div>

  <footer class="px-6 py-5 border-t-2 border-black flex justify-between items-center text-xs">
    <a href="/">← Back to home</a>
    <span class="text-gray-500">installation_id: ${installationId}</span>
  </footer>

  <script>
function copyEl(id, btn) {
  navigator.clipboard.writeText(document.getElementById(id).textContent.trim())
    .then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy', 2000); });
}
  </script>

</body>
</html>`
}
