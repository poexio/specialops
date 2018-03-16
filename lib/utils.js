'use strict'

const bitcore = require('bitcore-lib')
const _ = bitcore.deps._

function Utils () {
}

Utils.prototype.isHexadecimal = function (metadata) {
  if (!_.isString(metadata)) {
    return false
  }
  return /^[0-9a-fA-F]+$/.test(metadata)
}

Utils.prototype.isDecimal = function (data) {
  if (!_.isString(data)) {
    return false
  }
  return /^[0-9]+$/.test(data)
}

Utils.prototype.isHash = function (data) {
  if (data.length !== 64 || !this.isHexadecimal(data)) {
    return false
  }
  return true
}

module.exports = Utils
