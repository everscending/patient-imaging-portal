import { readFile } from 'node:fs/promises'
import path from 'node:path'

const reportPath = process.argv[2]
const requiredSuite = process.argv[3]
if (!reportPath || !requiredSuite) throw new Error('usage: validate-playwright-report.mjs <report.json> <required-suite>')

const report = JSON.parse(await readFile(reportPath, 'utf8'))
if (!Array.isArray(report.suites) || typeof report.stats !== 'object' || report.stats === null) {
  throw new Error(`invalid Playwright JSON report: ${reportPath}`)
}

function suiteTests(suites, file) {
  return suites.flatMap((suite) => [
    ...(suite.file === file && Array.isArray(suite.specs)
      ? suite.specs.flatMap((spec) => Array.isArray(spec.tests) ? spec.tests : [])
      : []),
    ...(Array.isArray(suite.suites) ? suiteTests(suite.suites, file) : []),
  ])
}

const tests = suiteTests(report.suites, path.basename(requiredSuite))
if (!tests.some((test) => typeof test?.status === 'string' && test.status !== 'skipped')) {
  throw new Error(`Playwright JSON report has no completed test for required suite: ${requiredSuite}`)
}
