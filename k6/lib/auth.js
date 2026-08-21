import http from 'k6/http'
import { fail } from 'k6'

// Shared by imaging.js, slots.js and booking.js. Content-Type is included
// even for the GET-only callers — harmless there, and needed by booking.js's
// subsequent JSON POSTs.
export function authenticatedHeaders(baseUrl, email, password) {
  const response = http.post(`${baseUrl}/api/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { operation: 'setup_login' },
  })
  if (response.status !== 200) fail(`seeded patient login failed: ${response.status}`)
  const session = response.cookies.pip_session?.[0]?.value
  if (!session) fail('seeded patient login returned no session cookie')
  return { Cookie: `pip_session=${session}`, 'Content-Type': 'application/json' }
}
