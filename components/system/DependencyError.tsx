/** @jsxImportSource react */
'use client'

// components/system/DependencyError.tsx — UX_SPEC §4.14's unreachable-
// dependency state. Presentational only: it renders the pinned copy and a
// retry button and takes the retry action from its caller. It never learns
// which dependency failed (database vs. storage) and never renders the
// underlying error — that information stops at app/api/health/route.ts.
//
// The pragma above is read by Playwright Test's own esbuild-based module
// transform, not by Next.js (whose SWC pipeline always uses the React
// automatic runtime regardless): without it, Playwright compiles this
// file's JSX through its component-testing marker objects instead of real
// React elements, and e2e/degraded.spec.ts's react-dom/server render of the
// real component — the only way to test it without a live consuming
// screen — throws "Objects are not valid as a React child".
export type DependencyErrorProps = {
  onRetry: () => void
}

const MESSAGE = 'Images are temporarily unavailable… your data is safe'

export default function DependencyError({ onRetry }: DependencyErrorProps) {
  return (
    <div className="pip-dependency-error" data-testid="dependency-error">
      <p className="pip-notice">{MESSAGE}</p>
      <button
        type="button"
        className="pip-button-primary"
        onClick={onRetry}
        data-testid="dependency-error-retry"
      >
        Try again
      </button>
    </div>
  )
}
