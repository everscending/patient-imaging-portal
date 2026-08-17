import { randomUUID } from 'node:crypto'

type TimedOperation = 'share.create' | 'booking.create'
type TimedOutcome = 'ok' | 'conflict' | 'error'

/** Emits PHI-free elapsed-time telemetry for the two persisted operations. */
export async function timed<T>(
  op: TimedOperation,
  fn: () => Promise<T>,
  outcomeOf: (result: T) => TimedOutcome,
): Promise<T> {
  const requestId = randomUUID()
  const startedAt = performance.now()
  let outcome: TimedOutcome = 'error'

  try {
    const result = await fn()
    outcome = outcomeOf(result)
    return result
  } catch (error) {
    outcome = 'error'
    throw error
  } finally {
    console.log(JSON.stringify({ op, ms: performance.now() - startedAt, outcome, requestId }))
  }
}
