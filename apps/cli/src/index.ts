#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as readline from 'readline'
import { Command } from 'commander'
import { listIssues, getIssue, listIssueComments } from '@github-issue-collab/github'

const CONFIG_DIR = join(homedir(), '.myapp')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface Config {
  installationId: string
  serverUrl: string
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    console.error('Not authenticated. Run: myapp auth')
    process.exit(1)
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
}

function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function fetchToken(config: Config): Promise<string> {
  const res = await fetch(`${config.serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: config.installationId }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token fetch failed (${res.status}): ${text}`)
  }
  const data = (await res.json()) as { token: string }
  return data.token
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const program = new Command()
program.name('myapp').description('GitHub issue reader').version('0.0.1')

program
  .command('auth')
  .description('Configure GitHub App installation ID')
  .action(async () => {
    const installationId = await prompt('GitHub App installation ID: ')
    if (!installationId) {
      console.error('Installation ID is required')
      process.exit(1)
    }
    const serverInput = await prompt('Server URL [http://localhost:3000]: ')
    const serverUrl = serverInput || 'http://localhost:3000'
    saveConfig({ installationId, serverUrl })
    console.log(`Saved to ${CONFIG_FILE}`)
    console.log(`Server: ${serverUrl}`)
  })

const issues = program.command('issues').description('Issue commands')

issues
  .command('list <owner> <repo>')
  .description('List issues')
  .option('--state <state>', 'open | closed | all', 'open')
  .action(async (owner: string, repo: string, opts: { state: 'open' | 'closed' | 'all' }) => {
    const config = loadConfig()
    let token: string
    try {
      token = await fetchToken(config)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    let result
    try {
      result = await listIssues({ owner, repo, token, state: opts.state })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    if (result.length === 0) {
      console.log(`No ${opts.state} issues found in ${owner}/${repo}`)
      return
    }

    console.log(`\n${owner}/${repo} — ${opts.state} issues (${result.length})\n`)
    for (const issue of result) {
      const labels = issue.labels.map((l) => l.name).join(', ')
      const labelStr = labels ? `  [${labels}]` : ''
      console.log(`  #${issue.number.toString().padEnd(5)} ${issue.title}${labelStr}`)
      console.log(`         ${issue.html_url}  (updated ${formatDate(issue.updated_at)})`)
    }
  })

issues
  .command('view <owner> <repo> <number>')
  .description('View a single issue with comments')
  .action(async (owner: string, repo: string, number: string) => {
    const config = loadConfig()
    let token: string
    try {
      token = await fetchToken(config)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const issueNumber = parseInt(number, 10)
    if (isNaN(issueNumber)) {
      console.error(`Invalid issue number: ${number}`)
      process.exit(1)
    }

    let issue, comments
    try {
      ;[issue, comments] = await Promise.all([
        getIssue({ owner, repo, issueNumber, token }),
        listIssueComments({ owner, repo, issueNumber, token }),
      ])
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const labels = issue.labels.map((l) => l.name).join(', ')
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`#${issue.number} ${issue.title}`)
    console.log(`${'─'.repeat(60)}`)
    console.log(`State:   ${issue.state}`)
    console.log(`Author:  ${issue.user?.login ?? 'unknown'}`)
    console.log(`Created: ${formatDate(issue.created_at)}`)
    if (labels) console.log(`Labels:  ${labels}`)
    console.log(`URL:     ${issue.html_url}`)

    if (issue.body) {
      console.log(`\n${issue.body}`)
    }

    if (comments.length > 0) {
      console.log(`\n${'─'.repeat(60)}`)
      console.log(`Comments (${comments.length})`)
      console.log(`${'─'.repeat(60)}`)
      for (const comment of comments) {
        console.log(`\n@${comment.user?.login ?? 'unknown'} — ${formatDate(comment.created_at)}`)
        console.log(comment.body)
      }
    }
    console.log()
  })

program.parse()
