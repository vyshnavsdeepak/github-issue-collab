export type Role = 'developer' | 'designer'

export interface Session {
  id: string
  role: Role
  token: string
  github_user?: string
  created_at: string
  last_seen?: string
}

export interface InviteCode {
  code: string
  used: number
  created_at: string
}
