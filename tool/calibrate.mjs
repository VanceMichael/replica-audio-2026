// 校准核心（纯函数）：朝向换算、解释区判定、相交区分辨证据、可用触点范围

// 方向 R 时实体坐标 = 位宽 − 面板坐标；L 时一致
export function entityCoordinate(coord, width, orientation) {
  return orientation === 'R' ? width - coord : coord
}

export function zonesAt(zones, entity) {
  const containing = zones.filter(zone => zone.left <= entity && entity < zone.right)
  return {
    touch: containing.filter(zone => zone.permission === 'touch'),
    view: containing.filter(zone => zone.permission !== 'touch')
  }
}

export function intervalsIntersect(a, b) {
  return a.left < b.right && b.left < a.right
}

// 单条读数分类：
// - 恰好落在一个可触区且不与只读区重叠 → 候选有效
// - 落在只读区（含与可触区重叠，只读区重叠时不得触发）→ 待复核
// - 同时可能属于两个可触区 → 待复核
function classify(reading, zones, install) {
  const entity = entityCoordinate(reading.coord, install.width, install.orientation)
  const at = zonesAt(zones, entity)
  const base = { ...reading, entity }
  if (at.view.length > 0) {
    return { ...base, status: 'review', reason: 'no-touch-zone', zones: at.view.map(zone => zone.zone) }
  }
  if (at.touch.length > 1) {
    return { ...base, status: 'review', reason: 'ambiguous-zones', zones: at.touch.map(zone => zone.zone) }
  }
  if (at.touch.length === 1) {
    return { ...base, status: 'candidate', zone: at.touch[0].zone }
  }
  return { ...base, status: 'review', reason: 'outside-zones', zones: [] }
}

// 地址级分辨证据：该地址触到的可触区若相交，需看到不同手势的两条读数、
// 分别落在允许的单区部分，才有区分证据；否则候选降级为待复核。
function addressEvidence(addressReadings, zonesByName) {
  const candidates = addressReadings.filter(reading => reading.status === 'candidate')
  const touched = [...new Set(candidates.map(reading => reading.zone))]
  const intersects = touched.some((name, index) =>
    touched.slice(index + 1).some(other => intervalsIntersect(zonesByName.get(name), zonesByName.get(other))))
  if (!intersects) return { needed: false, held: true }
  const held = candidates.some((first, index) =>
    candidates.slice(index + 1).some(second =>
      first.gesture !== second.gesture && first.zone !== second.zone))
  return { needed: true, held }
}

// 校准一块面板的一代安装。readings 需带 panel/generation，可带 scan（哪次扫描采到）。
export function calibratePanel(install, zones, readings) {
  const zonesByName = new Map(zones.map(zone => [zone.zone, zone]))
  const classified = readings.map(reading => classify(reading, zones, install))

  const byAddress = new Map()
  for (const reading of classified) {
    if (!byAddress.has(reading.address)) byAddress.set(reading.address, [])
    byAddress.get(reading.address).push(reading)
  }

  const evidence = {}
  for (const [address, group] of byAddress) {
    const result = addressEvidence(group, zonesByName)
    evidence[address] = result
    if (result.needed && !result.held) {
      for (const reading of group) {
        if (reading.status === 'candidate') {
          reading.status = 'review'
          reading.reason = 'insufficient-evidence'
          reading.zones = [reading.zone]
          delete reading.zone
        }
      }
    }
  }

  // 同地址同手势的多条读数必须落在同一区，否则冲突待复核
  const byTrigger = new Map()
  for (const reading of classified) {
    if (reading.status !== 'candidate') continue
    const key = `${reading.address}|${reading.gesture}`
    if (!byTrigger.has(key)) byTrigger.set(key, [])
    byTrigger.get(key).push(reading)
  }
  const valid = []
  const review = classified.filter(reading => reading.status === 'review')
  for (const group of byTrigger.values()) {
    const zonesHit = [...new Set(group.map(reading => reading.zone))]
    if (zonesHit.length > 1) {
      for (const reading of group) {
        review.push({ ...reading, status: 'review', reason: 'conflicting-zones', zones: zonesHit, zone: undefined })
      }
      continue
    }
    const first = group[0]
    valid.push({
      address: first.address,
      gesture: first.gesture,
      zone: first.zone,
      entities: [...new Set(group.map(reading => reading.entity))].sort((a, b) => a - b),
      scans: [...new Set(group.map(reading => reading.scan).filter(Boolean))].sort()
    })
  }
  valid.sort((a, b) => a.address - b.address || a.gesture.localeCompare(b.gesture))

  // 可用触点范围：各命名区在当前朝向下被有效读数覆盖的实体坐标跨度
  const range = [...new Set(valid.map(entry => entry.zone))].sort().map(name => {
    const entities = valid.filter(entry => entry.zone === name).flatMap(entry => entry.entities)
    return { zone: name, span: [Math.min(...entities), Math.max(...entities)] }
  })

  return {
    panel: install.panel,
    venue: install.venue,
    generation: install.generation,
    replica: install.replica,
    orientation: install.orientation,
    width: install.width,
    valid,
    review: review.map(reading => ({
      address: reading.address,
      gesture: reading.gesture,
      coord: reading.coord,
      entity: reading.entity,
      reason: reading.reason,
      zones: reading.zones ?? [],
      scan: reading.scan ?? null
    })),
    evidence,
    range
  }
}
