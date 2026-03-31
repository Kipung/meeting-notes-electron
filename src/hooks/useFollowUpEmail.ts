import { useState } from 'react'

const backend = window.backend

type ParsedSummaryView = {
  summaryText: string
  actionItems: string[]
  actionItemsNone: boolean
  hasActionSection: boolean
}

type UseFollowUpEmailOptions = {
  summary: string
  parsedSummary: ParsedSummaryView
  effectiveSummaryText: string
  studentName: string
}

/**
 * Builds the normalized summary body that is sent to the follow-up email generator.
 * Kept here so the hook is self-contained.
 */
function buildSummaryBody(summary: string, parsedSummary: ParsedSummaryView, effectiveSummaryText: string): string {
  if (!summary) return ''
  return [
    'Summary:',
    effectiveSummaryText || 'No summary content found.',
    '',
    'Action Items:',
    parsedSummary.actionItems.length > 0 ? parsedSummary.actionItems.map((item) => `- ${item}`).join('\n') : 'none.',
  ].join('\n')
}

export function useFollowUpEmail({ summary, parsedSummary, effectiveSummaryText, studentName }: UseFollowUpEmailOptions) {
  const [followUpEmail, setFollowUpEmail] = useState('')
  const [followUpInstructions, setFollowUpInstructions] = useState('')
  const [followUpGenerating, setFollowUpGenerating] = useState(false)
  const [followUpStatus, setFollowUpStatus] = useState('')

  const reset = () => {
    setFollowUpEmail('')
    setFollowUpStatus('')
    setFollowUpGenerating(false)
  }

  const onGenerateFollowUpEmail = async () => {
    if (!summary || followUpGenerating) return
    const normalizedSummaryBody = buildSummaryBody(summary, parsedSummary, effectiveSummaryText)
    setFollowUpGenerating(true)
    setFollowUpStatus('Generating follow-up email...')
    try {
      const res = await backend.generateFollowUpEmail({
        summary: normalizedSummaryBody,
        studentName: studentName.trim() || undefined,
        instructions: followUpInstructions,
      })
      if (res && res.ok) {
        setFollowUpEmail(res.text || '')
        setFollowUpStatus('')
      } else {
        setFollowUpStatus(res?.error || 'Failed to generate follow-up email.')
      }
    } catch (e) {
      console.error('generateFollowUpEmail failed', e)
      setFollowUpStatus('Failed to generate follow-up email.')
    } finally {
      setFollowUpGenerating(false)
    }
  }

  return {
    followUpEmail,
    setFollowUpEmail,
    followUpInstructions,
    setFollowUpInstructions,
    followUpGenerating,
    setFollowUpGenerating,
    followUpStatus,
    setFollowUpStatus,
    reset,
    onGenerateFollowUpEmail,
    buildSummaryBody,
  }
}
