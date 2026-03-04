#!/usr/bin/env tsx
/**
 * Dev-only script to generate a test invite URL for walking the designer onboarding flow.
 * Usage: npm run create-test-invite [-- --user <github_user>]
 *
 * Requires POSTGRES_URL in the environment (loaded from .env automatically).
 * Refused to run when NODE_ENV=production.
 */
import 'dotenv/config'
import { runMigrations, getUserByGithubUser, createInviteCode } from './db.js'
import { neon } from '@neondatabase/serverless'

const env = process.env.NODE_ENV ?? 'development'
if (env === 'production') {
  console.error('Error: create-test-invite must not run against production (NODE_ENV=production).')
  process.exit(1)
}

async function getFirstUser() {
  const url = process.env.POSTGRES_URL
  if (!url) throw new Error('POSTGRES_URL is not set')
  const db = neon(url)
  const rows = await db`SELECT * FROM users ORDER BY created_at ASC LIMIT 1`
  return rows[0] as { id: string; github_user: string | null } | undefined
}

async function main() {
  const args = process.argv.slice(2)
  const userFlagIdx = args.indexOf('--user')
  const githubUser = userFlagIdx !== -1 ? args[userFlagIdx + 1] : undefined

  await runMigrations()

  let userId: string
  let displayUser: string

  if (githubUser) {
    const user = await getUserByGithubUser(githubUser)
    if (!user) {
      console.error(`Error: No user found with github_user = "${githubUser}"`)
      process.exit(1)
    }
    userId = user.id
    displayUser = user.github_user ?? githubUser
  } else {
    const user = await getFirstUser()
    if (!user) {
      console.error('Error: No users in the database. Run the connect flow first.')
      process.exit(1)
    }
    userId = user.id
    displayUser = user.github_user ?? user.id
  }

  const invite = await createInviteCode(userId)

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
  const inviteUrl = `${baseUrl}/invite?code=${invite.code}`

  console.log(`\nTest invite created for developer: ${displayUser}`)
  console.log(`\nInvite URL:\n  ${inviteUrl}\n`)
  console.log('Open this URL in a browser to walk the designer onboarding flow.')
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('POSTGRES_URL is not set')) {
    console.error(`
Error: POSTGRES_URL is not set.

To fix this, add it to apps/server/.env.local:

  POSTGRES_URL=postgres://...

Where to get the value:
  • Neon dashboard → your project → Connection string
  • Or run: vercel env pull apps/server/.env.local
    (requires Vercel project access)

See apps/server/.env.example for all required variables.
`)
  } else {
    console.error('Failed:', msg)
  }
  process.exit(1)
})
