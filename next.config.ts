import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

// A linked lane worktree has the superproject's lockfile above it. Letting
// Next infer the root makes its tracing and bundler watchers climb to that
// parent (and every sibling worktree), so each checkout declares the directory
// containing this config for both tracing and Turbopack.
const worktreeRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  outputFileTracingRoot: worktreeRoot,
  turbopack: {
    root: worktreeRoot,
  },
  async headers() {
    return [{
      source: '/s/:token',
      headers: [
        { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
        { key: 'Pragma', value: 'no-cache' },
        { key: 'Expires', value: '0' },
      ],
    }]
  },
}

export default nextConfig
