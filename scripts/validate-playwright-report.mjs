import { readFile } from 'node:fs/promises'
import path from 'node:path'

const reportPath = process.argv[2]
const requiredSuite = process.argv[3]
if (!reportPath || !requiredSuite) throw new Error('usage: validate-playwright-report.mjs <report.json> <required-suite>')

const report = JSON.parse(await readFile(reportPath, 'utf8'))
if (!Array.isArray(report.suites) || typeof report.stats !== 'object' || report.stats === null) {
  throw new Error(`invalid Playwright JSON report: ${reportPath}`)
}

function containsSuite(suites, file) {
  return suites.some((suite) => suite.file === file || (Array.isArray(suite.suites) && containsSuite(suite.suites, file)))
}

if (!containsSuite(report.suites, path.basename(requiredSuite))) {
  throw new Error(`Playwright JSON report does not contain required suite: ${requiredSuite}`)
}
