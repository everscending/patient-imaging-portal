import http from 'k6/http'
import { check, fail, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'
import { authenticatedHeaders } from './lib/auth.js'

const BASE_URL = __ENV.BASE_URL || `http://localhost:${__ENV.PORT || '4310'}`
const EMAIL = __ENV.PATIENT_EMAIL || 'patient@demo.pip.test'
const PASSWORD = __ENV.PATIENT_PASSWORD || 'DemoPass!2026'
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || '60')

// Read from the viewer rather than restated here, so the read-ahead bound this
// script exercises is the bound the component actually applies (EL-1, JOR-243).
const CINE_FRAME_WINDOW = Number(
  /export const CINE_FRAME_WINDOW = (\d+)/.exec(open('../components/imaging/CineViewer.tsx'))[1],
)

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
// EL-1's own delivery path, measured beside PF-1/PF-2/PF-3 and never in place
// of them: what the viewer actually draws first (thumbnail, poster) and what it
// actually fetches before playback (one bounded read-ahead window), rather than
// the whole-asset totals the PF rows are defined as.
const thumbnailFirst = new Trend('el1_thumbnail_first_ms', true)
const posterFirst = new Trend('el1_cine_poster_ms', true)
const frameWindow = new Trend('el1_cine_frame_window_ms', true)

export function setup() {
  const headers = authenticatedHeaders(BASE_URL, EMAIL, PASSWORD)
  const response = http.get(`${BASE_URL}/api/studies`, { headers, tags: { operation: 'setup_studies' } })
  if (response.status !== 200) fail(`seeded studies request failed: ${response.status}`)
  const studies = response.json('studies')
  if (!Array.isArray(studies) || studies.length === 0) fail('seeded dataset has no visible studies')

  const imageStudies = []
  let thumbnailStudies = 0
  let cineTarget = null
  for (const study of studies) {
    const detailResponse = http.get(`${BASE_URL}/api/studies/${study.id}`, { headers, tags: { operation: 'setup_study' } })
    if (detailResponse.status !== 200) fail(`seeded study detail failed: ${detailResponse.status}`)
    const detail = detailResponse.json()
    if (detail.images?.some((image) => image.url)) imageStudies.push({ id: study.id })
    if (detail.images?.some((image) => image.thumbUrl)) thumbnailStudies++
    for (const clip of detail.clips?.filter((candidate) => candidate.frameCount === 100) || []) {
      if (cineTarget) break
      const manifestResponse = http.get(`${BASE_URL}/api/studies/${study.id}/clips/${clip.id}`, {
        headers,
        tags: { operation: 'setup_clip' },
      })
      const frames = manifestResponse.json('frames')
      if (manifestResponse.status === 200 && frames.length === 100 && frames.every((frame) => frame.available && frame.url)) {
        cineTarget = { studyId: study.id, id: clip.id, posterUrl: manifestResponse.json('posterUrl') }
      }
    }
  }
  if (imageStudies.length === 0) fail('seeded dataset has no signed image target')
  if (!cineTarget) fail('seeded dataset has no complete 100-frame cine clip')
  // A stack whose EL-1 derivatives were never provisioned still serves every
  // full-size asset, so PF-1/PF-3 would "measure EL-1" against a build that has
  // no thumbnail or poster to deliver. Refuse to produce that number.
  if (thumbnailStudies === 0) fail('EL-1 derivatives are missing: no study exposes a signed thumbUrl')
  if (!cineTarget.posterUrl) fail('EL-1 derivatives are missing: the 100-frame clip exposes no signed posterUrl')
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

  measureEl1Path(data, study)

  // One measured pass per virtual user keeps the 100-frame transfer bounded;
  // the VU remains active for the stated 60-second scenario.
  sleep(HOLD_SECONDS)
}

// EL-1's delivery path, measured only after every PF window above has closed,
// so PF-1/PF-2/PF-3 keep the exact requests, order and timers the recorded
// before-column run used. This pass only ever adds load to the run; it can
// make a PF row look worse than the baseline, never better.
function measureEl1Path(data, study) {
  const thumbnailStarted = Date.now()
  const detailResponse = http.get(`${BASE_URL}/api/studies/${study.id}`, {
    headers: data.headers,
    tags: { operation: 'el1_manifest' },
  })
  const thumbnails = (detailResponse.json('images') || []).filter((candidate) => candidate.thumbUrl)
  const thumbnail = thumbnails[(__VU - 1) % thumbnails.length]
  if (!thumbnail) fail('EL-1 thumbnail-first path has no signed thumbUrl to measure')
  const thumbnailResponse = http.get(thumbnail.thumbUrl, { tags: { operation: 'el1_thumbnail' } })
  thumbnailFirst.add(Date.now() - thumbnailStarted)
  check(thumbnailResponse, { 'EL-1 signed thumbnail bytes load': (response) => response.status === 200 })

  // Deliberately re-fetched rather than reusing the PF-2/PF-3 manifest above:
  // this models a fresh navigation to the clip, which is how a patient reaches
  // it, and keeps the poster and window timings a real sequence from the
  // manifest request rather than a total reconstructed from an earlier one.
  const posterStarted = Date.now()
  const manifestResponse = http.get(`${BASE_URL}/api/studies/${data.clip.studyId}/clips/${data.clip.id}`, {
    headers: data.headers,
    tags: { operation: 'el1_clip_manifest' },
  })
  const manifest = manifestResponse.json()
  const posterResponse = http.get(manifest.posterUrl, { tags: { operation: 'el1_poster' } })
  posterFirst.add(Date.now() - posterStarted)
  check(posterResponse, { 'EL-1 signed poster bytes load': (response) => response.status === 200 })

  // One bounded read-ahead window, the size CineViewer.tsx states: what the
  // viewer fetches before playback, not the whole 100-frame clip.
  const windowFrames = (manifest.frames || [])
    .filter((frame) => frame.available && frame.url)
    .slice(0, CINE_FRAME_WINDOW)
    .map((frame) => ['GET', frame.url, null, { tags: { operation: 'el1_frame_window' } }])
  const windowResponses = http.batch(windowFrames)
  frameWindow.add(Date.now() - posterStarted)
  check(windowResponses, {
    'EL-1 bounded frame window loads': (responses) => responses.length === CINE_FRAME_WINDOW
      && responses.every((response) => response.status === 200),
  })
}
