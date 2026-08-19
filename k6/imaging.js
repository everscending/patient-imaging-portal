import http from 'k6/http'
import { check, fail, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || `http://localhost:${__ENV.PORT || '4310'}`
const EMAIL = __ENV.PATIENT_EMAIL || 'patient@demo.pip.test'
const PASSWORD = __ENV.PATIENT_PASSWORD || 'DemoPass!2026'
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || '60')

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '40s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    pf1_single_image_ms: ['p(95)<1000'],
    pf2_cine_first_frame_ms: ['p(95)<1000'],
    pf3_cine_fully_loaded_ms: ['p(95)<5000'],
    checks: ['rate==1'],
  },
}

const singleImage = new Trend('pf1_single_image_ms', true)
const firstFrame = new Trend('pf2_cine_first_frame_ms', true)
const fullyLoaded = new Trend('pf3_cine_fully_loaded_ms', true)
const unavailableFrames = new Counter('seeded_cine_unavailable_frames')

function authenticatedHeaders() {
  const response = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { operation: 'setup_login' },
  })
  if (response.status !== 200) fail(`seeded patient login failed: ${response.status}`)
  const session = response.cookies.pip_session?.[0]?.value
  if (!session) fail('seeded patient login returned no session cookie')
  return { Cookie: `pip_session=${session}` }
}

export function setup() {
  const headers = authenticatedHeaders()
  const response = http.get(`${BASE_URL}/api/studies`, { headers, tags: { operation: 'setup_studies' } })
  if (response.status !== 200) fail(`seeded studies request failed: ${response.status}`)
  const studies = response.json('studies')
  if (!Array.isArray(studies) || studies.length === 0) fail('seeded dataset has no visible studies')

  const imageStudies = []
  let cineTarget = null
  for (const study of studies) {
    const detailResponse = http.get(`${BASE_URL}/api/studies/${study.id}`, { headers, tags: { operation: 'setup_study' } })
    if (detailResponse.status !== 200) fail(`seeded study detail failed: ${detailResponse.status}`)
    const detail = detailResponse.json()
    if (detail.images?.some((image) => image.url)) imageStudies.push({ id: study.id })
    for (const clip of detail.clips?.filter((candidate) => candidate.frameCount === 100) || []) {
      if (cineTarget) break
      const manifestResponse = http.get(`${BASE_URL}/api/studies/${study.id}/clips/${clip.id}`, {
        headers,
        tags: { operation: 'setup_clip' },
      })
      const frames = manifestResponse.json('frames')
      if (manifestResponse.status === 200 && frames.length === 100 && frames.every((frame) => frame.available && frame.url)) {
        cineTarget = { studyId: study.id, id: clip.id }
      }
    }
  }
  if (imageStudies.length === 0) fail('seeded dataset has no signed image target')
  if (!cineTarget) fail('seeded dataset has no complete 100-frame cine clip')
  return { headers, studies: imageStudies, clip: cineTarget }
}

export default function run(data) {
  const study = data.studies[(__VU - 1) % data.studies.length]
  const imageStarted = Date.now()
  const detailResponse = http.get(`${BASE_URL}/api/studies/${study.id}`, {
    headers: data.headers,
    tags: { operation: 'pf1_manifest' },
  })
  const detail = detailResponse.json()
  const images = detail.images?.filter((candidate) => candidate.url) || []
  const image = images[(__VU - 1) % images.length]
  if (!image) fail('selected study returned no signed image URL')
  const imageResponse = http.get(image.url, { tags: { operation: 'pf1_storage' } })
  singleImage.add(Date.now() - imageStarted)
  check(imageResponse, { 'PF-1 signed image bytes load': (response) => response.status === 200 })

  const cineStarted = Date.now()
  const manifestResponse = http.get(`${BASE_URL}/api/studies/${data.clip.studyId}/clips/${data.clip.id}`, {
    headers: data.headers,
    tags: { operation: 'pf2_pf3_manifest' },
  })
  const manifest = manifestResponse.json()
  const frames = manifest.frames || []
  check(manifest, {
    'seeded cine manifest has 100 available indices': (value) => value.frameCount === 100
      && frames.length === 100
      && frames.every((frame) => frame.available && frame.url),
  })
  const available = frames.filter((frame) => frame.available && frame.url)
  unavailableFrames.add(frames.length - available.length)
  const firstAvailableIndex = available.findIndex((frame) => frame.index === 0)
  const firstFrameIndex = firstAvailableIndex >= 0 ? firstAvailableIndex : 0
  const firstFrameTarget = available[firstFrameIndex]
  if (!firstFrameTarget) fail('100-frame cine manifest has no signed frame URL')
  const firstFrameResponse = http.get(firstFrameTarget.url, { tags: { operation: 'pf2_storage' } })
  firstFrame.add(Date.now() - cineStarted)
  check(firstFrameResponse, { 'PF-2 signed first-frame bytes load': (response) => response.status === 200 })

  const remainingFrames = available
    .filter((_, index) => index !== firstFrameIndex)
    .map((frame) => ['GET', frame.url, null, { tags: { operation: 'pf3_storage' } }])
  const remainingResponses = http.batch(remainingFrames)
  fullyLoaded.add(Date.now() - cineStarted)
  check(remainingResponses, { 'PF-3 all available signed frame bytes load': (responses) => responses.every((response) => response.status === 200) })

  // One measured pass per virtual user keeps the 100-frame transfer bounded;
  // the VU remains active for the stated 60-second scenario.
  sleep(HOLD_SECONDS)
}
