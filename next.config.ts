import type { NextConfig } from 'next'
import path from 'node:path'

const WORKTREE_ROOT = path.resolve(__dirname)

// A lane worktree can sit below a checkout with its own lockfile. Pin both
// roots so Next never promotes that enclosing checkout to the application
// workspace while the live fixture is starting.
const nextConfig: NextConfig = {
  outputFileTracingRoot: WORKTREE_ROOT,
  turbopack: {
    root: WORKTREE_ROOT,
  },
}

export default nextConfig
