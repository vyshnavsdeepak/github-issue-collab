#!/usr/bin/env node
import 'dotenv/config'
import { randomUUID } from 'crypto'
import { Command } from 'commander'
import { createApp, createInviteCode, listActiveSessions } from '@github-issue-collab/mcp-server'

const program = new Command()
program.name('github-collab').description('GitHub Issue Collab — local MCP server CLI').version('0.0.1')

program
  .command('serve')
  .description('Start the local MCP server')
  .action(() => {
    const port = Number(process.env.PORT) || 3000
    const { startServer } = createApp()
    startServer(port)
    const devSecret = process.env.DEV_SECRET
    if (!devSecret) {
      console.warn('\n  WARNING: DEV_SECRET is not set. Set it in your .env file.')
    }
    console.log('\n  Add to Claude MCP config (claude_desktop_config.json):')
    console.log('  {')
    console.log('    "mcpServers": {')
    console.log('      "github-collab": {')
    console.log(`        "url": "http://localhost:${port}/mcp/developer",`)
    console.log(`        "headers": { "Authorization": "Bearer ${devSecret ?? '<DEV_SECRET>'}" }`)
    console.log('      }')
    console.log('    }')
    console.log('  }')
  })

program
  .command('invite')
  .description('Generate a one-time designer invite code')
  .action(() => {
    const code = randomUUID()
    createInviteCode(code)
    const port = Number(process.env.PORT) || 3000
    console.log(`\nInvite code: ${code}`)
    console.log(`Auth URL:    http://localhost:${port}/auth?invite=${code}`)
    console.log('\nShare this URL with your designer. It can only be used once.\n')
  })

program
  .command('status')
  .description('Show active sessions')
  .action(() => {
    const sessions = listActiveSessions()
    if (sessions.length === 0) {
      console.log('\nNo active sessions.\n')
      return
    }
    console.log(`\nActive sessions (${sessions.length}):\n`)
    for (const s of sessions) {
      const user = (s.github_user ?? 'unknown').padEnd(24)
      const role = s.role.padEnd(12)
      const seen = s.last_seen ? `last seen ${s.last_seen}` : `created ${s.created_at}`
      console.log(`  ${role} ${user} ${seen}`)
    }
    console.log()
  })

program
  .command('setup')
  .description('Print setup instructions')
  .action(() => {
    console.log(`
GITHUB-ISSUE-COLLAB SETUP
════════════════════════════════════════════════════════

STEP 1 — Create a GitHub App
  https://github.com/settings/apps/new
  - Permissions: Issues (Read & Write)
  - OAuth callback: http://localhost:3000/auth/callback

STEP 2 — Install the app on your repo
  Note the installation ID from the app's Installations page

STEP 3 — Create .env file:

  GITHUB_APP_ID=<your-app-id>
  GITHUB_APP_PRIVATE_KEY_PATH=./private-key.pem
  GITHUB_APP_INSTALLATION_ID=<installation-id>
  GITHUB_REPO=owner/repo
  GITHUB_APP_CLIENT_ID=<oauth-client-id>
  GITHUB_APP_CLIENT_SECRET=<oauth-client-secret>
  DEV_SECRET=<any-random-string>
  PORT=3000

STEP 4 — Start the server:
  npm run dev

STEP 5 — Add to Claude MCP config:
  {
    "mcpServers": {
      "github-collab": {
        "url": "http://localhost:3000/mcp/developer",
        "headers": { "Authorization": "Bearer <DEV_SECRET>" }
      }
    }
  }

STEP 6 — Generate a designer invite:
  tsx apps/cli/src/index.ts invite
`)
  })

program.parse()
