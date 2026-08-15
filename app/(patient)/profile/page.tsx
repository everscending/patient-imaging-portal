// Placeholder only — §4.2a's real profile form is a separate ticket's scope.
// This exists so app/(patient)/layout.tsx (and the shell it renders) has a
// real, session-only page to render at all: none of the six verified routes
// exist yet, and /profile needs a session but never a patient link (§7).
export default function ProfilePage() {
  return (
    <main style={{ padding: '1.5rem 1rem' }}>
      <h1>Profile</h1>
      <p>Profile management is not yet available.</p>
    </main>
  )
}
