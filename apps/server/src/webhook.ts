import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import type { Request, Response } from 'express'
import { getUserByInstallationId, listSessionsForUser } from './db.js'
import { getInstallationToken, addComment } from './github.js'

function loadPrivateKey(): string {
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8')
  }
  const key = process.env.GITHUB_PRIVATE_KEY ?? ''
  if (!key) throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set')
  return key.replace(/\\n/g, '\n')
}

function verifySignature(secret: string, rawBody: Buffer, signature: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  if (expected.length !== signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

interface WebhookLabel { name: string }
interface WebhookIssue {
  number: number
  title: string
  html_url: string
  labels: WebhookLabel[]
}
interface WebhookComment { html_url: string }
interface WebhookPayload {
  action: string
  issue?: WebhookIssue
  comment?: WebhookComment
  sender: { login: string }
  repository: { full_name: string; owner: { login: string }; name: string }
  installation?: { id: number }
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (secret) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody
    if (!sig || !rawBody || !verifySignature(secret, rawBody, sig)) {
      res.status(401).send('Invalid signature')
      return
    }
  }

  const event = req.headers['x-github-event'] as string | undefined
  const payload = req.body as WebhookPayload

  if (
    !(event === 'issue_comment' && payload.action === 'created') &&
    !(event === 'issues' && payload.action === 'closed')
  ) {
    res.status(200).end()
    return
  }

  const issue = payload.issue
  if (!issue) {
    res.status(200).end()
    return
  }

  if (!issue.labels.some(l => l.name === 'designer-input')) {
    res.status(200).end()
    return
  }

  const installationId = payload.installation?.id?.toString()
  if (!installationId) {
    res.status(200).end()
    return
  }

  const appId = process.env.GITHUB_APP_ID
  if (!appId) {
    res.status(200).end()
    return
  }

  let user
  try {
    user = await getUserByInstallationId(installationId)
  } catch {
    res.status(200).end()
    return
  }

  if (!user?.repo) {
    res.status(200).end()
    return
  }

  const sessions = await listSessionsForUser(user.id)
  const designerHandles = sessions
    .map(s => s.github_user)
    .filter((h): h is string => Boolean(h))

  if (designerHandles.length === 0) {
    res.status(200).end()
    return
  }

  const sender = payload.sender.login
  const [owner, repo] = user.repo.split('/')
  if (!owner || !repo) {
    res.status(200).end()
    return
  }

  let token: string
  try {
    token = await getInstallationToken(installationId, appId, loadPrivateKey())
  } catch {
    res.status(200).end()
    return
  }

  const issueNumber = issue.number

  if (event === 'issue_comment' && payload.action === 'created') {
    const senderIsDesigner = designerHandles.some(
      h => h.toLowerCase() === sender.toLowerCase()
    )
    if (senderIsDesigner) {
      res.status(200).end()
      return
    }

    const mentions = designerHandles.map(h => `@${h}`).join(' ')
    const commentUrl = payload.comment?.html_url ?? issue.html_url
    const body = `${mentions} — the developer responded to your feedback on [#${issueNumber} ${issue.title}](${commentUrl}).`
    try {
      await addComment({ owner, repo, issueNumber, token, body })
    } catch {
      // best-effort
    }
  } else if (event === 'issues' && payload.action === 'closed') {
    const mentions = designerHandles.map(h => `@${h}`).join(' ')
    const body = `${mentions} — [#${issueNumber} ${issue.title}](${issue.html_url}) has been closed. Your feedback was reviewed and acted on.`
    try {
      await addComment({ owner, repo, issueNumber, token, body })
    } catch {
      // best-effort
    }
  }

  res.status(200).end()
}
