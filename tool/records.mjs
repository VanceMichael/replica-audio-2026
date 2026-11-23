// 来源 TSV 行 → 业务记录（列序见 source/formats.md）

import { fetchStream } from './clients.mjs'

export const STREAMS = ['replicas', 'install', 'scan', 'captions', 'delivered']

export const parse = {
  replicas: row => ({
    replica: row[0],
    version: row[1],
    zone: row[2],
    left: Number(row[3]),
    right: Number(row[4]),
    permission: row[5]
  }),
  install: row => ({
    venue: row[0],
    desk: row[1],
    panel: row[2],
    generation: row[3],
    replica: row[4],
    width: Number(row[5]),
    orientation: row[6]
  }),
  scan: row => ({
    panel: row[0],
    generation: row[1],
    address: Number(row[2]),
    gesture: row[3],
    coord: Number(row[4]),
    repeat: Number(row[5])
  }),
  captions: row => ({
    version: row[0],
    zone: row[1],
    locale: row[2],
    segment: row[3]
  }),
  delivered: row => ({
    venue: row[0],
    player: row[1],
    panel: row[2],
    generation: row[3],
    address: Number(row[4]),
    gesture: row[5],
    segment: row[6]
  })
}

export function parseStream(name, rows) {
  return rows.map(parse[name])
}

export async function fetchRecords(root, { edition, cache } = {}) {
  const records = {}
  const editions = new Set()
  for (const name of STREAMS) {
    const result = await fetchStream(root, name, { edition, cache })
    records[name] = parseStream(name, result.rows)
    editions.add(result.edition)
  }
  return { edition: [...editions][0], records }
}
