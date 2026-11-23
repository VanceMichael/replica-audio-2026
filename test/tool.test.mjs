import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { parseTp1, dedupeReadings, encodeTp1 } from '../tool/tp1.mjs'
import { entityCoordinate, calibratePanel } from '../tool/calibrate.mjs'
import { planLocales } from '../tool/plan.mjs'
import { collectScans, findRedoGestures } from '../tool/collect.mjs'
import { fetchStream, fetchBlock } from '../tool/clients.mjs'
import { buildCalibration } from '../tool/pipeline.mjs'
import { createStore } from '../tool/store.mjs'

const run = promisify(execFile)

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

const ZONES_K = [
  { replica: 'K', version: 'vA', zone: 'line', left: 0, right: 6, permission: 'touch' },
  { replica: 'K', version: 'vA', zone: 'swirl', left: 4, right: 10, permission: 'touch' },
  { replica: 'K', version: 'vA', zone: 'edge', left: 10, right: 14, permission: 'view' }
]

const INSTALL_A = { venue: 'M', desk: 'D', panel: 'P', generation: 'A', replica: 'K', width: 14, orientation: 'L' }
const INSTALL_B = { ...INSTALL_A, generation: 'B', orientation: 'R' }

test('TP1 块解析与重复读数合并', async () => {
  const buffer = await readFile(new URL('../records/media/panel-2.dat', import.meta.url))
  const readings = parseTp1(buffer)
  assert.equal(readings.length, 2)
  assert.deepEqual(readings[0], { address: 1, gesture: 'tap', coord: 6, repeat: 1 })
  const { unique, duplicates } = dedupeReadings(readings)
  assert.equal(unique.length, 1)
  assert.equal(unique[0].copies, 2)
  assert.equal(duplicates.length, 1)
  assert.deepEqual(parseTp1(encodeTp1(readings)), readings)
  assert.throws(() => parseTp1(Buffer.from('XX1')), /TP1/)
  assert.throws(() => parseTp1(Buffer.concat([Buffer.from('TP1'), Buffer.alloc(5)])), /长度/)
})

test('朝向换算：R 时实体坐标 = 位宽 − 面板坐标', () => {
  assert.equal(entityCoordinate(2, 14, 'L'), 2)
  assert.equal(entityCoordinate(12, 14, 'R'), 2)
  assert.equal(entityCoordinate(6, 14, 'R'), 8)
})

test('校准：有效读数落在解释区，只读区读数待复核', () => {
  const readings = [
    { address: 1, gesture: 'tap', coord: 2, repeat: 1, scan: 's1' },
    { address: 1, gesture: 'sweep', coord: 8, repeat: 2, scan: 's1' },
    { address: 2, gesture: 'tap', coord: 11, repeat: 1, scan: null }
  ]
  const result = calibratePanel(INSTALL_A, ZONES_K, readings)
  const valid = Object.fromEntries(result.valid.map(entry => [`${entry.address}:${entry.gesture}`, entry]))
  assert.equal(valid['1:tap'].zone, 'line')
  assert.equal(valid['1:sweep'].zone, 'swirl')
  assert.deepEqual(valid['1:tap'].scans, ['s1'])
  assert.equal(result.review.length, 1)
  assert.equal(result.review[0].reason, 'no-touch-zone')
  assert.deepEqual(result.review[0].zones, ['edge'])
  assert.equal(result.evidence[1].held, true)
})

test('校准：翻面后同一地址手势落到反面的区', () => {
  const readings = [
    { address: 1, gesture: 'tap', coord: 6, repeat: 1, scan: 's2' },
    { address: 1, gesture: 'sweep', coord: 12, repeat: 2, scan: 's2' },
    { address: 2, gesture: 'tap', coord: 11, repeat: 1, scan: null }
  ]
  const result = calibratePanel(INSTALL_B, ZONES_K, readings)
  const valid = Object.fromEntries(result.valid.map(entry => [`${entry.address}:${entry.gesture}`, entry]))
  assert.equal(valid['1:tap'].zone, 'swirl')
  assert.equal(valid['1:sweep'].zone, 'line')
  assert.equal(valid['2:tap'].zone, 'line')
  assert.equal(result.review.length, 0)
})

