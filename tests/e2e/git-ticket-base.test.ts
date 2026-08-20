import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { resolveTicketDiffBase } from '../../e2e/fixtures/git-ticket-base'

const fixtures: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pip-ticket-base-'))
  fixtures.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base')
  return root
}

function makePullRequestCheckout(depth: number): { checkout: string; firstParent: string } {
  const source = initRepository()
  const firstParent = git(source, 'rev-parse', 'HEAD')
  git(source, 'switch', '-q', '-c', 'feature')
  git(source, 'commit', '-q', '--allow-empty', '-m', 'feature')
  git(source, 'switch', '-q', '-c', 'pr-merge', 'main')
  git(source, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge')

  const checkout = mkdtempSync(path.join(tmpdir(), `pip-ticket-checkout-${depth}-`))
  fixtures.push(checkout)
  git(checkout, 'clone', '-q', `--depth=${depth}`, '--branch', 'pr-merge', `file://${source}`, '.')
  git(checkout, 'update-ref', 'refs/remotes/pull/93/merge', 'HEAD')
  return { checkout, firstParent }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

test('local feature checkout resolves the ticket branch merge-base', () => {
  const repository = initRepository()
  const base = git(repository, 'rev-parse', 'HEAD')
  git(repository, 'update-ref', 'refs/remotes/origin/main', base)
  git(repository, 'switch', '-q', '-c', 'feature')
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'ticket one')
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'ticket two')

  expect(resolveTicketDiffBase(repository)).toBe(base)
  git(repository, 'update-ref', '-d', 'refs/remotes/origin/main')
  expect(resolveTicketDiffBase(repository)).toBe(base)
})

test('GitHub pull-request merge checkout uses its first parent', () => {
  const { checkout, firstParent } = makePullRequestCheckout(2)

  expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true')
  expect(resolveTicketDiffBase(checkout)).toBe(firstParent)
})

test('pull-request checkout with unavailable parents fails closed', () => {
  const { checkout } = makePullRequestCheckout(1)

  expect(() => resolveTicketDiffBase(checkout)).toThrow(/trustworthy Git comparison base/)
})

test('pull-request checkout with ambiguous parents fails closed', () => {
  const repository = initRepository()
  git(repository, 'switch', '-q', '-c', 'feature-a')
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'feature a')
  git(repository, 'switch', '-q', '-c', 'feature-b', 'main')
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'feature b')
  git(repository, 'switch', '-q', 'main')
  git(repository, 'merge', '-q', '--no-ff', 'feature-a', 'feature-b', '-m', 'octopus')
  git(repository, 'update-ref', 'refs/remotes/pull/93/merge', 'HEAD')

  expect(() => resolveTicketDiffBase(repository)).toThrow(/trustworthy Git comparison base/)
})
