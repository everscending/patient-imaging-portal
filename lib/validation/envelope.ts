// The wire shape of every non-2xx response (ARCHITECTURE.md §6).
export type ErrorEnvelope = { error: string; message: string }

/** The only way a non-2xx body is produced (ARCHITECTURE.md §6). */
export function errorResponse(status: number, error: string, message: string): Response {
  const body: ErrorEnvelope = { error, message }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The centralized producer for a successful response with no representation. */
export function noContentResponse(): Response {
  return new Response(null, { status: 204 })
}
