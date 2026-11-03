'use client'

import { Card, Heading } from '@radix-ui/themes'
import type { ReactNode } from 'react'

export function StatCard({ title, children }: { title: string; children: ReactNode }) {
  const id = `card-${title.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <section aria-labelledby={id}>
      <Card size="2">
        <Heading as="h2" size="3" id={id} mb="3">
          {title}
        </Heading>
        {children}
      </Card>
    </section>
  )
}
