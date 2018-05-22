'use strict'

const BaseService = require('./service')
const inherits = require('util').inherits
const async = require('async')
const bitcore = require('bitcore-lib')
const Script = bitcore.Script
const protocols = require('../data/protocols.json')
const Utils = require('./utils')
const Encoding = require('./encoding')

function enableCors (response) {
  // A convenience function to ensure
  // the response object supports cross-origin requests
  response.set('Access-Control-Allow-Origin', '*')
  response.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT')
  response.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
}

function OpcodeService (options) {
  if (!(this instanceof OpcodeService)) {
    return new OpcodeService(options)
  }

  BaseService.call(this, options)

  this.tip = null
  this.lastBlock = {}
  this._header = this.node.services.header
  this._block = this.node.services.block
  this._db = this.node.services.db
  this.log = this.node.log
}

inherits(OpcodeService, BaseService)

OpcodeService.dependencies = ['header', 'block', 'transaction', 'db']

OpcodeService.prototype.loadTip = function (callback) {
  const self = this

  self._db.getServiceTip(self.name, function (err, tipData) {
    if (err) {
      return callback(err)
    }

    self.tip = tipData
    const headerArg = (self.tip.height === 0) ? self.tip.height : self.tip.hash
    self.node.getBlockHeader(headerArg, function (err, blockHeader) {
      if (err) {
        return callback(err)
      }
      if (!blockHeader) {
        return callback(new Error('Could not get height for tip.'))
      }
      self.tip.hash = blockHeader.hash
      self.lastBlock.prevHash = blockHeader.prevHash
      callback()
    })
  })
}

/**
 * Connects a block to the database and add indexes
 * @param {Block} block - The bitcore block
 * @param {Function} callback
 */
OpcodeService.prototype.connectBlock = function (block, callback) {
  this.log.info('adding block', block.hash, block.height)
  this.blockHandler(block, true, callback)
}

/**
 * Disconnects a block from the database and removes indexes
 * @param {Block} block - The bitcore block
 * @param {Function} callback
 */
OpcodeService.prototype.disconnectBlock = function (block, callback) {
  this.log.info('disconnecting block', block.hash, block.height)
  this.blockHandler(block, false, callback)
}

OpcodeService.prototype.blockHandler = function (block, add, callback) {
  /*
    The code below stores any transactions with metadata into a level db
    in a single atomic operation.
  */
  const self = this
  let operations = []

  self.tip.hash = add ? block.hash : block.prevHash
  self.tip.height = block.height
  const tipOps = self._encoding.encodeTip(self.tip, self.name)

  operations.push({
    type: 'put',
    key: tipOps.key,
    value: tipOps.value
  })

  const txs = block.txs
  if (txs) {
    // Loop through every transaction in the block
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i]
      const txid = tx.txid()

      // Loop through every output in the transaction
      for (let outputIndex = 0; outputIndex < tx.outputs.length; outputIndex++) {
        const output = tx.outputs[outputIndex]
        let script = null
        try {
          script = new Script(output.script.raw.toString('hex'))
        } catch (err) {
          self.log.warn(err)
        }

        if (!script || !script.isDataOut()) {
          self.log.debug('Invalid script')
          continue
        }

        // If we find outputs with script data, we need to store the transaction into level db
        const metadata = script.getData().toString('hex')
        self.log.info('metadata added to index:', metadata)

        const data = {
          metadata: metadata,
          height: block.height,
          txid: txid,
          outputIndex: outputIndex
        }
        const action = add ? 'put' : 'del'
        const operation = {
          type: action,
          key: self._encoding.encodeMetadataKey(data),
          value: self._encoding.encodeHash(block.hash)
        }

        operations.push(operation)
      }
    }
  }

  self.log.debug('Updating the database with operations', operations)
  self._db.batch(operations, callback)
}

/**
 * This function will attempt to rewind the chain to the common ancestor
 * between the current chain and a forked block.
 * @param {Block} block - The new tip that forks the current chain.
 * @param {Function} done - A callback function that is called when complete.
 */
