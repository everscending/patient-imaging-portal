import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // next-env.d.ts is Next.js-generated and carries a note not to hand-edit
    // it; its triple-slash reference is the framework's own boilerplate, not
    // something this repo authored, so it is excluded rather than the
    // @typescript-eslint/triple-slash-reference rule weakened project-wide.
    ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'],
  },
]

export default eslintConfig
