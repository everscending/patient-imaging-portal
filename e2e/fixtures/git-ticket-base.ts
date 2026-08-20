import { execFileSync } from 'node:child_process'

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function commit(repository: string, revision: string): string | undefined {
  try {
    return git(repository, 'rev-parse', '--verify', `${revision}^{commit}`)
  } catch {
    return undefined
  }
}

function noTrustworthyBase(): Error {
  return new Error('No trustworthy Git comparison base is available')
}

export function resolveTicketDiffBase(
  repository: string,
  env: { GITHUB_BASE_REF?: string; GITHUB_REF?: string } = {
    GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
    GITHUB_REF: process.env.GITHUB_REF,
  },
): string {
  if (/^refs\/pull\/\d+\/merge$/.test(env.GITHUB_REF ?? '')) {
    const parents = git(repository, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).slice(1)
    if (parents.length !== 2 || parents.some((parent) => !commit(repository, parent))) {
      throw noTrustworthyBase()
    }
    return parents[0]
  }

  const baseName = env.GITHUB_BASE_REF?.trim() || 'main'
  for (const candidate of [`origin/${baseName}`, baseName]) {
    const base = commit(repository, candidate)
    if (!base) continue
    const mergeBases = git(repository, 'merge-base', '--all', base, 'HEAD').split(/\s+/).filter(Boolean)
    if (mergeBases.length === 1) return mergeBases[0]
    throw noTrustworthyBase()
  }
  throw noTrustworthyBase()
}
