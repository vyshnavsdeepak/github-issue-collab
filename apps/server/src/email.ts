import { Resend } from 'resend'

export async function sendInviteEmail({
  to,
  inviteUrl,
  developerGithubUser,
}: {
  to: string
  inviteUrl: string
  developerGithubUser: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping invite email')
    return
  }

  const resend = new Resend(apiKey)

  const { error } = await resend.emails.send({
    from: 'github-issue-collab <noreply@github-issue-collab.dev>',
    to,
    subject: `${developerGithubUser} invited you to give design feedback`,
    html: `
<p>Hi,</p>
<p><strong>${developerGithubUser}</strong> has invited you to share design feedback on their GitHub project using <a href="https://github.com/vyshnavsdeepak/github-issue-collab">github-issue-collab</a>.</p>
<p>Designer input issues are open GitHub issues where developers specifically want visual, UX, or product feedback from non-technical collaborators like you.</p>
<p>Click the link below to get started:</p>
<p><a href="${inviteUrl}">${inviteUrl}</a></p>
<p style="color:#666;font-size:0.875em;">You received this email because ${developerGithubUser} entered your email address. If you did not expect this, you can ignore this message.</p>
`,
  })

  if (error) {
    throw new Error(`Failed to send invite email: ${error.message}`)
  }
}
