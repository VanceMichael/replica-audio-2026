// 状态目录：采集结果、校准结果、备用/激活台账、审计留痕、来源缓存

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

export function createStore(dir) {
  const file = name => path.join(dir, name)

  async function readJson(name, fallback = null) {
    try {
      return JSON.parse(await readFile(file(name), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return fallback
      throw error
    }
  }

  async function writeJson(name, value) {
    await mkdir(dir, { recursive: true })
    await writeFile(file(name), JSON.stringify(value, null, 2) + '\n')
  }

  async function appendJsonl(name, value) {
    await mkdir(dir, { recursive: true })
    await appendFile(file(name), JSON.stringify(value) + '\n')
  }

  // 来源 ETag 缓存
  const cacheFile = 'source-cache.json'
  async function sourceCache() {
    const data = (await readJson(cacheFile)) ?? {}
    return {
      get: key => data[key],
      set: (key, value) => { data[key] = value },
      save: () => writeJson(cacheFile, data)
    }
  }

  return { readJson, writeJson, appendJsonl, sourceCache, file }
}
