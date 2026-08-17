import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

// A linked lane worktree has the superproject's lockfile above it. Letting
// Next infer the root makes Turbopack watch that parent (and every sibling
// worktree), so each checkout declares the directory containing this config.
const worktreeRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  turbopack: {
    root: worktreeRoot,
  },
}

export default nextConfig
