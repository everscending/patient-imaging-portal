import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Patient Imaging Portal',
  description: 'View your imaging studies, reports, and appointments.',
}

// Without this, a real phone renders the ~980px desktop-emulation viewport
// instead of its own width, and the 768px shell breakpoint (UX_SPEC §3)
// never fires on an actual device (CQ-4).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
