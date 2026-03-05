import Anthropic from '@anthropic-ai/sdk'
import { storeQualitySignal } from './db.js'

type QualitySignal = 'actionable' | 'needs_clarification' | 'vague'

async function analyzeComment(commentBody: string, issueTitle: string): Promise<QualitySignal> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content: `You are evaluating a designer's comment on a GitHub issue.

Issue title: "${issueTitle}"

Designer comment:
"${commentBody}"

Classify the comment quality as exactly one of:
- actionable: references specific details from the issue, addresses a concrete question, or proposes a specific change/decision
- needs_clarification: partially relevant but vague about specifics or next steps
- vague: generic, off-topic, or does not engage with the issue content

Respond with only one word: actionable, needs_clarification, or vague.`,
      },
    ],
  })

  const text = (message.content[0] as { type: string; text: string }).text.trim().toLowerCase()
  if (text === 'actionable' || text === 'needs_clarification' || text === 'vague') {
    return text as QualitySignal
  }
  return 'vague'
}

export function analyzeAndStoreQuality(params: {
  githubCommentId: number
  issueNumber: number
  commentBody: string
  issueTitle: string
}): void {
  analyzeComment(params.commentBody, params.issueTitle)
    .then(signal =>
      storeQualitySignal({
        githubCommentId: params.githubCommentId,
        issueNumber: params.issueNumber,
        qualitySignal: signal,
      })
    )
    .catch(err => {
      console.warn('[quality] analysis failed:', err instanceof Error ? err.message : String(err))
    })
}
