// e2e/fixtures/fake-auth-server.ts — a minimal stand-in for Supabase Auth's
// wire contract: POST /auth/v1/signup, POST /auth/v1/token?grant_type=password,
// GET /auth/v1/user. Just enough of GoTrue's actual response shapes
// (the auth-js SDK's _sessionResponse/_userResponse helpers) for the real
// Supabase JS auth client (lib/db/client.ts's authClient) to drive
// e2e/auth.spec.ts with no live Supabase project — the same keyless-testing
// shape as lib/notify/email.ts's log transport (GAP-3).
//
// Binds port 0 and reads the assigned port back (ARCHITECTURE.md §9: a test
// fixture that listens never claims a fixed port).
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

type FakeUser = {
  id: string
  email: string
  password: string
}

type FakeSession = {
  userId: string
  expiresAt: number // unix seconds
}

export type FakeAuthServer = {
  url: string
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function userWireShape(user: FakeUser, withIdentity: boolean): Record<string, unknown> {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: '1970-01-01T00:00:00Z',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: withIdentity
      ? [{ identity_id: randomUUID(), id: user.id, user_id: user.id, provider: 'email' }]
      : [],
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
  }
}

export function startFakeAuthServer(): Promise<FakeAuthServer> {
  const usersByEmail = new Map<string, FakeUser>()
  const sessionsByToken = new Map<string, FakeSession>()
  const calls: Record<string, number> = { signup: 0, token: 0, user: 0 }

  function count(name: string): void {
    calls[name] = (calls[name] ?? 0) + 1
  }

  function issueSession(user: FakeUser): Record<string, unknown> {
    const accessToken = randomUUID()
    const refreshToken = randomUUID()
    const expiresIn = 3600
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn
    sessionsByToken.set(accessToken, { userId: user.id, expiresAt })
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: expiresAt,
      refresh_token: refreshToken,
    }
  }

  async function handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    count('signup')
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').toLowerCase()
    const password = String(body.password ?? '')

    const existing = usersByEmail.get(email)
    if (existing) {
      // GoTrue's own anti-enumeration shape: the existing user, no session,
      // no identities — never an explicit "already registered" error.
      sendJson(res, 200, userWireShape(existing, false))
      return
    }

    const user: FakeUser = { id: randomUUID(), email, password }
    usersByEmail.set(email, user)
    sendJson(res, 200, { ...issueSession(user), user: userWireShape(user, true) })
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    count('token')
    if (url.searchParams.get('grant_type') !== 'password') {
      sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'unsupported grant type' })
      return
    }
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').toLowerCase()
    const password = String(body.password ?? '')
    const user = usersByEmail.get(email)

    if (!user || user.password !== password) {
      // One identical shape for "no such account" and "wrong password" (§6)
      // — the fake server never distinguishes them either.
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
        msg: 'Invalid login credentials',
        error_code: 'invalid_credentials',
      })
      return
    }

    sendJson(res, 200, { ...issueSession(user), user: userWireShape(user, true) })
  }

  function handleGetUser(req: IncomingMessage, res: ServerResponse): void {
    count('user')
    const authHeader = req.headers.authorization
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    const session = token ? sessionsByToken.get(token) : undefined

    if (!session || session.expiresAt < Math.floor(Date.now() / 1000)) {
      sendJson(res, 401, { msg: 'invalid or expired token', error_code: 'session_not_found' })
      return
    }
    const user = [...usersByEmail.values()].find((candidate) => candidate.id === session.userId)
    if (!user) {
      sendJson(res, 404, { msg: 'user not found' })
      return
    }
    sendJson(res, 200, userWireShape(user, true))
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-auth-server.local')

    if (req.method === 'GET' && url.pathname === '/__test__/calls') {
      sendJson(res, 200, calls)
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/signup') {
      void handleSignup(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      void handleToken(req, res, url)
      return
    }
    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      handleGetUser(req, res)
      return
    }
    sendJson(res, 404, { error: 'not_found', message: 'no fake handler for this path' })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('fake-auth-server: could not determine the assigned port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          }),
      })
    })
  })
}
