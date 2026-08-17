// Share-link issuance and resolution.  The raw share token never crosses this
// module's persistence boundary: only its SHA-256 digest is stored.
import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'

import { guardPhiAccess } from '../access/guard'
import { config } from '../config'
import { anonClient, serviceClient } from '../db/client'
import { signStorageKeys } from '../imaging/signing'
import { timed } from '../observability/timing'
import { SESSION_COOKIE_NAME } from '../session-cookie'

export type ShareState = 'active' | 'expired' | 'revoked'

type ResourceKind = 'image' | 'report'
type LinkRow = {
  id: string
  patient_id: string
  image_id: string | null
  report_id: string | null
  expires_at: string
  revoked_at: string | null
}

type ImageRow = { id: string; width: number; height: number; ordinal: number; storage_key: string; thumb_key: string | null }
type ReportRow = {
  id: string
  study_id: string
  findings: string
  impression: string
  signed_at: string | null
  studies: { description: string } | { description: string }[] | null
  patients: { patient_ref: string } | { patient_ref: string }[] | null
  providers: { full_name: string } | { full_name: string }[] | null
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

function stateOf(link: Pick<LinkRow, 'expires_at' | 'revoked_at'>): ShareState {
  if (link.revoked_at !== null) return 'revoked'
  return Date.parse(link.expires_at) <= Date.now() ? 'expired' : 'active'
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

function imageExpiry(): string {
  return new Date(Date.now() + config.signedUrlTtlSeconds * 1000).toISOString()
}

async function callerAccessToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null
}

/** Creates a durable link then enqueues its generic email.  The outbox is
 * deliberately best-effort: a queue failure must not revoke a usable link. */
export async function mintShareLink(input: {
  patientId: string
  actorUserId: string
  resourceKind: ResourceKind
  resourceId: string
  recipientEmail: string
}): Promise<{ id: string; url: string; expiresAt: string; recipientEmail: string; delivery: 'sent' | 'failed' }> {
  return timed('share.create', async () => {
    const target = { kind: input.resourceKind, id: input.resourceId } as const
    const access = await guardPhiAccess({ kind: 'patient', userId: input.actorUserId }, target, 'share.create')
    if (!access.ok || access.patientId !== input.patientId) throw new Error('share: resource not found')

    const token = mintToken()
    const url = new URL(`/s/${token}`, config.appBaseUrl).toString()
    const expiresAt = new Date(Date.now() + config.shareLinkTtlHours * 60 * 60 * 1000).toISOString()
    const accessToken = await callerAccessToken()
    if (!accessToken) throw new Error('share: session is unavailable')
    const client = anonClient(accessToken)
    const fields = input.resourceKind === 'image' ? { image_id: input.resourceId, report_id: null } : { image_id: null, report_id: input.resourceId }
    const { data, error } = await client
      .from('share_links')
      .insert({ token_hash: tokenHash(token), patient_id: input.patientId, created_by: input.actorUserId, recipient_email: input.recipientEmail, expires_at: expiresAt, ...fields })
      .select('id')
      .single()
    if (error || !data) throw new Error('share: link could not be created')

    // PHI-free, queued only: this request never invokes an email transport.
    let delivery: 'sent' | 'failed' = 'failed'
    try {
      const { error: outboxError } = await client.from('email_outbox').insert({
        recipient: input.recipientEmail,
        subject: 'Someone shared a secure medical file with you',
        body: `A patient has shared a secure file with you through their clinic's portal.\n\n${url}\n\nThe link works until ${expiresAt} and can be revoked by the person who shared it at any time. Opening it is recorded.\n\nIf you were not expecting this, ignore this message.`,
      })
      if (!outboxError) delivery = 'sent'
    } catch {
      // The link is already durable. A queue outage must not revoke it or turn
      // its successful creation into an error response.
    }

    return { id: (data as { id: string }).id, url, expiresAt, recipientEmail: input.recipientEmail, delivery }
  }, () => 'ok')
}

export async function resolveShareToken(token: string): Promise<
  | { ok: true; shareLinkId: string; patientId: string; resourceKind: ResourceKind; resourceId: string; expiresAt: string }
  | { ok: false }
> {
  const { data, error } = await serviceClient()
    .from('share_links')
    .select('id, patient_id, image_id, report_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash(token))
    .maybeSingle()
  const link = data as LinkRow | null
  if (error || !link || stateOf(link) !== 'active') return { ok: false }
  const resourceKind: ResourceKind = link.image_id === null ? 'report' : 'image'
  const resourceId = link.image_id ?? link.report_id
  if (!resourceId) return { ok: false }
  return { ok: true, shareLinkId: link.id, patientId: link.patient_id, resourceKind, resourceId, expiresAt: link.expires_at }
}

export async function revokeShareLink(input: { id: string; patientId: string; actorUserId: string }): Promise<{ ok: boolean }> {
  const accessToken = await callerAccessToken()
  if (!accessToken) return { ok: false }
  const client = anonClient(accessToken)
  const { data, error } = await client.from('share_links').select('id, patient_id, image_id, report_id').eq('id', input.id).maybeSingle()
  const link = data as Pick<LinkRow, 'id' | 'patient_id' | 'image_id' | 'report_id'> | null
  if (error || !link || link.patient_id !== input.patientId) return { ok: false }
  const resourceKind: ResourceKind = link.image_id === null ? 'report' : 'image'
  const resourceId = link.image_id ?? link.report_id
  if (!resourceId) return { ok: false }
  const access = await guardPhiAccess({ kind: 'patient', userId: input.actorUserId }, { kind: resourceKind, id: resourceId }, 'share.revoke')
  if (!access.ok || access.patientId !== input.patientId) return { ok: false }
  const { error: updateError } = await client.from('share_links').update({ revoked_at: new Date().toISOString() }).eq('id', input.id)
  return { ok: !updateError }
}

export async function listShareLinks(input: { actorUserId: string; accessToken: string }): Promise<
  | { ok: true; shares: Array<{ id: string; resourceKind: ResourceKind; resourceId: string; recipientEmail: string; expiresAt: string; revokedAt: string | null; state: ShareState }> }
  | { ok: false; status: 401 | 403 | 404 }
> {
  const access = await guardPhiAccess({ kind: 'patient', userId: input.actorUserId }, { kind: 'collection', of: 'share' }, 'share.view')
  if (!access.ok) return { ok: false, status: access.status }
  const { data, error } = await anonClient(input.accessToken)
    .from('share_links')
    .select('id, image_id, report_id, recipient_email, expires_at, revoked_at')
    .order('created_at', { ascending: false })
  if (error) throw new Error('share: links could not be read')
  return {
    ok: true,
    shares: ((data ?? []) as Array<LinkRow & { recipient_email: string }>).flatMap((link) => {
      const resourceId = link.image_id ?? link.report_id
      if (!resourceId) return []
      return [{ id: link.id, resourceKind: link.image_id === null ? 'report' as const : 'image' as const, resourceId, recipientEmail: link.recipient_email, expiresAt: link.expires_at, revokedAt: link.revoked_at, state: stateOf(link) }]
    }),
  }
}

export async function sharedPayload(resolved: Extract<Awaited<ReturnType<typeof resolveShareToken>>, { ok: true }>): Promise<Record<string, unknown> | null> {
  const access = await guardPhiAccess({ kind: 'share_recipient', shareLinkId: resolved.shareLinkId }, { kind: resolved.resourceKind, id: resolved.resourceId }, 'share.use')
  if (!access.ok) return null
  const client = serviceClient()
  if (resolved.resourceKind === 'image') {
    const { data, error } = await client.from('images').select('id, width, height, ordinal, storage_key, thumb_key').eq('id', resolved.resourceId).maybeSingle()
    const image = data as ImageRow | null
    if (error || !image) return null
    const signed = await signStorageKeys([image.storage_key, ...(image.thumb_key ? [image.thumb_key] : [])])
    const urls = new Map(signed.map((entry) => [entry.key, entry.url]))
    if (!(await resolvedLinkIsStillActive(client, resolved))) return null
    return { id: image.id, width: image.width, height: image.height, ordinal: image.ordinal, url: urls.get(image.storage_key) ?? null, thumbUrl: image.thumb_key ? (urls.get(image.thumb_key) ?? null) : null, expiresAt: imageExpiry() }
  }
  const { data, error } = await client.from('reports').select('id, study_id, findings, impression, signed_at, studies!inner(description), patients!inner(patient_ref), providers!reports_signed_by_fkey(full_name)').eq('id', resolved.resourceId).maybeSingle()
  const report = data as ReportRow | null
  const study = report ? one(report.studies) : null
  const patient = report ? one(report.patients) : null
  const provider = report ? one(report.providers) : null
  if (error || !report || !study || !patient) return null
  if (!(await resolvedLinkIsStillActive(client, resolved))) return null
  return { id: report.id, studyId: report.study_id, studyDescription: study.description, patientRef: patient.patient_ref, findings: report.findings, impression: report.impression, signedByName: provider?.full_name ?? null, signedAt: report.signed_at }
}

async function resolvedLinkIsStillActive(
  client: ReturnType<typeof serviceClient>,
  resolved: Extract<Awaited<ReturnType<typeof resolveShareToken>>, { ok: true }>,
): Promise<boolean> {
  const { data, error } = await client
    .from('share_links')
    .select('id, patient_id, image_id, report_id, expires_at, revoked_at')
    .eq('id', resolved.shareLinkId)
    .maybeSingle()
  const link = data as LinkRow | null
  if (error || !link || stateOf(link) !== 'active' || link.patient_id !== resolved.patientId) return false
  if (resolved.resourceKind === 'image') return link.image_id === resolved.resourceId && link.report_id === null
  return link.report_id === resolved.resourceId && link.image_id === null
}
