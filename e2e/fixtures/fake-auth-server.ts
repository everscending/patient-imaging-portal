// A minimal, in-memory stand-in for Supabase Auth's REST surface (GoTrue),
// used ONLY by e2e/fixtures/start-test-server.mjs when no real Supabase
// project is configured (ADR-0013 already does the equivalent for Postgres —
// a local harness instead of a dependency on reachable cloud infra for
// tests). It implements exactly the four endpoints supabase-js's `signUp`,
// `signInWithPassword`, `getUser` and `admin.updateUserById` call, with the
// real project's behavior this build assumes (email confirmations disabled,
// ADR-0012 #9): a duplicate signUp is a genuine error, not a silent
// zero-identities success.
//
// The admin endpoint exists so e2e/auth.spec.ts can simulate FR-2's
// account-to-patient link (a later ticket's job, no `/verify` flow yet) the
// same way it would for real: `serviceClient().auth.admin.updateUserById`,
// which behaves identically whether it lands here or on a real project.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'

type FakeUser = {
  id: string
  email: string
  password: string
  appMetadata: Record<string, unknown>
}

type FakeAuthServer = { url: string; close: () => Promise<void> }

function nowIso(): string {
  return new Date().toISOString()
}

function toGoTrueUser(user: FakeUser) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: nowIso(),
    phone: '',
    app_metadata: user.appMetadata,
    user_metadata: {},
    identities: [
      {
        id: user.id,
        user_id: user.id,
        identity_data: { email: user.email },
        provider: 'email',
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ],
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

function session(user: FakeUser, token: string) {
  const expiresIn = 3600
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    refresh_token: randomUUID(),
    user: toGoTrueUser(user),
  }
}

function authError(status: number, code: string, message: string) {
  return {
    status,
    body: { error: code, error_code: code, code, error_description: message, msg: message, message },
  }
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const usersByEmail = new Map<string, FakeUser>()
  const tokens = new Map<string, string>() // token -> email

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const send = (status: number, body: unknown) => {
        const json = JSON.stringify(body)
        response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
        response.end(json)
      }

      if (request.method === 'POST' && url.pathname === '/auth/v1/signup') {
        const body = await readJsonBody(request)
        const email = String(body.email ?? '').toLowerCase()
        const password = String(body.password ?? '')
        if (usersByEmail.has(email)) {
          const err = authError(422, 'user_already_exists', 'User already registered')
          send(err.status, err.body)
          return
        }
        const user: FakeUser = { id: randomUUID(), email, password, appMetadata: {} }
        usersByEmail.set(email, user)
        const token = randomUUID()
        tokens.set(token, email)
        send(200, session(user, token))
        return
      }

      if (request.method === 'POST' && url.pathname === '/auth/v1/token') {
        const body = await readJsonBody(request)
        const email = String(body.email ?? '').toLowerCase()
        const password = String(body.password ?? '')
        const user = usersByEmail.get(email)
        if (!user || user.password !== password) {
          const err = authError(400, 'invalid_credentials', 'Invalid login credentials')
          send(err.status, err.body)
          return
        }
        const token = randomUUID()
        tokens.set(token, email)
        send(200, session(user, token))
        return
      }

      if (request.method === 'GET' && url.pathname === '/auth/v1/user') {
        const authHeader = request.headers.authorization ?? ''
        const token = authHeader.replace(/^Bearer\s+/i, '')
        const email = tokens.get(token)
        const user = email ? usersByEmail.get(email) : undefined
        if (!user) {
          const err = authError(401, 'invalid_token', 'invalid JWT')
          send(err.status, err.body)
          return
        }
        send(200, toGoTrueUser(user))
        return
      }

      const adminUserMatch = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'PUT' && adminUserMatch) {
        const userId = adminUserMatch[1]
        const body = await readJsonBody(request)
        const user = [...usersByEmail.values()].find((candidate) => candidate.id === userId)
        if (!user) {
          send(404, { error: 'not_found', msg: 'User not found' })
          return
        }
        const appMetadata = body.app_metadata
        if (appMetadata && typeof appMetadata === 'object') {
          user.appMetadata = { ...user.appMetadata, ...(appMetadata as Record<string, unknown>) }
        }
        send(200, { user: toGoTrueUser(user) })
        return
      }

      send(404, { error: 'not_found' })
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('fake auth server did not bind to a TCP port')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
