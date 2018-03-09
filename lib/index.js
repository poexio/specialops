'use strict'

var BaseService = require('./service')
var inherits = require('util').inherits
var fs = require('fs')
var async = require('async')
var levelup = require('levelup')
var leveldown = require('leveldown')
var mkdirp = require('mkdirp')
var bitcore = require('bitcore-lib')
var $ = bitcore.util.preconditions
var Script = bitcore.Script

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
  var datadir = this.node.datadir

  if (['livenet', 'live', 'main', 'mainnet'].indexOf(this.node.network) !== -1) {
    this.dataPath = datadir + '/bitcore-opcodes.db'
  } else if (this.node.network !== 'regtest') {
    this.dataPath = datadir + '/testnet3/bitcore-opcodes.db'
  } else {
    this.dataPath = datadir + '/regtest/bitcore-opcodes.db'
  }
}

OpcodeService.prototype.loadTip = function (callback) {
  var self = this

  var options = {
    keyEncoding: 'binary',
    valueEncoding: 'binary'
  }

  self.store.get(OpcodeService.PREFIX_TIP, options, function (err, tipData) {
    if (err && err instanceof levelup.errors.NotFoundError) {
      // the genesis block can be retrieved from getBlock
      var BITCOIN_GENESIS_HASH = {
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
    The code below stores any transactions with scriptData into a level db
    in a single atomic operation.
  */
  var self = this
  var operations = []

  // Update tip
  var tipHash = add ? Buffer.from(block.hash, 'hex') : Buffer.from(block.prevHash, 'hex')
  operations.push({
    type: 'put',
    key: OpcodeService.PREFIX_TIP,
    value: tipHash
  })

  var txs = block.txs
  if (txs) {
    var height = block.__height

    // Loop through every transaction in the block
    var transactionLength = txs.length
    for (var i = 0; i < transactionLength; i++) {
      var tx = txs[i]
      var txid = tx.txid()
      var outputs = tx.outputs
      var outputLength = outputs.length

      // Loop through every output in the transaction
      for (var outputIndex = 0; outputIndex < outputLength; outputIndex++) {
        var output = outputs[outputIndex]
        var script = null
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
        var scriptData = script.getData().toString('hex')
        self.log.info('scriptData added to index:', scriptData)

        // Prepend a prefix to the key to prevent namespacing collisions
        // Append the block height, txid, and outputIndex for ordering purposes (ensures transactions will be returned
        // in the order they occured)
        var key = [OpcodeService.PREFIX, scriptData, height, txid, outputIndex].join('-')
        var value = block.hash

        var action = add ? 'put' : 'del'
        var operation = {
          type: action,
          key: key,
          value: value
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
  var self = this
  var tip = self.tip
  var prevHash = tip.prevHash

  self._block.getBlock(prevHash, function (err, previousTip) {
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
  var self = this

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

      var blockSummary = {
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
  var self = this
  var height = null

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

      var block = blockSummary
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
  app.get('/hash/:hash', this.lookupHash.bind(this))
}

OpcodeService.prototype.lookupHash = function (req, res, next) {
  /*
    This method is used to determine whether a file hash has
    already been included in the blockchain. We are querying data
    from level db that we previously stored into level db via the blockHanlder.
  */
  var self = this
  var hash = req.params.hash // the hash of the uploaded file
  var node = this.node
  var objArr = []
  var error = null

  this.log.info('request for hash:', hash)
  enableCors(res)
  // Search level db for instances of this file hash
  // and put them in objArr
  var stream = self.store.createReadStream({
    gte: [OpcodeService.PREFIX, hash].join('-'),
    lt: [OpcodeService.PREFIX, hash].join('-') + '~'
  })

  stream.on('data', function (data) {
    // Parse data as matches are found and push it
    // to the objArr
    var keyArr = data.key.toString().split('-')
    var obj = {
      hash: data.value.toString(),
      height: keyArr[2],
      txid: keyArr[3],
      outputIndex: keyArr[4]
    }
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

    // For each transaction that included our file hash, get additional
    // info from the blockchain about the transaction (such as the timestamp and source address).
    async.each(objArr, function (obj, eachCallback) {
      var txid = obj.txid

      node.log.info('getting details for txid:', txid)
      node.getDetailedTransaction(txid, {}, function (err, transaction) {
        if (err) {
          return eachCallback(err)
        }
        var address = transaction.inputs[0].address

        obj.sourceAddress = address
        obj.timestamp = transaction.blockTimestamp
        return eachCallback()
      })
    }, function doneGrabbingTransactionData (err) {
      if (err) {
        return res.send(500, err)
      }

      // Send back matches to the client
      res.send(objArr)
    })
  })
}

OpcodeService.prototype.start = function (callback) {
  var self = this

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
  var self = this

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
