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

export function resolveTicketDiffBase(repository: string): string {
  const pullMergeRefs = git(
    repository,
    'for-each-ref', '--format=%(refname)', '--points-at', 'HEAD', 'refs/remotes/pull',
  ).split(/\s+/).filter((ref) => /^refs\/remotes\/pull\/\d+\/merge$/.test(ref))
  if (pullMergeRefs.length > 1) throw noTrustworthyBase()
  if (pullMergeRefs.length === 1) {
    const parents = git(repository, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).slice(1)
    if (parents.length !== 2 || parents.some((parent) => !commit(repository, parent))) {
      throw noTrustworthyBase()
    }
    return parents[0]
  }

  for (const candidate of ['origin/main', 'main']) {
    const base = commit(repository, candidate)
    if (!base) continue
    const mergeBases = git(repository, 'merge-base', '--all', base, 'HEAD').split(/\s+/).filter(Boolean)
    if (mergeBases.length === 1) return mergeBases[0]
    throw noTrustworthyBase()
  }
  throw noTrustworthyBase()
}
