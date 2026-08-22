import type { ReactNode } from 'react'

// `action` renders as a sibling, never inside the message paragraph — specs
// pin the paragraph's exact text and aria-describedby id.
export function EmptyState({ id, message, testId, action }: { id?: string; message: string; testId?: string; action?: ReactNode }) {
  return (
    <>
      <p data-testid={testId} id={id}>{message}</p>
      {action}
    </>
  )
}
