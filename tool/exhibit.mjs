#!/usr/bin/env node
// 布展校准工具：重采触点、校准朝向、按语种配置播放器、核对播放实况
//
// 用法：
//   node tool/exhibit.mjs collect   --provider http://127.0.0.1:8701 [--panel P] [--state var]
//   node tool/exhibit.mjs calibrate --source http://127.0.0.1:8700 --replica K [--edition r2] [--state var]
//   node tool/exhibit.mjs apply     --provider http://127.0.0.1:8701 [--state var]
//   node tool/exhibit.mjs status    --source http://127.0.0.1:8700 --provider http://127.0.0.1:8701 [--panel P] [--state var]

import { collectScans } from './collect.mjs'
import { buildCalibration } from './pipeline.mjs'
import { fetchSessions, fetchActive, stageConfig, activateConfig } from './clients.mjs'
import { auditPanel } from './audit.mjs'
import { createStore } from './store.mjs'

const GESTURE_NAME = { tap: '点击', sweep: '划动' }

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const next = argv[index + 1]
      args[token.slice(2)] = next !== undefined && !next.startsWith('--') ? (index += 1, next) : true
    } else {
      args._.push(token)
    }
  }
  return args
}

function need(args, ...names) {
  for (const name of names) {
    if (!args[name]) throw new Error(`缺少参数 --${name}`)
  }
}

const gestureList = gestures => gestures
  .map(item => `地址${item.address} ${GESTURE_NAME[item.gesture] ?? item.gesture}@${item.coord}`)
  .join('、')

// ---- collect：对一块板发起实际扫描采集 ----

async function cmdCollect(args) {
  need(args, 'provider')
  const store = createStore(args.state ?? 'var')
  const collected = await collectScans(args.provider, { panel: args.panel })
  for (const session of collected.sessions) {
    await store.writeJson(`collect-${session.panel}.json`, collected)
    const state = session.complete ? '完整' : '不完整（丢尾段或缺块）'
    console.log(`面板 ${session.panel} 代 ${session.generation} 扫描 ${session.scan}：${state}`)
    for (const block of session.blocks) {
      console.log(`  块 ${block.block}：${block.status === 'ok' ? `${block.readings} 条读数` : block.status}`)
    }
  }
  if (collected.duplicates.length > 0) {
    console.log(`合并重复读数 ${collected.duplicates.length} 条（点相邻区时采到）`)
  }
  if (collected.gaps.length > 0) {
    console.log(`缺口 ${collected.gaps.length} 处：${collected.gaps.map(gap => `${gap.scan}/${gap.block}(${gap.reason})`).join('、')}`)
  }
  console.log(`实采读数 ${collected.readings.length} 条，已写入 ${store.file('collect-<面板>.json')}`)
}

// ---- calibrate：校准朝向与解释区，给出各语种可开情况 ----

