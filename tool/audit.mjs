// 播放实况核对：当前生效的展件/手势/语种，以及支撑配置的扫描与许可；
// 发现错区或停滞配置时保留事实、给出处置。

// captions：当前资料版的字幕记录；segmentIndex 由调用方预建可跨版本查找时另传
export function auditPanel({
  panel,
  install,          // 该面板当前代安装记录
  calibration,      // 当前代校准结果
  plans,            // 本工具规划的语种组合
  captions,         // 当前资料版字幕
  delivered,        // 来源 delivered 流（该面板）
  active,           // /player/active 读回
  ledger            // 本工具备用/激活台账
}) {
  const findings = []
  const captionBySegment = new Map(captions.map(caption => [caption.segment, caption]))
  const mappingByTrigger = new Map(
    (calibration?.valid ?? []).map(entry => [`${entry.address}|${entry.gesture}`, entry]))

  // 已下发触发在当前代下是否播错区
  const triggers = delivered.map(row => {
    const current = mappingByTrigger.get(`${row.address}|${row.gesture}`)
    const caption = captionBySegment.get(row.segment)
    const facts = { ...row, expectedZone: current?.zone ?? null, segmentZone: caption?.zone ?? null }
    if (install && row.generation !== install.generation) {
      findings.push({
        kind: 'stale-generation',
        action: 'stop-trigger',
        facts: { ...facts, currentGeneration: install.generation }
      })
    }
    if (!caption) {
      findings.push({ kind: 'stale-segment', action: 'stop-trigger', facts })
    } else if (current && caption.zone !== current.zone) {
      findings.push({
        kind: 'wrong-zone',
        action: 'stop-trigger',
        facts: { ...facts, expectedZone: current.zone, segmentZone: caption.zone }
      })
    }
    return {
      address: row.address,
      gesture: row.gesture,
      segment: row.segment,
      generation: row.generation,
      status: !caption ? 'stale-segment'
        : (install && row.generation !== install.generation) ? 'stale-generation'
        : (current && caption.zone !== current.zone) ? 'wrong-zone'
        : 'ok'
    }
  })

  // 活动组合逐语种核对
  const activeRows = active.map(row => {
    const staged = ledger?.activations?.find(entry =>
      entry.locale === row.locale && entry.generation === row.generation)
    const staleGeneration = install && row.generation !== install.generation
    if (staleGeneration || row.blocked) {
      findings.push({
        kind: staleGeneration ? 'active-stale-generation' : 'active-blocked',
        action: 're-stage-or-deactivate',
        facts: { ...row, currentGeneration: install?.generation ?? null }
      })
    }
    // 支撑依据只来自本工具台账中同语种同代的激活记录；
    // 停滞或被阻止的旧组合不挂新规划的依据
    const support = (staleGeneration || row.blocked ? [] : (staged?.entries ?? [])).map(entry => ({
      address: entry.address,
      gesture: entry.gesture,
      zone: entry.zone,
      segment: entry.segment,
      scans: entry.scans ?? [],
      permission: 'touch'
    }))
    return {
      locale: row.locale,
      generation: row.generation,
      config: row.config,
      blocked: Boolean(row.blocked),
      status: staleGeneration ? 'stale-generation' : row.blocked ? 'blocked' : 'active',
      support
    }
  })

  return {
    panel,
    exhibit: install ? { replica: install.replica, generation: install.generation, orientation: install.orientation } : null,
    active: activeRows,
    triggers,
    findings
  }
}
