// app/api/health/route.ts — CQ-3, EC-12, PF-9. Unauthenticated, no session,
// no PhiTarget (§5's guard is the PHI seam and health names none of it), and
// always 200: a non-200 here would be indistinguishable from the app being
// gone, which defeats the one thing an uptime check needs to tell apart
// (UX_SPEC §4.14). Each probe is a cheap liveness read — a zero-row PostgREST
// query and a Storage bucket-metadata call — never a query returning PHI,
// so this endpoint is never itself an audited PHI read and never calls
// lib/access/guard.ts.
import { NextResponse } from 'next/server'
import { config } from '../../../lib/config'

export const dynamic = 'force-dynamic'

type DependencyState = 'ok' | 'down'

// Bounded so a hung dependency can never make this endpoint hang — an
// unbounded probe would turn "the database is slow" into "the uptime check
// times out", which reads identically to "the app is gone".
const PROBE_TIMEOUT_MS = 2000

// Never inspects the caught error: a database error string, a host name or
// a stack trace would leak straight into an unauthenticated response body,
// which UX_SPEC §5's never-rendered list forbids outright.
async function probe(url: string, headers: Record<string, string>): Promise<DependencyState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
    return response.ok ? 'ok' : 'down'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

function probeDatabase(): Promise<DependencyState> {
  // A root-path 200 does not prove the application schema reached PostgREST's
  // cache. limit=0 names the schema seam without returning a patient row.
  return probe(`${config.supabaseUrl}/rest/v1/patients?select=id&limit=0`, {
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  })
}

function probeStorage(): Promise<DependencyState> {
  // Bucket metadata, not an object listing: proves Storage is reachable
  // without reading anything from the phi bucket's contents.
  return probe(`${config.supabaseUrl}/storage/v1/bucket/phi`, {
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  })
}

// EC-12, SEC-6: one line per failing dependency, naming the dependency and
// the outcome only — the same no-PHI discipline as §13a's timing lines.
function logDependencyDown(dependency: 'database' | 'storage'): void {
  console.error(JSON.stringify({ op: 'health.probe', dependency, outcome: 'down' }))
}

export async function GET(): Promise<Response> {
  const [database, storage] = await Promise.all([probeDatabase(), probeStorage()])
  if (database === 'down') logDependencyDown('database')
  if (storage === 'down') logDependencyDown('storage')

  return NextResponse.json({ app: 'ok', database, storage }, { status: 200 })
}