async function cmdCalibrate(args) {
  need(args, 'source', 'replica')
  const store = createStore(args.state ?? 'var')
  const built = await buildCalibration({
    source: args.source,
    store,
    replica: args.replica,
    edition: args.edition,
    panel: args.panel
  })
  await store.writeJson('calibration-index.json', Object.keys(built.panels))
  for (const [panel, result] of Object.entries(built.panels)) {
    await store.writeJson(`calibration-${panel}.json`, result)
    console.log(`面板 ${panel} 代 ${result.generation} 朝向 ${result.orientation}（资料版 ${result.edition}，展件 ${result.replica} 版本 ${result.version}）`)
    console.log('可用触点范围：')
    for (const entry of result.valid) {
      const scans = entry.scans.length ? `扫描 ${entry.scans.join('/')}` : '维护台记录'
      console.log(`  地址${entry.address} ${GESTURE_NAME[entry.gesture]} → ${entry.zone} 区（实体坐标 ${entry.entities.join('/')}，依据 ${scans}）`)
    }
    for (const span of result.range) {
      console.log(`  ${span.zone} 区覆盖实体坐标 [${span.span[0]}, ${span.span[1]}]`)
    }
    if (result.review.length > 0) {
      console.log('待复核读数：')
      for (const item of result.review) {
        console.log(`  地址${item.address} ${GESTURE_NAME[item.gesture]}@${item.coord}（实体 ${item.entity}）：${item.reason}${item.zones.length ? ' ' + item.zones.join('/') : ''}`)
      }
    }
    for (const entry of result.redo) {
      console.log(`需重做手势（扫描 ${entry.scan} 不完整）：${gestureList(entry.gestures)}`)
    }
    for (const entry of result.notResampled) {
      console.log(`本轮未重采（可按记录定位）：${gestureList(entry.gestures)}`)
    }
    console.log('语种组合：')
    for (const plan of Object.values(result.plans)) {
      const state = plan.ready ? '可开' : plan.entries.length ? '可开（有缺口）' : '不可开'
      console.log(`  ${plan.locale}：${state}，指纹 ${plan.fingerprint}`)
      for (const entry of plan.entries) {
        console.log(`    地址${entry.address} ${GESTURE_NAME[entry.gesture]} → ${entry.zone} → 音段 ${entry.segment}`)
      }
      for (const gap of plan.gaps) {
        console.log(`    缺音段：${gap.zone} 区（地址${gap.address} ${GESTURE_NAME[gap.gesture]}），不借用其他展件配置`)
      }
    }
  }
}

// ---- apply：先装备用组合，再确认活动组合 ----

async function cmdApply(args) {
  need(args, 'provider')
  const store = createStore(args.state ?? 'var')
  const ledger = (await store.readJson('ledger.json')) ?? { staged: [], activations: [], deactivated: [] }
  const sessions = await fetchSessions(args.provider)
  const active = await fetchActive(args.provider)

  // 现场代已换：旧备用组合重新核对，对不上的停用
  for (const entry of ledger.staged.filter(item => !item.consumed && !item.deactivated)) {
    const session = sessions.find(item => item.panel === entry.panel)
    if (!session || session.generation !== entry.generation) {
      entry.deactivated = true
      ledger.deactivated.push({ ...entry, reason: '现场代已换，旧备用组合停用', at: new Date().toISOString() })
      console.log(`面板 ${entry.panel} ${entry.locale}：备用票 ${entry.ticket} 停用（现场代已换）`)
    }
  }

  const panels = (await store.readJson('calibration-index.json')) ?? []
  for (const panel of panels) {
    const calibration = await store.readJson(`calibration-${panel}.json`)
    if (!calibration) continue
    const session = sessions.find(item => item.panel === panel && item.generation === calibration.generation)
    if (!session) {
      console.log(`面板 ${panel}：现场代与校准（${calibration.generation}）不符，请重新 collect/calibrate`)
      continue
    }
    for (const plan of Object.values(calibration.plans)) {
      if (plan.entries.length === 0) {
        console.log(`面板 ${panel} ${plan.locale}：无可配置触发，跳过`)
        continue
      }
      const already = active.find(row => row.locale === plan.locale && row.generation === calibration.generation)
      const activated = ledger.activations.find(entry =>
        entry.panel === panel && entry.locale === plan.locale &&
        entry.generation === calibration.generation && entry.fingerprint === plan.fingerprint)
      if (already && activated && !already.blocked) {
        console.log(`面板 ${panel} ${plan.locale}：活动组合已生效（${already.config}），跳过`)
        continue
      }
      const staged = await stageConfig(args.provider, {
        locale: plan.locale,
        generation: calibration.generation,
        config: plan.fingerprint
      })
      if (staged.status !== 201) {
        console.log(`面板 ${panel} ${plan.locale}：备用组合写入失败（${staged.status}${staged.error ? ' ' + staged.error : ''}），其余语种继续`)
        continue
      }
      ledger.staged.push({
        panel, locale: plan.locale, generation: calibration.generation,
        fingerprint: plan.fingerprint, ticket: staged.ticket, consumed: false
      })
      const confirmed = await activateConfig(args.provider, staged.ticket)
      if (confirmed.status === 409) {
        ledger.staged.at(-1).deactivated = true
        ledger.deactivated.push({ panel, locale: plan.locale, ticket: staged.ticket, reason: confirmed.error ?? '备选与当前安装代不符', at: new Date().toISOString() })
        console.log(`面板 ${panel} ${plan.locale}：备用票 ${staged.ticket} 与现场代不符（409），已停用，请重新核对后再办`)
        continue
      }
      if (confirmed.status !== 202) {
        console.log(`面板 ${panel} ${plan.locale}：确认失败（${confirmed.status}），其余语种继续`)
        continue
      }
      ledger.staged.at(-1).consumed = true
      ledger.activations.push({
        panel, locale: plan.locale, generation: calibration.generation,
        fingerprint: plan.fingerprint, ticket: staged.ticket,
        entries: plan.entries, at: new Date().toISOString()
      })
      console.log(`面板 ${panel} ${plan.locale}：备用票 ${staged.ticket} 已确认为活动组合（指纹 ${plan.fingerprint}）`)
    }
  }
  await store.writeJson('ledger.json', ledger)
}