test('校准：相交区需不同手势各落单区部分才有分辨证据', () => {
  // 两条读数同一手势：虽有line/swirl两区，但缺不同手势 → 证据不足
  const same = calibratePanel(INSTALL_A, ZONES_K, [
    { address: 1, gesture: 'tap', coord: 2, repeat: 1 },
    { address: 1, gesture: 'tap', coord: 8, repeat: 2 }
  ])
  assert.equal(same.valid.length, 0)
  assert.ok(same.review.every(reading => reading.reason === 'insufficient-evidence'))
  // 读数落在两区相交部分 → 待复核
  const ambiguous = calibratePanel(INSTALL_A, ZONES_K, [
    { address: 1, gesture: 'tap', coord: 5, repeat: 1 }
  ])
  assert.equal(ambiguous.review[0].reason, 'ambiguous-zones')
  assert.deepEqual(ambiguous.review[0].zones, ['line', 'swirl'])
  // 只读区与可触区重叠时不得触发
  const overlap = calibratePanel(INSTALL_A, [
    { zone: 'line', left: 0, right: 6, permission: 'touch' },
    { zone: 'guard', left: 4, right: 8, permission: 'view' }
  ], [{ address: 1, gesture: 'tap', coord: 5, repeat: 1 }])
  assert.equal(overlap.review[0].reason, 'no-touch-zone')
})

test('规划：不沿用同编码展件或旧资料版的音段', () => {
  const captions = [
    { version: 'vA', zone: 'line', locale: 'zh', segment: 'a4' },
    { version: 'vA', zone: 'swirl', locale: 'zh', segment: 'a2' },
    { version: 'vA', zone: 'line', locale: 'yue', segment: 'a3' },
    { version: 'vB', zone: 'line', locale: 'zh', segment: 'b1' },
    { version: 'vB', zone: 'line', locale: 'yue', segment: 'b2' }
  ]
  const valid = [
    { address: 1, gesture: 'tap', zone: 'swirl', entities: [8], scans: ['s2'] },
    { address: 1, gesture: 'sweep', zone: 'line', entities: [2], scans: ['s2'] }
  ]
  const plans = planLocales({ version: 'vA', valid, captions })
  assert.equal(plans.zh.ready, true)
  assert.deepEqual(plans.zh.entries.map(entry => entry.segment).sort(), ['a2', 'a4'])
  assert.equal(plans.yue.ready, false)
  assert.deepEqual(plans.yue.gaps, [{ address: 1, gesture: 'tap', zone: 'swirl' }])
  const all = Object.values(plans).flatMap(plan => plan.entries.map(entry => entry.segment))
  assert.ok(!all.includes('b1') && !all.includes('b2') && !all.includes('a1'))
})

test('来源客户端：资料版钉定与 ETag 复用', async t => {
  const root = await listen(t, createSource())
  const cache = new Map()
  const store = { get: key => cache.get(key), set: (key, value) => cache.set(key, value) }
  const first = await fetchStream(root, 'captions', { edition: 'r1', cache: store })
  assert.equal(first.edition, 'r1')
  assert.ok(first.rows.some(row => row.includes('a1')))
  await fetch(new URL('/control?edition=r2', root), { method: 'POST' })
  const pinned = await fetchStream(root, 'captions', { edition: 'r1', cache: store })
  assert.equal(pinned.fromCache, true)
  assert.ok(pinned.rows.some(row => row.includes('a1')))
  const current = await fetchStream(root, 'captions', { edition: 'r2', cache: store })
  assert.ok(current.rows.some(row => row.includes('a4')))
  assert.ok(!current.rows.some(row => row.includes('a1')))
})

test('采集：丢尾段时找出需重做的手势，可靠区仍可定位', async t => {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  const collected = await collectScans(providerRoot)
  assert.equal(collected.sessions[0].complete, false)
  assert.deepEqual(collected.gaps, [{ scan: 's1', block: 'b', reason: 'missing', detail: '没有相应的资料或操作' }])
  assert.equal(collected.readings.length, 1)
  const scanRows = (await fetchStream(sourceRoot, 'scan', { edition: 'r1' })).rows
    .map(row => ({ panel: row[0], generation: row[1], address: Number(row[2]), gesture: row[3], coord: Number(row[4]), repeat: Number(row[5]) }))
  const { redo, notResampled } = findRedoGestures(collected, scanRows)
  assert.equal(notResampled.length, 0)
  assert.equal(redo.length, 1)
  assert.deepEqual(redo[0].gestures, [
    { address: 1, gesture: 'sweep', coord: 8, repeat: 2 },
    { address: 2, gesture: 'tap', coord: 11, repeat: 1 }
  ])
})

