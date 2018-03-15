## bitcore-opcodes
[OP_RETURN](https://en.bitcoin.it/wiki/OP_RETURN) is a script opcode used to mark a transaction output as invalid.

It can be used by Proof of Existence, Digital Arts, Assets and others.

In order to find the OP_RETURN code quickly, bitcore-opcodes is the best choice.

## Prerequisites

- [Bitcore 5.x](https://github.com/bitpay/bitcore)

## Usage
[Follow this guide](https://blog.bitpay.com/bitcore-v5/) to install and run a full Bitcore node.

Assuming the created Bitcore node is called ___mynode___ and resides in your home directory

```bash
cd ~/mynode
npm install @poexio/bitcore-opcodes
```

Add ___bitcore-opcodes___ as a dependency in ~/mynode/bitcore-node.json

```javascript
{
  "version": "5.0.0-beta.44",
  "network": "testnet",
  "port": 3001,
  "services": [
    "address",
    "block",
    "db",
    "fee",
    "header",
    "mempool",
    "p2p",
    "timestamp",
    "transaction",
    "web",
    "insight-api",
    "@poexio/bitcore-opcodes"
  ],
  "datadir": "./data"
}
```

Start bitcore-node, then you can access the service with `http://localhost:3001/opcodes`

## API HTTP Endpoints
We can support btc mainnet, testnet3 and regtest

### Metadata
Get the transactions that contain the metadata.

Resource | Method | Request Object | Return Object
-------- | -------|----------------|---------------
/metadata/:hex[?limit=1] | GET | [OP_RETURN data](https://bitcore.io/api/lib/transaction#Transaction+addData) | Metadata Object

NOTE:

Range of limit: [1, 100], default: 10

* Usage:
```bash
curl http://localhost:3001/opcodes/metadata/444f4350524f4f465efa245c88af3bc0bf9e4392976cedafd9a0de8d3f737ba0f48231b0f9262110
curl http://localhost:3001/opcodes/metadata/444f4350524f4f465efa245c88af3bc0bf9e4392976cedafd9a0de8d3f737ba0f48231b0f9262110?limit=1
```

This would return (for testnet):

```
{
  "items": [
    {
      "blockhash": "00000000f959a5ed22dfa034f7957adbda91b3756700dbd29c640ca581bdba22",
      "blockheight": "1287345",
      "metadata": "444f4350524f4f465efa245c88af3bc0bf9e4392976cedafd9a0de8d3f737ba0f48231b0f9262110",
      "txid": "30e24f7132635c6b278e9d505112788ca8234dfe15ac545288d33fb675dfdf4c",
      "outputIndex": "0"
    }
  ]
}
```
### Protocols
List all protocols

Resource   | Method | Request Object | Return Object
---------- | -------|----------------|---------------
/protocols | GET    |                | Protocol Object

* Usage:
```bash
curl http://localhost:3001/opcodes/protocols
```

This would return (for testnet):

```
{
  "items": [
    {
      "protocol": "Proof of Existence",
      "identifier": "DOCPROOF",
      "prefix": "444f4350524f4f46",
      "href": "/opcodes/metadata/444f4350524f4f46"
    },
    {
      "protocol": "Po.et",
      "identifier": "POET",
      "prefix": "504f4554",
      "href": "/opcodes/metadata/504f4554"
    },
    {
      "protocol": "Omni",
      "identifier": "Omni",
      "prefix": "6f6d6e69",
      "href": "/opcodes/metadata/6f6d6e69"
    },
    {
      "protocol": "Stampd",
      "identifier": "STAMPD##",
      "prefix": "5354414d50442323",
      "href": "/opcodes/metadata/5354414d50442323"
    },
    {
      "protocol": "Eternity Wall",
      "identifier": "EW",
      "prefix": "4557",
      "href": "/opcodes/metadata/4557"
    }
  ]
}
```