OpcodeService.prototype.disconnectTip = function (done) {
  const self = this
  const lastBlock = self.lastBlock

  // Undo the related indexes for this block
  self.disconnectBlock(lastBlock, function (err) {
    if (err) {
      return done(err)
    }

    // Update the lastblock
    self.getBlockSummary(self.tip.height - 1, function (err, blockSummary) {
      if (err) {
        return done(err)
      }
      self.lastBlock = blockSummary
    })
    self.emit('removeblock', lastBlock)
    done()
  })
}

OpcodeService.prototype.getBlockSummary = function (height, callback) {
  const self = this

  self._header.getBlockHeader(height, function (err, header) {
    if (err) {
      return callback(err)
    }

    if (!header) {
      return callback(new Error('Could not get block header for summary.'))
    }
    self._block.getBlock(header.hash, function (err, block) {
      if (err) {
        return callback(err)
      }

      const blockSummary = {
        hash: block.rhash(),
        height: header.height,
        prevHash: header.prevHash,
        txs: block.txs
      }

      callback(null, blockSummary)
    })
  })
}

/**
 * This function will synchronize additional indexes for the chain based on
 * the current active chain in the bitcoin daemon. In the event that there is
 * a reorganization in the daemon, the chain will rewind to the last common
 * ancestor and then resume syncing.
 */
OpcodeService.prototype.sync = function () {
  const self = this
  let height = null

  if (self.bitcoindSyncing || self.node.stopping || !self.tip) {
    return
  }

  self.bitcoindSyncing = true

  async.whilst(function () {
    if (self.node.stopping) {
      return false
    }
    height = self.tip.height
    // get the height from block, the block will start sync after header synced.
    return height < self._block.getTip().height
  }, function (done) {
    self.getBlockSummary(height + 1, function (err, blockSummary) {
      if (err) {
        return done(err)
      }

      let block = blockSummary
      if (block.prevHash === self.tip.hash.toString()) {
        // This block appends to the current chain tip and we can
        // immediately add it to the chain and create indexes.
        self.connectBlock(block, function (err) {
          if (err) {
            return done(err)
          }
          self.lastBlock = block
          self.log.debug('Chain added block to main chain')
          self.emit('addblock', block)
          done()
        })
      } else {
        // This block doesn't progress the current tip, so we'll attempt
        // to rewind the chain to the common ancestor of the block and
        // then we can resume syncing.
        self.log.warn('Reorg detected! Current tip: ' + self.tip.hash.toString())
        self.disconnectTip(function (err) {
          if (err) {
            return done(err)
          }
          self.log.warn('Disconnected current tip. New tip is ' + self.tip.hash.toString())
          done()
        })
      }
    })
  }, function (err) {
    if (err) {
      Error.captureStackTrace(err)
      return self.node.emit('error', err)
    }

    if (self.node.stopping) {
      self.bitcoindSyncing = false
      return
    }

    self.node.isSynced(function (err, synced) {
      if (err) {
        Error.captureStackTrace(err)
        return self.node.emit('error', err)
      }

      if (synced) {
        self.bitcoindSyncing = false
        self.node.emit('synced')
      } else {
        self.bitcoindSyncing = false
      }
    })
  })
}

OpcodeService.prototype.getRoutePrefix = function () {
  return 'opcodes'
}

OpcodeService.prototype.setupRoutes = function (app) {
  app.get('/metadata/:hex', this.checkMetadata.bind(this), this.lookupMetadata.bind(this))
  app.get('/protocols', this.listProtocols.bind(this))
  app.get('/identifiers/:identifier', this.lookupMetadataByIdentifier.bind(this))
}

OpcodeService.prototype.checkMetadata = function (req, res, next) {
  if (!this._utils.isHexadecimal(req.params.hex)) {
    return res.sendStatus(404)
  }

  next()
}

