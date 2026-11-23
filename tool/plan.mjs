// 播放组合规划：按既定语种为各纹样选音段
// 只用该展件商定版本在当前资料版里的字幕；不跨展件、跨版本或跨语种借用。

import { createHash } from 'node:crypto'

export function planLocales({ version, valid, captions }) {
  const own = captions.filter(caption => caption.version === version)
  const locales = [...new Set(own.map(caption => caption.locale))].sort()
  const plans = {}
  for (const locale of locales) {
    const entries = []
    const gaps = []
    for (const mapping of valid) {
      const caption = own.find(row => row.zone === mapping.zone && row.locale === locale)
      if (caption) {
        entries.push({
          address: mapping.address,
          gesture: mapping.gesture,
          zone: mapping.zone,
          segment: caption.segment,
          scans: mapping.scans
        })
      } else {
        gaps.push({ address: mapping.address, gesture: mapping.gesture, zone: mapping.zone })
      }
    }
    plans[locale] = {
      locale,
      entries,
      gaps,
      ready: gaps.length === 0 && entries.length > 0,
      fingerprint: fingerprintEntries(entries)
    }
  }
  return plans
}

export function fingerprintEntries(entries) {
  const canonical = entries
    .map(entry => `${entry.address}:${entry.gesture}:${entry.zone}:${entry.segment}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
