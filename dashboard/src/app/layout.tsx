import type { Metadata } from 'next'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './globals.css'
import { QueryProvider } from '../providers/query-provider'
import { Sidebar } from '../components/sidebar'
import { SkipToContent } from '../components/skip-to-content'

export const metadata: Metadata = {
  title: 'SCNS Dashboard',
  description: 'Second Central Nervous System',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>
        <SkipToContent />
        <Theme appearance="dark" accentColor="blue" radius="medium">
          <QueryProvider>
            <div style={{ display: 'flex', minHeight: '100vh' }}>
              <Sidebar />
              <main id="main-content" role="main" style={{ flex: 1, padding: '1.5rem' }}>
                {children}
              </main>
            </div>
          </QueryProvider>
        </Theme>
      </body>
    </html>
  )
}
