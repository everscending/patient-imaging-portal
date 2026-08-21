import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../../lib/config', () => ({ config: {} }))

type GrantResponse = {
  data: { patient_id: string | null; status: number; actor_kind?: string } | null
  error: { message: string } | null
}

const {
  rpcCalls,
  legacyReads,
  auditWrites,
  anonClientMock,
  authClientMock,
  resetGrant,
  resolveGrant,
} = vi.hoisted(() => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = []
  const reads: string[] = []
  const writes: Record<string, unknown>[] = []
  let resolve: (response: GrantResponse) => void = () => undefined

  function nextGrant(): Promise<GrantResponse> {
    return new Promise((next) => {
      resolve = next
    })
  }

  let grant = nextGrant()

  return {
    rpcCalls: calls,
    legacyReads: reads,
    auditWrites: writes,
    anonClientMock: vi.fn(() => ({
      rpc(name: string, input: Record<string, unknown>) {
        calls.push({ name, input })
        return grant
      },
      from(table: string) {
        reads.push(table)
        throw new Error('sequential patient imaging access-grant mutant reached a legacy table read')
      },
    })),
    authClientMock: vi.fn(() => ({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: 'account-1' } }, error: null })),
      },
    })),
    resetGrant() {
      calls.length = 0
      reads.length = 0
      writes.length = 0
      grant = nextGrant()
    },
    resolveGrant(response: GrantResponse) {
      resolve(response)
    },
  }
})

vi.mock('../../lib/db/client', () => ({
  anonClient: anonClientMock,
  authClient: authClientMock,
  serviceClient: vi.fn(),
}))

vi.mock('../../lib/audit/events', () => ({
  recordPhiAccessDecision: vi.fn(async (input: Record<string, unknown>) => {
    auditWrites.push(input)
  }),
}))

vi.mock('../../lib/session-cookie', () => ({ SESSION_COOKIE_NAME: 'pip_session' }))
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: 'caller-access-token' }) })),
}))

import { guardPhiAccess } from '../../lib/access/guard'

beforeEach(() => {
  resetGrant()
  anonClientMock.mockClear()
  authClientMock.mockClear()
})

describe('patient imaging access grant dependency round', () => {
  test.each([
    ['study', 'study.view'],
    ['clip', 'clip.view'],
  ] as const)('%s identity, ownership, and audit use one awaited caller-scoped grant', async (kind, action) => {
    let settled = false
    const result = guardPhiAccess(
      { kind: 'patient', userId: 'account-1' },
      { kind, id: `${kind}-1` },
      action,
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    expect(rpcCalls).toEqual([{
      name: 'grant_patient_imaging_access',
      input: { p_target_kind: kind, p_target_id: `${kind}-1` },
    }])
    expect(legacyReads).toEqual([])
    expect(auditWrites).toEqual([])
    expect(settled).toBe(false)

    resolveGrant({ data: { patient_id: 'patient-1', status: 200 }, error: null })

    await expect(result).resolves.toEqual({ ok: true, patientId: 'patient-1' })
    expect(auditWrites).toEqual([])
  })

  test('a completed denial is returned without a second application audit write', async () => {
    const result = guardPhiAccess(
      { kind: 'patient', userId: 'account-1' },
      { kind: 'study', id: 'foreign-study' },
      'study.view',
    )

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    resolveGrant({ data: { patient_id: null, status: 404 }, error: null })

    await expect(result).resolves.toEqual({ ok: false, status: 404 })
    expect(auditWrites).toEqual([])
  })

  test('a study grant classifies the caller in the same round it decides and audits', async () => {
    let settled = false
    const result = guardPhiAccess(
      { kind: 'account', userId: 'account-1' },
      { kind: 'study', id: 'study-1' },
      'study.view',
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    // A mutant that resolves the actor first reaches from('staff_admins') and
    // from('providers'), which the client mock refuses.
    expect(rpcCalls).toEqual([{ name: 'grant_study_access', input: { p_study_id: 'study-1' } }])
    expect(legacyReads).toEqual([])
    expect(auditWrites).toEqual([])
    expect(settled).toBe(false)

    resolveGrant({ data: { actor_kind: 'provider', patient_id: 'patient-1', status: 200 }, error: null })

    await expect(result).resolves.toEqual({ ok: true, patientId: 'patient-1' })
    expect(auditWrites).toEqual([])
  })

  test('a classified study denial keeps its status without a second application audit write', async () => {
    const result = guardPhiAccess(
      { kind: 'account', userId: 'account-1' },
      { kind: 'study', id: 'study-1' },
      'study.view',
    )

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    resolveGrant({ data: { actor_kind: 'patient', patient_id: null, status: 403 }, error: null })

    await expect(result).resolves.toEqual({ ok: false, status: 403 })
    expect(legacyReads).toEqual([])
    expect(auditWrites).toEqual([])
  })

  test('a failed classified study round appends one denial before the sanitized dependency error', async () => {
    const result = guardPhiAccess(
      { kind: 'account', userId: 'account-1' },
      { kind: 'study', id: 'study-1' },
      'study.view',
    )

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    resolveGrant({ data: null, error: { message: 'SECRET_ADAPTER_ERROR' } })

    await expect(result).rejects.toThrow('guardPhiAccess: authorization dependency unavailable')
    expect(auditWrites).toEqual([expect.objectContaining({
      actorKind: 'account',
      actorRef: 'account-1',
      action: 'study.view',
      targetKind: 'study',
      targetId: 'study-1',
      outcome: 'denied',
    })])
  })

  test('a failed grant round appends one denial before the sanitized dependency error', async () => {
    const result = guardPhiAccess(
      { kind: 'patient', userId: 'account-1' },
      { kind: 'clip', id: 'clip-1' },
      'clip.view',
    )

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1))
    resolveGrant({ data: null, error: { message: 'SECRET_ADAPTER_ERROR' } })

    await expect(result).rejects.toThrow('guardPhiAccess: authorization dependency unavailable')
    expect(auditWrites).toEqual([expect.objectContaining({
      actorKind: 'account',
      actorRef: 'account-1',
      action: 'clip.view',
      targetKind: 'clip',
      targetId: 'clip-1',
      outcome: 'denied',
    })])
  })
})
