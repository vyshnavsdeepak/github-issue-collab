import { readFileSync } from 'fs'
import type { Request, Response } from 'express'
import { getUserByApiKey } from './db.js'
import { getInstallationToken, listIssues, addLabel } from './github.js'
import type { Issue } from './github.js'

const DESIGN_KEYWORDS = [
  'ui', 'design', 'visual', 'layout', 'color', 'colour', 'font',
  'icon', 'screenshot', 'figma', 'mockup', 'mock-up', 'ux',
  'style', 'theme', 'css', 'typography', 'spacing', 'padding',
  'margin', 'border', 'button', 'modal', 'tooltip', 'animation',
  'responsive', 'mobile', 'accessibility', 'a11y', 'contrast',
  'palette', 'branding', 'logo', 'wireframe',
]

export interface ScoredIssue {
  number: number
  title: string
  html_url: string
  body: string | null
  score: number
  matched_keywords: string[]
  labels: Array<{ name: string; color: string }>
  user: { login: string } | null
  updated_at: string
}

export function scoreIssue(issue: Issue): { score: number; matched_keywords: string[] } {
  const text = `${issue.title} ${issue.body ?? ''}`.toLowerCase()
  const matched = new Set<string>()
  for (const kw of DESIGN_KEYWORDS) {
    // Use word boundary matching: keyword must be surrounded by non-word chars
    const re = new RegExp(`(?<![a-z])${kw}(?![a-z])`, 'i')
    if (re.test(text)) {
      matched.add(kw)
    }
  }
  return { score: matched.size, matched_keywords: Array.from(matched) }
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

export async function handleDesignerInputCandidates(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  if (!apiKey) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const user = await getUserByApiKey(apiKey)
  if (!user) {
    res.status(401).json({ error: 'Invalid session' })
    return
  }

  if (!user.repo) {
    res.status(400).json({ error: 'No repo configured' })
    return
  }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(500).json({ error: 'GITHUB_APP_ID not configured' })
    return
  }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  const [owner, repo] = user.repo.split('/')

  let token: string
  try {
    token = await getInstallationToken(user.installation_id, appId, privateKey)
  } catch (err) {
    res.status(502).json({ error: `GitHub token error: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  let allIssues: Issue[]
  try {
    allIssues = await listIssues({ owner, repo, token, state: 'open', per_page: 100 })
    // Filter out pull requests
    allIssues = allIssues.filter(i => !(i as unknown as { pull_request?: unknown }).pull_request)
  } catch (err) {
    res.status(502).json({ error: `GitHub API error: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  // Exclude issues already labeled designer-input
  const candidates = allIssues.filter(i => !i.labels.some(l => l.name === 'designer-input'))

  // Score and rank
  const scored: ScoredIssue[] = candidates
    .map(issue => {
      const { score, matched_keywords } = scoreIssue(issue)
      return {
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
        body: issue.body,
        score,
        matched_keywords,
        labels: issue.labels,
        user: issue.user,
        updated_at: issue.updated_at,
      }
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)

  res.json({ candidates: scored, total_open: allIssues.length })
}

export async function handleLabelDesignerInput(req: Request, res: Response): Promise<void> {
  const apiKey = parseCookie(req, 'gh_session')
  if (!apiKey) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const user = await getUserByApiKey(apiKey)
  if (!user) {
    res.status(401).json({ error: 'Invalid session' })
    return
  }

  if (!user.repo) {
    res.status(400).json({ error: 'No repo configured' })
    return
  }

  const body = req.body as Record<string, unknown>
  const issueNumber = Number(body['issue_number'])
  if (!issueNumber) {
    res.status(400).json({ error: 'Missing issue_number' })
    return
  }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(500).json({ error: 'GITHUB_APP_ID not configured' })
    return
  }

  let privateKey: string
  try {
    privateKey = loadPrivateKey()
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    return
  }

  const [owner, repo] = user.repo.split('/')

  let token: string
  try {
    token = await getInstallationToken(user.installation_id, appId, privateKey)
  } catch (err) {
    res.status(502).json({ error: `GitHub token error: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  try {
    await addLabel({ owner, repo, issueNumber, token, label: 'designer-input' })
  } catch (err) {
    res.status(502).json({ error: `GitHub API error: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  res.json({ ok: true, issue_number: issueNumber })
}
