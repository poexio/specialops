'use strict'

function Encoding (servicePrefix) {
  // servicePrefix: 2 bytes
  this._servicePrefix = servicePrefix
  this._metadataPrefix = Buffer.from('00', 'hex')
}

// NOTE: code from bitcore-node utils.js
Encoding.prototype.encodeTip = function (tip, name) {
  const DB_PREFIX = Buffer.from('ffff', 'hex')
  const key = Buffer.concat([DB_PREFIX,
    Buffer.from('tip-' + name, 'utf8')])

  let heightBuf = Buffer.alloc(4)
  heightBuf.writeUInt32BE(tip.height)

  const value = Buffer.concat([heightBuf, Buffer.from(tip.hash, 'hex')])
  return {key: key, value: value}
}

Encoding.prototype.encodeMetadataKey = function (data, fill) {
  if (!fill) {
    fill = 0
  }
  let metadataBuf = Buffer.alloc(80, fill)
  let metadataLenBuf = Buffer.alloc(1, fill)
  if (data.metadata) {
    if (data.metadata.length % 2) {
      data.metadata += (fill & 0xf).toString(16)
    }
    metadataBuf.write(data.metadata, 'hex')
    metadataLenBuf.writeUInt8(data.metadata.length >> 1)
  }
  let heightBuf = Buffer.alloc(4, fill)
  if (data.height) {
    heightBuf.writeInt32BE(data.height)
  }
  let txidBuf = Buffer.alloc(32, fill)
  if (data.txid) {
    txidBuf.write(data.txid, 'hex')
  }
  let outputIndexBuf = Buffer.alloc(4, fill)
  if (data.outputIndex) {
    outputIndexBuf.writeInt32BE(data.outputIndex)
  }

  return Buffer.concat([
    this._servicePrefix,
    this._metadataPrefix,
    metadataBuf,
    heightBuf,
    txidBuf,
    outputIndexBuf,
    metadataLenBuf])
}

Encoding.prototype.decodeMetadataKey = function (buffer) {
  const prefixLen = 3
  const metadataLen = buffer.readUInt8(prefixLen + 80 + 4 + 32 + 4)
  const metadata = buffer.slice(prefixLen, prefixLen + metadataLen).toString('hex')
  const height = buffer.readUInt32BE(prefixLen + 80)
  const txid = buffer.slice(prefixLen + 84, prefixLen + 116).toString('hex')
  const outputIndex = buffer.readUInt32BE(prefixLen + 116)

  return {
    metadata: metadata,
    blockheight: height,
    txid: txid,
    outputIndex: outputIndex
  }
}

Encoding.prototype.convertKeyToCursor = function (key) {
  return [key.metadata, key.blockheight, key.txid, key.outputIndex].join('-')
}

Encoding.prototype.convertCursorToKey = function (cursor, fill) {
  const keyArr = cursor.split('-')
  const data = {
    metadata: keyArr[0],
    height: keyArr[1],
    txid: keyArr[2],
    outputIndex: keyArr[3]
  }
  return this.encodeMetadataKey(data, fill)
}

Encoding.prototype.isValidCursor = function (cursor) {
  return /^[A-Fa-f0-9-]+$/.test(cursor)
}

Encoding.prototype.encodeHash = function (hash) {
  return Buffer.from(hash, 'hex')
}

Encoding.prototype.encodeShortCursor = function (metadata, penultimateKey, lastKey) {
  // Find the shortest key substring to act as the cursor
  let a = this.convertKeyToCursor(this.decodeMetadataKey(penultimateKey))
  let b = this.convertKeyToCursor(this.decodeMetadataKey(lastKey))
  let i = 0
  let l = a.length

  while (i < l && a.charAt(i) === b.charAt(i)) i++

  // remove metadata from the key
  const lastCursor = b.substring(metadata.length, i + 1)
  return encodeURIComponent(Buffer.from(lastCursor).toString('base64'))
}

Encoding.prototype.decodeShortCursor = function (metadata, shortCursor) {
  return metadata + Buffer.from(shortCursor, 'base64').toString()
}

module.exports = Encoding
