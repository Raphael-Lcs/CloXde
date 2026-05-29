// One-off: build an AsyncStorage RKStorage file that contains a pre-paired
// connection blob, so we can push it onto the pad and bypass the Pair screen.
// This validates the cleartext-HTTP fix end-to-end without UI simulation —
// if the app loads ProjectList successfully after this, fetch() is working.

const Database = require('better-sqlite3')
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, 'RKStorage')
fs.rmSync(OUT, { force: true })

const db = new Database(OUT)
db.pragma('journal_mode = DELETE') // RN's default; simpler than WAL for one-shot push

db.exec(`
  CREATE TABLE catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE android_metadata (locale TEXT);
  INSERT INTO android_metadata VALUES ('zh_CN');
`)

const conn = {
  baseUrl: 'http://192.168.31.48:7878',
  token: 'd37bb8e8fa850681887bc3068e55ce425cf66b596a019e47ec366e39a7c3a19f',
  label: 'diagnostic-test',
  lastSeenAt: Date.now()
}

db.prepare('INSERT INTO catalystLocalStorage (key, value) VALUES (?, ?)').run(
  '@cloxde/connection',
  JSON.stringify(conn)
)
db.close()

console.log('Wrote', OUT, fs.statSync(OUT).size, 'bytes')
