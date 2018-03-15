'use strict'

const BaseService = require('./service')
const inherits = require('util').inherits
const fs = require('fs')
const async = require('async')
const levelup = require('levelup')
const leveldown = require('leveldown')
const mkdirp = require('mkdirp')
const bitcore = require('bitcore-lib')
const $ = bitcore.util.preconditions
const _ = bitcore.deps._
const Script = bitcore.Script

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

  $.checkState(this.node.network, 'Node is expected to have a "network" property')
  this._header = this.node.services.header
  this._block = this.node.services.block

  this._setDataPath()

  this.levelupStore = leveldown
  if (options.store) {
    this.levelupStore = options.store
  }
  this.log = this.node.log
}

inherits(OpcodeService, BaseService)

OpcodeService.dependencies = ['header', 'block', 'transaction']

OpcodeService.PREFIX_TIP = Buffer.from('f4', 'hex')
OpcodeService.PREFIX = String.fromCharCode(0xff)

/**
 * This function will set `this.dataPath` based on `this.node.network`.
 * @private
 */
OpcodeService.prototype._setDataPath = function () {
  $.checkState(this.node.datadir, 'bitcore-node is expected to have a "datadir" property')
  const datadir = this.node.datadir

  if (['livenet', 'live', 'main', 'mainnet'].indexOf(this.node.network) !== -1) {
    this.dataPath = datadir + '/bitcore-opcodes.db'
  } else if (this.node.network !== 'regtest') {
    this.dataPath = datadir + '/testnet3/bitcore-opcodes.db'
  } else {
    this.dataPath = datadir + '/regtest/bitcore-opcodes.db'
  }
}

