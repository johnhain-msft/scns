import { createServer } from 'node:net'

/** Bind-probe, not HTTP: even an unresponsive listener still occupies its port. */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      resolve(true)
    }
  })
}
