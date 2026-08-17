// JOR-263 — account profile metadata. The caller may use this route before
// identity linking, so it is session-only rather than a PHI-guarded surface.
// It reads patients solely to expose the caller's already-linked reference;
// every write targets the caller's own Supabase Auth metadata.
import { cookies } from 'next/headers'
import { anonClient, updateOwnAccountMetadata } from '../../../lib/db/client'
import { SESSION_COOKIE_NAME } from '../../../lib/session-cookie'
import { parseBody, profilePatchSchema } from '../../../lib/validation'
import { errorResponse } from '../../../lib/validation/envelope'

type Profile = {
  email: string
  fullName: string
  phone: string | null
  patientRef: string | null
}

async function sessionToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null
}

function optionalMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function readProfile(accessToken: string): Promise<{ profile: Profile | null; failed: boolean }> {
  const client = anonClient(accessToken)
  const { data: userData, error: userError } = await client.auth.getUser(accessToken)
  if (userError || !userData.user) return { profile: null, failed: false }

  const { data: patientData, error: patientError } = await client
    .from('patients')
    .select('patient_ref')
    .eq('user_id', userData.user.id)
    .maybeSingle()
  if (patientError) return { profile: null, failed: true }

  const metadata = (userData.user.user_metadata ?? {}) as Record<string, unknown>
  const patient = patientData as { patient_ref: string } | null
  return {
    failed: false,
    profile: {
      email: userData.user.email ?? '',
      fullName: optionalMetadataString(metadata, 'full_name') ?? '',
      phone: optionalMetadataString(metadata, 'phone'),
      patientRef: patient?.patient_ref ?? null,
    },
  }
}

function sessionRequired(): Response {
  return errorResponse(401, 'session_required', 'Sign in to continue.')
}

export async function GET(): Promise<Response> {
  const token = await sessionToken()
  if (!token) return sessionRequired()

  const result = await readProfile(token)
  if (!result.profile) {
    return result.failed
      ? errorResponse(500, 'profile_unavailable', 'The profile is temporarily unavailable.')
      : sessionRequired()
  }
  return Response.json(result.profile, { status: 200 })
}

export async function PATCH(request: Request): Promise<Response> {
  const token = await sessionToken()
  if (!token) return sessionRequired()
  const parsed = await parseBody(profilePatchSchema, request)
  if (!parsed.ok) return parsed.response

  // Resolve the caller before the write. A syntactically valid but expired
  // token is a 401 and never reaches the Auth metadata endpoint.
  const before = await readProfile(token)
  if (!before.profile) {
    return before.failed
      ? errorResponse(500, 'profile_unavailable', 'The profile is temporarily unavailable.')
      : sessionRequired()
  }

  const updated = await updateOwnAccountMetadata(token, {
    full_name: parsed.value.fullName,
    phone: parsed.value.phone,
  })
  if (!updated) return errorResponse(500, 'profile_update_failed', 'The profile could not be saved.')

  const after = await readProfile(token)
  if (!after.profile) return errorResponse(500, 'profile_unavailable', 'The profile is temporarily unavailable.')
  return Response.json(after.profile, { status: 200 })
}
