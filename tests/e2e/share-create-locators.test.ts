import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

test('share-create alert assertions stay scoped to their owned surface', async () => {
  const source = await readFile(path.join(process.cwd(), 'e2e/share-create.spec.ts'), 'utf8')

  expect(source).not.toMatch(/\bpage\.getByRole\(['"]alert['"]\)/)
  expect(source).not.toMatch(/\bpage\.getByLabel\(['"]Active share link['"]\)/)
})