OpcodeService.prototype.lookupMetadata = function (req, res, next) {
  /*
    This method is used to determine whether the metadata has
    already been included in the blockchain. We are querying data
    from level db that we previously stored into level db via the blockHanlder.
  */
  const self = this
  const metadata = req.params.hex // the hex format of the metadata
  const minLimit = 1
  const maxLimit = 100
  const defaultLimit = 10
  const queryLimit = parseInt(req.query.limit)
  const limit = (isNaN(queryLimit) || queryLimit < minLimit || queryLimit > maxLimit) ? defaultLimit : queryLimit

  const cursor = req.query.after ? self._encoding.decodeShortCursor(metadata, req.query.after) : metadata

  if (!self._encoding.isValidCursor(cursor)) {
    return res.sendStatus(404)
  }

  let objArr = []
  let error = null
  let stream = null
  let penultimateKey = null
  let lastKey = null

  self.log.info('request for metadata:', metadata)
  enableCors(res)

  // Search level db for instances of the metadata
  // and put them in objArr
  stream = self._db.createReadStream({
    gte: self._encoding.convertCursorToKey(cursor, 0),
    lt: self._encoding.convertCursorToKey(metadata, 0xff),
    limit: limit + 1
  })

  stream.on('data', function (data) {
    // Parse data as matches are found and push it
    // to the objArr
    const keyObj = self._encoding.decodeMetadataKey(data.key)
    const obj = {
      blockhash: data.value.toString('hex'),
      blockheight: keyObj.blockheight,
      metadata: keyObj.metadata,
      txid: keyObj.txid,
      outputIndex: keyObj.outputIndex
    }
    penultimateKey = lastKey
    lastKey = data.key
    objArr.push(obj)
  })

  stream.on('error', function (streamError) {
    // Handle any errors during the search
    if (streamError) {
      error = streamError
    }
  })

  stream.on('close', function () {
    if (error) {
      return res.send(500, error.message)
    } else if (!objArr.length) {
      return res.sendStatus(404)
    }

    // Send back matches to the client
    let pagination = {}
    if (objArr.length === (limit + 1)) {
      const shortCursor = self._encoding.encodeShortCursor(metadata, penultimateKey, lastKey)
      pagination.next = `/opcodes/metadata/${metadata}?after=${shortCursor}&limit=${limit}`
    }

    const ret = {
      pagination: pagination,
      items: objArr.slice(0, limit)
    }
    res.send(ret)
  })
}

OpcodeService.prototype.listProtocols = function (req, res, next) {
  let objArr = []

  for (let i = 0; i < protocols.length; i++) {
    let obj = protocols[i]
    obj.href = '/opcodes/metadata/' + protocols[i].prefix
    objArr.push(obj)
  }

  const ret = {
    items: objArr
  }
  res.send(ret)
}

OpcodeService.prototype.lookupMetadataByIdentifier = function (req, res, next) {
  if (req.params.identifier) {
    for (let i = 0; i < protocols.length; i++) {
      if (req.params.identifier === protocols[i].identifier) {
        req.params.hex = protocols[i].prefix
        return this.lookupMetadata(req, res, next)
      }
    }
  }

  return res.sendStatus(404)
}

OpcodeService.prototype.start = function (callback) {
  const self = this

  self._db.getPrefix(self.name, function (err, prefix) {
    if (err) {
      return callback(err)
    }
    self._encoding = new Encoding(prefix)
    self._utils = new Utils()
  })

  this.once('ready', function () {
    self.log.info('OpcodeService Database Ready')

    this._bus.on('block/block', function () {
      if (!self.node.stopping) {
        self.sync()
      }
    })
    this._bus.subscribe('block/block')
  })

  function startFun () {
    self.loadTip(function (err) {
      if (err) {
        return callback(err)
      }

      self._bus = self.node.openBus({remoteAddress: 'localhost-opcodes'})
      self.sync()
      self.emit('ready')
    })
  }
  // FIXME: loadTip too early will cause the node crash
  setTimeout(startFun, 5000)
  callback()
}

OpcodeService.prototype.stop = function (callback) {
  const self = this

  if (self._bus) {
    self._bus.unsubscribe('block/block')
  }

  // Wait until syncing stops and all db operations are completed before closing leveldb
  async.whilst(function () {
    return self.bitcoindSyncing
  }, function (next) {
    setTimeout(next, 10)
  }, function () {
    self.log.debug('OpcodeService stop')
    callback()
  })
}

OpcodeService.prototype.getAPIMethods = function () {
  return [
    ['getBlockSummary', this, this.getBlockSummary, 1]
  ]
}

OpcodeService.prototype.getPublishEvents = function () {
  return []
}

module.exports = OpcodeService
