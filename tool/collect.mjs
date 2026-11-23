// 实际扫描采集：会话 → 分块 → TP1 读数
// 处理：分批到达、同扫描号块重传、重复读数、半途重装（410）、丢尾段（缺口/传输中断）

import { fetchSessions, fetchBlock } from './clients.mjs'
import { parseTp1, dedupeReadings } from './tp1.mjs'

export async function collectScans(provider, { panel } = {}) {
  const sessions = (await fetchSessions(provider)).filter(session => !panel || session.panel === panel)
  const readings = []
  const gaps = []
  const reports = []

  for (const session of sessions) {
    const blocks = []
    for (const name of session.blocks) {
      const result = await fetchBlock(provider, session.scan, name)
      if (result.status === 200) {
        let parsed
        try {
          parsed = parseTp1(result.buffer)
        } catch (error) {
          gaps.push({ scan: session.scan, block: name, reason: 'corrupt', detail: error.message })
          blocks.push({ block: name, status: 'corrupt' })
          continue
        }
        readings.push(...parsed.map(reading => ({
          ...reading,
          panel: session.panel,
          generation: session.generation,
          scan: session.scan,
          block: name
        })))
        blocks.push({ block: name, status: 'ok', readings: parsed.length })
      } else if (result.status === 410) {
        // 扫描号不能跨代使用：该次安装代已结束
        gaps.push({ scan: session.scan, block: name, reason: 'generation-ended', detail: result.error })
        blocks.push({ block: name, status: 'generation-ended' })
      } else if (result.status === 404) {
        gaps.push({ scan: session.scan, block: name, reason: 'missing', detail: result.error })
        blocks.push({ block: name, status: 'missing' })
      } else {
        gaps.push({ scan: session.scan, block: name, reason: 'dropped', detail: result.error })
        blocks.push({ block: name, status: 'dropped' })
      }
    }
    const sessionGaps = gaps.filter(gap => gap.scan === session.scan)
    reports.push({
      panel: session.panel,
      generation: session.generation,
      scan: session.scan,
      sealed: session.sealed,
      blocks,
      complete: Boolean(session.sealed) && sessionGaps.length === 0
    })
  }

  const { unique, duplicates } = dedupeReadings(readings)
  return { sessions: reports, readings: unique, duplicates, gaps }
}

// 与维护台记录（来源 scan 流）对照：本次扫描未覆盖且会话不完整的手势需重做；
// 会话完整时未重采的读数仍可按记录供值班定位。
export function findRedoGestures(collected, recorded) {
  const redo = []
  const notResampled = []
  for (const session of collected.sessions) {
    const expected = recorded.filter(row =>
      row.panel === session.panel && row.generation === session.generation)
    const missing = expected.filter(row =>
      !collected.readings.some(reading =>
        reading.scan === session.scan &&
        reading.address === row.address && reading.gesture === row.gesture &&
        reading.coord === row.coord && reading.repeat === row.repeat))
    const entry = {
      panel: session.panel,
      generation: session.generation,
      scan: session.scan,
      gestures: missing.map(({ address, gesture, coord, repeat }) => ({ address, gesture, coord, repeat }))
    }
    if (entry.gestures.length === 0) continue
    if (session.complete) notResampled.push(entry)
    else redo.push(entry)
  }
  return { redo, notResampled }
}