// ---- status：播放实况核对与错区追查 ----

async function cmdStatus(args) {
  need(args, 'source', 'provider')
  const store = createStore(args.state ?? 'var')
  const built = await buildCalibration({
    source: args.source,
    store,
    replica: args.replica,
    edition: args.edition,
    panel: args.panel
  })
  // 提供方（播放器）只覆盖有扫描会话的面板；其余面板无播放实况可读
  const covered = new Set((await fetchSessions(args.provider)).map(session => session.panel))
  const active = await fetchActive(args.provider)
  const ledger = await store.readJson('ledger.json')

  const snapshot = { at: new Date().toISOString(), edition: built.edition, panels: {} }
  for (const [panel, calibration] of Object.entries(built.panels)) {
    const install = built.records.install.find(row => row.panel === panel && row.generation === calibration.generation)
    const audit = auditPanel({
      panel,
      install,
      calibration,
      plans: calibration.plans,
      captions: built.records.captions,
      delivered: built.records.delivered.filter(row => row.panel === panel),
      active: covered.has(panel) ? active : [],
      ledger
    })
    snapshot.panels[panel] = audit
    console.log(`面板 ${panel}：当前生效展件 ${audit.exhibit.replica}（代 ${audit.exhibit.generation}，朝向 ${audit.exhibit.orientation}）`)
    for (const row of audit.active) {
      const state = { active: '生效', blocked: '被阻止', 'stale-generation': '停滞（现场代已换）' }[row.status] ?? row.status
      console.log(`  语种 ${row.locale}：组合 ${row.config}（代 ${row.generation}）— ${state}`)
      for (const support of row.support) {
        const scans = support.scans.length ? `扫描 ${support.scans.join('/')}` : '维护台记录'
        console.log(`    地址${support.address} ${GESTURE_NAME[support.gesture]} → ${support.zone} → 音段 ${support.segment}（依据 ${scans}，许可 ${support.permission}）`)
      }
    }
    for (const finding of audit.findings) {
      console.log(`  追查[${finding.kind}]：${JSON.stringify(finding.facts)} → ${finding.action}`)
    }
  }
  await store.appendJsonl('audit-log.jsonl', snapshot)
  console.log(`审计快照已追加到 ${store.file('audit-log.jsonl')}`)
}

// ---- 入口 ----

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const commands = { collect: cmdCollect, calibrate: cmdCalibrate, apply: cmdApply, status: cmdStatus }

if (!commands[command]) {
  console.error('用法：node tool/exhibit.mjs <collect|calibrate|apply|status> [--source URL] [--provider URL] [--replica R] [--panel P] [--edition E] [--state DIR]')
  process.exit(2)
}

commands[command](args).catch(error => {
  console.error(`执行失败：${error.message}`)
  process.exit(1)
})
