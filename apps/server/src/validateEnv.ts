/**
 * Validates that all required environment variables are set at server startup.
 * Logs a clear, actionable error and exits with code 1 if any are missing.
 */

interface EnvVar {
  name: string
  description: string
}

// Always required
const REQUIRED: EnvVar[] = [
  { name: 'GITHUB_APP_ID', description: 'GitHub App ID (found in GitHub App settings)' },
  { name: 'GITHUB_APP_CLIENT_ID', description: 'GitHub App OAuth client ID' },
  { name: 'GITHUB_APP_CLIENT_SECRET', description: 'GitHub App OAuth client secret' },
  { name: 'POSTGRES_URL', description: 'Neon Postgres connection string' },
  // INVITE_BASE_URL is optional — auto-derived from VERCEL_URL on Vercel, or falls back to localhost
]

// Required unless GITHUB_PRIVATE_KEY_PATH is set
const PRIVATE_KEY_VARS = ['GITHUB_PRIVATE_KEY', 'GITHUB_PRIVATE_KEY_PATH']

export function validateEnv(): void {
  const missing: string[] = []

  for (const { name, description } of REQUIRED) {
    if (!process.env[name]) {
      missing.push(`  ${name}\n    → ${description}`)
    }
  }

  // At least one of GITHUB_PRIVATE_KEY / GITHUB_PRIVATE_KEY_PATH must be set
  const hasPrivateKey = PRIVATE_KEY_VARS.some((v) => process.env[v])
  if (!hasPrivateKey) {
    missing.push(
      `  GITHUB_PRIVATE_KEY  (or GITHUB_PRIVATE_KEY_PATH)\n    → GitHub App private key (.pem contents, or path to file)`
    )
  }

  if (missing.length === 0) return

  console.error('\n' + '='.repeat(72))
  console.error('ERROR: Missing required environment variables\n')
  console.error('The following variables must be set before the server can start:\n')
  for (const entry of missing) {
    console.error(entry)
  }
  console.error('\nWhere to set them:')
  console.error('  Vercel: Dashboard → Your Project → Settings → Environment Variables')
  console.error('  Local:  Add to apps/server/.env (never commit this file)')
  console.error('\nSee the README for full setup instructions.')
  console.error('='.repeat(72) + '\n')

  process.exit(1)
}
