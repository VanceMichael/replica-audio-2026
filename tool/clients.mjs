// 来源与外部接口的 HTTP 客户端
// 来源：资料版钉定、逐页领取、ETag 条件请求
// 外部接口：扫描会话/块、播放器备用与活动组合

async function request(url, { method = 'GET', headers = {}, payload } = {}) {
  const init = { method, headers: { ...headers } }
  if (payload !== undefined) {
    init.body = JSON.stringify(payload)
    init.headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(url, init)
  return response
}

async function requestJson(url, options) {
  const response = await request(url, options)
  const text = await response.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  return { status: response.status, headers: response.headers, data }
}

// ---- 来源 ----

export async function fetchCatalog(root) {
  const { status, data } = await requestJson(new URL('/catalog', root))
  if (status !== 200) throw new Error(`目录获取失败：${status}`)
  return data
}

// 拉取一个数据流的全部页。edition 钉定资料版；cache 为可选的
// { get(key), set(key, value) }，用 If-None-Match 复用未变更的行。
export async function fetchStream(root, stream, { edition, cache } = {}) {
  const url = new URL('/records/' + stream, root)
  if (edition) url.searchParams.set('edition', edition)
  const cacheKey = `${edition ?? ''}|${stream}`
  const cached = cache?.get(cacheKey)
  const headers = {}
  if (cached?.etag) headers['If-None-Match'] = cached.etag

  const rows = []
  let etag = null
  let actualEdition = edition ?? null
  for (;;) {
    const response = await request(url, { headers: etag ? {} : headers })
    if (response.status === 304 && cached) {
      return { edition: cached.edition, etag: cached.etag, rows: cached.rows, fromCache: true }
    }
    if (response.status !== 200) {
      throw new Error(`数据流 ${stream} 获取失败：${response.status} ${await response.text()}`)
    }
    const pageEdition = response.headers.get('X-Edition')
    if (actualEdition && pageEdition !== actualEdition) {
      throw new Error(`资料版在分页间变动：${actualEdition} → ${pageEdition}`)
    }
    actualEdition = pageEdition
    if (!etag) etag = response.headers.get('ETag')
    const text = await response.text()
    rows.push(...text.split('\n').filter(Boolean).map(line => line.split('\t')))
    const link = response.headers.get('Link')
    const next = link && /^<([^>]+)>;\s*rel="next"/.exec(link)
    if (!next) break
    url.pathname = new URL(next[1], root).pathname
    url.search = new URL(next[1], root).search
  }
  cache?.set(cacheKey, { edition: actualEdition, etag, rows })
  return { edition: actualEdition, etag, rows, fromCache: false }
}

// ---- 外部接口（扫描台与播放器） ----

export async function fetchSessions(provider) {
  const { status, data } = await requestJson(new URL('/touch/sessions', provider))
  if (status !== 200) throw new Error(`扫描会话获取失败：${status}`)
  return data
}

// 返回 { status, buffer? , error? }；status 0 表示传输中断（丢尾段）
export async function fetchBlock(provider, scan, block) {
  const url = new URL('/touch/blocks', provider)
  url.searchParams.set('scan', scan)
  url.searchParams.set('block', block)
  try {
    const response = await fetch(url)
    if (response.status !== 200) {
      let error = null
      try { error = (await response.json()).error ?? null } catch { /* 无正文 */ }
      return { status: response.status, error }
    }
    return { status: 200, buffer: Buffer.from(await response.arrayBuffer()) }
  } catch (error) {
    return { status: 0, error: `传输中断：${error.cause?.code ?? error.message}` }
  }
}

export async function fetchActive(provider) {
  const { status, data } = await requestJson(new URL('/player/active', provider))
  if (status === 404) return []
  if (status !== 200) throw new Error(`播放实况获取失败：${status}`)
  return data
}

export async function stageConfig(provider, { locale, generation, config }) {
  const { status, data } = await requestJson(new URL('/player/stage', provider), {
    method: 'POST',
    payload: { locale, generation, config }
  })
  return { status, ticket: data?.ticket ?? null, error: data?.error ?? null }
}

export async function activateConfig(provider, ticket) {
  const { status, data } = await requestJson(new URL('/player/activate', provider), {
    method: 'POST',
    payload: { ticket }
  })
  return { status, state: data?.state ?? null, error: data?.error ?? null }
}
