// Minimal harness that starts the broker HTTP server against a given DB path
// WITHOUT running startup cleanup. Used to validate Phase 13.6 message-bus
// restart recovery over real HTTP and real SQLite.
import { createServer } from 'node:http'
import { openDatabase } from '../dist/broker/storage/db.js'
import { createEventLog } from '../dist/broker/services/event-log.js'
import { createEventDispatcher } from '../dist/broker/event-dispatcher.js'
import { createBrokerServer } from '../dist/broker/server.js'

const dbPath = process.argv[2]
const port = parseInt(process.argv[3] ?? '3499', 10)
if (!dbPath) { console.error('usage: msgbus-harness.mjs <dbPath> [port]'); process.exit(2) }

const db = openDatabase(dbPath)
const dispatcher = createEventDispatcher()
const eventLog = createEventLog(db, dispatcher)
const broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
const server = createServer(broker.app)
server.listen(port, '127.0.0.1', () => {
  console.log(`[harness] broker listening on http://127.0.0.1:${port} db=${dbPath}`)
})
process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0) })
