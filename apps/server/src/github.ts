import { createSign } from 'crypto'

export interface Issue {
  number: number
  title: string
  state: string
  body: string | null
  html_url: string
  user: { login: string } | null
  created_at: string
  updated_at: string
  labels: Array<{ name: string; color: string }>
  comments: number
}

export interface IssueComment {
  id: number
  body: string
  user: { login: string } | null
  created_at: string
  html_url: string
}

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

export async function getInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string
): Promise<string> {
  const jwt = createJWT(appId, privateKey)
  const data = await ghFetch<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' }
  )
  return data.token
}

export async function listIssues(params: {
  owner: string
  repo: string
  token: string
  state?: 'open' | 'closed' | 'all'
  per_page?: number
}): Promise<Issue[]> {
  const { owner, repo, token, state = 'open', per_page = 30 } = params
  return ghFetch<Issue[]>(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${per_page}&sort=updated`,
    token
  )
}

export async function getIssue(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
}): Promise<Issue> {
  const { owner, repo, issueNumber, token } = params
  return ghFetch<Issue>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    token
  )
}

export async function listIssueComments(params: {
  owner: string
  repo: string
  issueNumber: number
  token: string
}): Promise<IssueComment[]> {
  const { owner, repo, issueNumber, token } = params
  return ghFetch<IssueComment[]>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    token
  )
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
    { method: 'POST', body: JSON.stringify({ body }), headers: { 'Content-Type': 'application/json' } }
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
    { method: 'POST', body: JSON.stringify({ labels: [label] }), headers: { 'Content-Type': 'application/json' } }
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

export async function getAppInstallation(installationId: string, appId: string, privateKey: string): Promise<{ account: { login: string } }> {
  const jwt = createJWT(appId, privateKey)
  return ghFetch<{ account: { login: string } }>(
    `https://api.github.com/app/installations/${installationId}`,
    jwt
  )
}

export async function getAuthUser(token: string): Promise<{ login: string }> {
  return ghFetch<{ login: string }>('https://api.github.com/user', token)
}

export async function listIssuesByLabel(params: {
  owner: string
  repo: string
  token: string
  label: string
}): Promise<Issue[]> {
  const { owner, repo, token, label } = params
  return ghFetch<Issue[]>(
    `https://api.github.com/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=1`,
    token
  )
}

export async function getInstallationRepos(
  installationId: string,
  appId: string,
  privateKey: string
): Promise<Array<{ full_name: string }>> {
  const token = await getInstallationToken(installationId, appId, privateKey)
  const data = await ghFetch<{ repositories: Array<{ full_name: string }> }>(
    `https://api.github.com/installation/repositories?per_page=100`,
    token
  )
  return data.repositories
}
