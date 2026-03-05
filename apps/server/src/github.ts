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

export async function getAuthUser(token: string): Promise<{ login: string; name: string | null; avatar_url: string }> {
  return ghFetch<{ login: string; name: string | null; avatar_url: string }>('https://api.github.com/user', token)
}

export async function getSuggestedDesigners(params: {
  owner: string
  repo: string
  token: string
}): Promise<Array<{ login: string; issueNumbers: number[] }>> {
  const { owner, repo, token } = params

  const [issues, contributors] = await Promise.all([
    ghFetch<Issue[]>(
      `https://api.github.com/repos/${owner}/${repo}/issues?labels=designer-input&state=all&per_page=5&sort=updated`,
      token
    ).catch(() => [] as Issue[]),
    ghFetch<Array<{ login?: string }>>(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`,
      token
    ).catch(() => [] as Array<{ login?: string }>),
  ])

  const contributorSet = new Set(
    contributors.flatMap(c => (c.login ? [c.login.toLowerCase()] : []))
  )

  const candidates = new Map<string, { login: string; issueNumbers: number[] }>()

  function addCandidate(login: string, issueNumber: number) {
    if (login.toLowerCase().endsWith('[bot]')) return
    const key = login.toLowerCase()
    if (contributorSet.has(key)) return
    const existing = candidates.get(key)
    if (existing) {
      if (!existing.issueNumbers.includes(issueNumber)) existing.issueNumbers.push(issueNumber)
    } else {
      candidates.set(key, { login, issueNumbers: [issueNumber] })
    }
  }

  for (const issue of issues) {
    if (issue.user) addCandidate(issue.user.login, issue.number)
  }

  const commentResults = await Promise.allSettled(
    issues.map(issue =>
      listIssueComments({ owner, repo, issueNumber: issue.number, token })
        .then(comments => ({ issueNumber: issue.number, comments }))
    )
  )

  for (const result of commentResults) {
    if (result.status !== 'fulfilled') continue
    const { issueNumber, comments } = result.value
    for (const comment of comments) {
      if (comment.user) addCandidate(comment.user.login, issueNumber)
    }
  }

  return Array.from(candidates.values()).slice(0, 10)
}

export interface RepoInfo {
  full_name: string
  description: string | null
  owner: {
    login: string
    avatar_url: string
  }
}

export async function getRepo(params: {
  owner: string
  repo: string
  token: string
}): Promise<RepoInfo> {
  const { owner, repo, token } = params
  return ghFetch<RepoInfo>(`https://api.github.com/repos/${owner}/${repo}`, token)
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
