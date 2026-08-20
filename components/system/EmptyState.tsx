export function EmptyState({ message, testId }: { message: string; testId?: string }) {
  return <p data-testid={testId}>{message}</p>
}