test('采集：重传块去重，旧代扫描号被拒（410）', async t => {
  const root = await listen(t, provider())
  await fetch(new URL('/lab?stage=reversed', root), { method: 'POST' })
  const collected = await collectScans(root)
  assert.equal(collected.sessions[0].complete, true)
  assert.equal(collected.duplicates.length, 1)
  assert.equal(collected.readings.length, 2)
  const ended = await fetchBlock(root, 's1', 'b')
  assert.equal(ended.status, 410)
  assert.equal(ended.error, '安装代已结束')
})

test('流水线：r2 下校准翻面后的触点并按当前窗口选段', async t => {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  await fetch(new URL('/control?edition=r2', sourceRoot), { method: 'POST' })
  await fetch(new URL('/lab?stage=reversed', providerRoot), { method: 'POST' })
  const dir = await mkdtemp(path.join(tmpdir(), 'exhibit-'))
  const store = createStore(dir)
  const collected = await collectScans(providerRoot)
  await store.writeJson('collect-P.json', collected)
  const built = await buildCalibration({ source: sourceRoot, store, replica: 'K' })
  const panel = built.panels.P
  assert.equal(panel.generation, 'B')
  const valid = Object.fromEntries(panel.valid.map(entry => [`${entry.address}:${entry.gesture}`, entry]))
  assert.equal(valid['1:tap'].zone, 'swirl')
  assert.equal(valid['1:sweep'].zone, 'line')
  assert.deepEqual(valid['1:tap'].scans, ['s2'])
  assert.equal(panel.notResampled.length, 1)
  assert.deepEqual(panel.plans.zh.entries.map(entry => entry.segment).sort(), ['a2', 'a4', 'a4'])
  assert.deepEqual(panel.plans.yue.gaps, [{ address: 1, gesture: 'tap', zone: 'swirl' }])
})

test('工具全流程：采集→校准→备用/确认→实况核对', async t => {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  await fetch(new URL('/control?edition=r2', sourceRoot), { method: 'POST' })
  await fetch(new URL('/lab?stage=reversed', providerRoot), { method: 'POST' })
  const dir = await mkdtemp(path.join(tmpdir(), 'exhibit-'))
  const cli = (...args) => run(process.execPath, ['tool/exhibit.mjs', ...args], { cwd: new URL('..', import.meta.url).pathname })

  await cli('collect', '--provider', providerRoot, '--state', dir)
  await cli('calibrate', '--source', sourceRoot, '--replica', 'K', '--state', dir)

  // 台账里留一张翻面前的旧备用票：现场代已换，应停用
  await writeFile(path.join(dir, 'ledger.json'), JSON.stringify({
    staged: [{ panel: 'P', locale: 'zh', generation: 'A', fingerprint: 'old', ticket: 'old-zh', consumed: false }],
    activations: [], deactivated: []
  }))
  const applied = await cli('apply', '--provider', providerRoot, '--state', dir)
  assert.match(applied.stdout, /old-zh 停用/)
  assert.match(applied.stdout, /new-zh 已确认为活动组合/)
  assert.match(applied.stdout, /yue：备用组合写入失败（404 /)
  const ledger = JSON.parse(await readFile(path.join(dir, 'ledger.json'), 'utf8'))
  assert.equal(ledger.deactivated.length, 1)
  assert.equal(ledger.activations.length, 1)
  assert.equal(ledger.activations[0].generation, 'B')

  const status = await cli('status', '--source', sourceRoot, '--provider', providerRoot, '--state', dir)
  assert.match(status.stdout, /当前生效展件 K（代 B，朝向 R）/)
  assert.match(status.stdout, /语种 zh：组合 new-C1（代 B）— 生效/)
  assert.match(status.stdout, /音段 a4（依据 扫描 s2，许可 touch）/)
  assert.match(status.stdout, /语种 yue：组合 old-C2（代 A）— 停滞/)
  assert.match(status.stdout, /追查\[wrong-zone\]/)
  assert.match(status.stdout, /"gesture":"sweep","segment":"a2","expectedZone":"line","segmentZone":"swirl"/)
  const auditLog = (await readFile(path.join(dir, 'audit-log.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(auditLog.length, 1)
  const snapshot = JSON.parse(auditLog[0])
  const kinds = snapshot.panels.P.findings.map(finding => finding.kind)
  assert.ok(kinds.includes('wrong-zone'))
  assert.ok(kinds.includes('stale-segment'))
  assert.ok(kinds.includes('active-stale-generation'))
})