OpcodeService.prototype.loadTip = function (callback) {
  const self = this
  const options = {
    keyEncoding: 'binary',
    valueEncoding: 'binary'
  }

  self.store.get(OpcodeService.PREFIX_TIP, options, function (err, tipData) {
    if (err && err instanceof levelup.errors.NotFoundError) {
      // the genesis block can be retrieved from getBlock
      const BITCOIN_GENESIS_HASH = {
        livenet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        regtest: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
        testnet: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', // this is testnet3
        testnet5: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943' // this is testnet5
      }
      self.tip = {}
      self.tip.hash = BITCOIN_GENESIS_HASH[self.node.network]
      self.tip.prevHash = '0000000000000000000000000000000000000000000000000000000000000000'
      self.tip.__height = 0
      self.connectBlock(self.tip, function (err) {
        if (err) {
          return callback(err)
        }

        self.emit('addblock', self.tip)
        callback()
      })
      return
    } else if (err) {
      return callback(err)
    }

    // load the tip data
    self.tip = {}
    self.tip.hash = tipData.toString('hex')
    self.node.getBlockHeader(self.tip.hash, function (err, blockHeader) {
      if (err) {
        return callback(err)
      }
      if (!blockHeader) {
        return callback(new Error('Could not get height for tip.'))
      }
      self.tip.__height = blockHeader.height
      self.tip.prevHash = blockHeader.prevHash
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

  // Update tip
  const tipHash = add ? Buffer.from(block.hash, 'hex') : Buffer.from(block.prevHash, 'hex')
  operations.push({
    type: 'put',
    key: OpcodeService.PREFIX_TIP,
    value: tipHash
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

        // Prepend a prefix to the key to prevent namespacing collisions
        // Append the block height, txid, and outputIndex for ordering purposes (ensures transactions will be returned
        // in the order they occured)
        const key = [OpcodeService.PREFIX, metadata, block.__height, txid, outputIndex].join('-')
        const action = add ? 'put' : 'del'
        const operation = {
          type: action,
          key: key,
          value: block.hash
        }

        operations.push(operation)
      }
    }
  }

  self.log.debug('Updating the database with operations', operations)
  self.store.batch(operations, callback)
}

/**
 * This function will attempt to rewind the chain to the common ancestor
 * between the current chain and a forked block.
 * @param {Block} block - The new tip that forks the current chain.
 * @param {Function} done - A callback function that is called when complete.
 */
OpcodeService.prototype.disconnectTip = function (done) {
  const self = this
  let tip = self.tip

  self._block.getBlock(tip.prevHash, function (err, previousTip) {
    if (err) {
      done(err)
    }

    // Undo the related indexes for this block
    self.disconnectBlock(tip, function (err) {
      if (err) {
        return done(err)
      }

      // Set the new tip
      previousTip.__height = self.tip.__height - 1
      self.getBlockSummary(previousTip.__height, function (err, blockSummary) {
        if (err) {
          return done(err)
        }

        self.tip = blockSummary
      })
      self.emit('removeblock', tip)
      done()
    })
  })
}

OpcodeService.prototype.getBlockSummary = function (height, callback) {
  const self = this

  self._header.getBlockHeader(height, function (err, header) {
    if (err) {
      return callback(err)
    }

    if (!header) {
      return callback()
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
    height = self.tip.__height
    // get the height from block, the block will start sync after header synced.
    return height < self._block.getTip().height
  }, function (done) {
    self.getBlockSummary(height + 1, function (err, blockSummary) {
      if (err) {
        return done(err)
      }

      let block = blockSummary
      if (block.prevHash === self.tip.hash) {
        // This block appends to the current chain tip and we can
        // immediately add it to the chain and create indexes.

        // Populate height
        block.__height = self.tip.__height + 1

        // Create indexes
        self.connectBlock(block, function (err) {
          if (err) {
            return done(err)
          }
          self.tip = block
          self.log.debug('Chain added block to main chain')
          self.emit('addblock', block)
          done()
        })
      } else {
        // This block doesn't progress the current tip, so we'll attempt
        // to rewind the chain to the common ancestor of the block and
        // then we can resume syncing.
        self.log.warn('Reorg detected! Current tip: ' + self.tip.hash)
        self.disconnectTip(function (err) {
          if (err) {
            return done(err)
          }
          self.log.warn('Disconnected current tip. New tip is ' + self.tip.hash)
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
}

function isHexadecimal (metadata) {
  if (!_.isString(metadata)) {
    return false
  }
  return /^[0-9a-fA-F]+$/.test(metadata)
}

OpcodeService.prototype.checkMetadata = function (req, res, next) {
  if (!isHexadecimal(req.params.hex)) {
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
  const cursor = req.query.after ? req.query.after : metadata
  let objArr = []
  let error = null
  let stream = null
  let lastKey = null

  this.log.info('request for metadata:', metadata)
  enableCors(res)

  // Search level db for instances of the metadata
  // and put them in objArr
  stream = self.store.createReadStream({
    gte: [OpcodeService.PREFIX, cursor].join('-'),
    lt: [OpcodeService.PREFIX, metadata].join('-') + '~',
    limit: limit + 1
  })

  stream.on('data', function (data) {
    // Parse data as matches are found and push it
    // to the objArr
    const keyArr = data.key.toString().split('-')
    const obj = {
      blockhash: data.value.toString(),
      blockheight: keyArr[2],
      txid: keyArr[3],
      outputIndex: keyArr[4]
    }
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
      const lastCursor = lastKey.toString().slice(OpcodeService.PREFIX.length + 1) // skip PREFIX + '-'
      pagination.next = `/opcodes/metadata/${metadata}?after=${lastCursor}&limit=${limit}`
    }

    const ret = {
      pagination: pagination,
      items: objArr.slice(0, limit)
    }
    res.send(ret)
  })
}

OpcodeService.prototype.start = function (callback) {
  const self = this

  if (!fs.existsSync(this.dataPath)) {
    mkdirp.sync(this.dataPath)
  }

  this.store = levelup(leveldown(this.dataPath), { db: this.levelupStore })

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

  self._bus.unsubscribe('block/block')

  // Wait until syncing stops and all db operations are completed before closing leveldb
  async.whilst(function () {
    return self.bitcoindSyncing
  }, function (next) {
    setTimeout(next, 10)
  }, function () {
    if (self.store) {
      self.store.close(callback)
    }
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
