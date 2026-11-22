import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('设备代改变使旧扫描尾部消失且播放器拒绝旧备用票', async t => {
  const root = await listen(t)
  await post(root, '/lab?stage=reversed')
  const scan = await (await fetch(root + '/touch/sessions')).json()
  assert.equal(scan[0].sealed, true)
  const next = await fetch(root + '/touch/blocks?scan=s2&block=b')
  assert.equal(Buffer.from(await next.arrayBuffer()).readUInt16LE(5), 16)
  assert.equal((await fetch(root + '/touch/blocks?scan=s1&block=b')).status, 410)
  assert.equal((await post(root, '/player/activate', { ticket: 'old-zh' })).status, 409)
})
