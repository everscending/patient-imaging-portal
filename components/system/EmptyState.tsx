export function EmptyState({ id, message, testId }: { id?: string; message: string; testId?: string }) {
  return <p data-testid={testId} id={id}>{message}</p>
}
