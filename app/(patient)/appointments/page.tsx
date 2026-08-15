// app/(patient)/appointments/page.tsx — session-only (§7); the mount page
// the shell needs to render at all (the triage note on this ticket). Content
// beyond the shell belongs to FR-11/FR-13's own ticket.
export default function AppointmentsPage() {
  return (
    <main>
      <h1>Visits</h1>
      <p>Your appointments will appear here.</p>
    </main>
  )
}
