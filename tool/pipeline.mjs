// 组装：来源记录 + 实采读数 → 校准 → 语种组合

import { fetchRecords } from './records.mjs'
import { findRedoGestures } from './collect.mjs'
import { calibratePanel } from './calibrate.mjs'
import { planLocales } from './plan.mjs'

// 读取某面板某代的全部可用读数：维护台记录（无扫描号）∪ 实采（带扫描号）
function readingsFor(records, collected, panel, generation) {
  const recorded = records.scan
    .filter(row => row.panel === panel && row.generation === generation)
    .map(row => ({ ...row, scan: null }))
  const live = (collected?.readings ?? [])
    .filter(row => row.panel === panel && row.generation === generation)
  // 实采与记录重复时以实采为准（保留扫描号溯源）
  const liveKeys = new Set(live.map(row =>
    [row.address, row.gesture, row.coord, row.repeat].join('|')))
  return [
    ...live,
    ...recorded.filter(row =>
      !liveKeys.has([row.address, row.gesture, row.coord, row.repeat].join('|')))
  ]
}

// replica 省略时处理当前资料版里的全部安装
export async function buildCalibration({ source, store, replica, edition, panel }) {
  const cache = await store.sourceCache()
  const { edition: actualEdition, records } = await fetchRecords(source, { edition, cache })
  await cache.save()

  const installs = records.install.filter(row =>
    (!replica || row.replica === replica) && (!panel || row.panel === panel))
  if (installs.length === 0) {
    throw new Error(`资料版 ${actualEdition} 中没有符合条件的安装记录（展件 ${replica ?? '全部'}）`)
  }

  const panels = {}
  for (const install of installs) {
    const zones = records.replicas.filter(row => row.replica === install.replica)
    if (zones.length === 0) throw new Error(`资料版 ${actualEdition} 中没有展件 ${install.replica}`)
    const version = zones[0].version
    const collected = await store.readJson(`collect-${install.panel}.json`)
    const readings = readingsFor(records, collected, install.panel, install.generation)
    const calibration = calibratePanel(install, zones, readings)
    const { redo, notResampled } = collected
      ? findRedoGestures(collected, records.scan)
      : { redo: [], notResampled: [] }
    const plans = planLocales({ version, valid: calibration.valid, captions: records.captions })
    panels[install.panel] = {
      ...calibration,
      version,
      edition: actualEdition,
      redo: redo.filter(entry => entry.panel === install.panel),
      notResampled: notResampled.filter(entry => entry.panel === install.panel),
      plans
    }
  }
  return { edition: actualEdition, records, panels }
}
