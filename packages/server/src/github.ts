import { createSign } from 'crypto'

export { listIssues, getIssue, listIssueComments } from '../../github/src/index.js'
export type { Issue, IssueComment } from '../../github/src/index.js'

import type { IssueComment } from '../../github/src/index.js'

function createJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })
  ).toString('base64url')
  const data = `${header}.${payload}`
  const sign = createSign('RSA-SHA256')
  sign.update(data)
  return `${data}.${sign.sign(privateKey, 'base64url')}`
}

async function ghFetch<T>(url: string, token: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// Installation token cache (1hr TTL, refresh 5min before expiry)
let tokenCache: { token: string; expiresAt: number } | null = null

export async function getInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string
): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token
  }
  const jwt = createJWT(appId, privateKey)
  const data = await ghFetch<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' }
  )
  tokenCache = { token: data.token, expiresAt: Date.now() + 60 * 60 * 1000 }
  return data.token
}

export async function addComment(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
  body: string
}): Promise<IssueComment> {
  const { owner, repo, issueNumber, token, body } = params
  return ghFetch<IssueComment>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
      headers: { 'Content-Type': 'application/json' },
    }
  )
}

export async function addLabel(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
  label: string
}): Promise<void> {
  const { owner, repo, issueNumber, token, label } = params
  await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
      headers: { 'Content-Type': 'application/json' },
    }
  )
}

export async function removeLabel(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
  label: string
}): Promise<void> {
  const { owner, repo, issueNumber, token, label } = params
  await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    token,
    { method: 'DELETE' }
  )
}

export async function getAuthUser(token: string): Promise<{ login: string }> {
  return ghFetch<{ login: string }>('https://api.github.com/user', token)
}
