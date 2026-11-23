// TP1 触点扫描块：'TP1' 起始，后随若干 6 字节记录
// 记录 = 地址 uint8、手势 uint8、面板坐标 uint16 小端、重复序号 uint16 小端

const MAGIC = Buffer.from('TP1', 'utf8')
const RECORD = 6

export const GESTURE_BY_CODE = new Map([[1, 'tap'], [2, 'sweep']])
export const CODE_BY_GESTURE = new Map([...GESTURE_BY_CODE].map(([code, name]) => [name, code]))

export function parseTp1(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是 TP1 数据块')
  }
  const body = bytes.subarray(MAGIC.length)
  if (body.length % RECORD !== 0) {
    throw new Error(`TP1 数据块长度不完整：剩余 ${body.length} 字节`)
  }
  const readings = []
  for (let offset = 0; offset < body.length; offset += RECORD) {
    const code = body[offset + 1]
    const gesture = GESTURE_BY_CODE.get(code)
    if (gesture === undefined) throw new Error(`未知手势编码 ${code}`)
    readings.push({
      address: body[offset],
      gesture,
      coord: body.readUInt16LE(offset + 2),
      repeat: body.readUInt16LE(offset + 4)
    })
  }
  return readings
}

export function encodeTp1(readings) {
  const body = Buffer.alloc(readings.length * RECORD)
  readings.forEach((reading, index) => {
    const offset = index * RECORD
    body[offset] = reading.address
    body[offset + 1] = CODE_BY_GESTURE.get(reading.gesture)
    body.writeUInt16LE(reading.coord, offset + 2)
    body.writeUInt16LE(reading.repeat, offset + 4)
  })
  return Buffer.concat([MAGIC, body])
}

// 同一扫描号内，地址+手势+坐标+重复序号完全相同的读数视为点相邻区时采到的重复读数
export function readingKey(reading) {
  return [reading.address, reading.gesture, reading.coord, reading.repeat].join('|')
}

export function dedupeReadings(readings) {
  const byKey = new Map()
  const duplicates = []
  for (const reading of readings) {
    const key = readingKey(reading)
    const first = byKey.get(key)
    if (first) {
      first.copies += 1
      duplicates.push(reading)
    } else {
      byKey.set(key, { ...reading, copies: 1 })
    }
  }
  return { unique: [...byKey.values()], duplicates }
}
