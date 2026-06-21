const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function makeRange(part) {
  return {
    __range: true,
    ...part,
    and(other) {
      return makeRange({ ...this, ...other })
    }
  }
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

function matchesCriteria(doc, criteria) {
  return Object.keys(criteria || {}).every((key) => {
    const expected = criteria[key]
    const actual = doc[key]
    if (expected && expected.__range) {
      if (typeof actual === 'undefined' || actual === null) return false
      const actualTs = timestampOf(actual)
      if (typeof expected.gte !== 'undefined' && actualTs < timestampOf(expected.gte)) return false
      if (typeof expected.lt !== 'undefined' && actualTs >= timestampOf(expected.lt)) return false
      return true
    }
    return actual === expected
  })
}

class FakeQuery {
  constructor(rows, criteria, skipCount, limitCount, sort, missing) {
    this.rows = rows || []
    this.criteria = criteria || null
    this.skipCount = skipCount || 0
    this.limitCount = limitCount || this.rows.length || 100
    this.sort = sort || null
    this.missing = missing || null
  }

  where(criteria) {
    return new FakeQuery(this.rows, criteria, this.skipCount, this.limitCount, this.sort, this.missing)
  }

  skip(skipCount) {
    return new FakeQuery(this.rows, this.criteria, skipCount, this.limitCount, this.sort, this.missing)
  }

  limit(limitCount) {
    return new FakeQuery(this.rows, this.criteria, this.skipCount, limitCount, this.sort, this.missing)
  }

  orderBy(field, direction) {
    return new FakeQuery(this.rows, this.criteria, this.skipCount, this.limitCount, { field, direction }, this.missing)
  }

  async get() {
    if (this.missing) {
      const err = new Error('collection not exists')
      err.errMsg = 'collection not exist'
      throw err
    }
    let filtered = this.criteria ? this.rows.filter((row) => matchesCriteria(row, this.criteria)) : this.rows
    if (this.sort) {
      const dir = this.sort.direction === 'desc' ? -1 : 1
      filtered = filtered.slice().sort((a, b) => {
        const av = timestampOf(a[this.sort.field])
        const bv = timestampOf(b[this.sort.field])
        const an = Number.isFinite(av) ? av : -Infinity
        const bn = Number.isFinite(bv) ? bv : -Infinity
        return (an - bn) * dir
      })
    }
    return { data: filtered.slice(this.skipCount, this.skipCount + this.limitCount) }
  }
}

function createFakeCloud(fixtures, options) {
  const opts = options || {}
  const collectionsAccessed = []
  return {
    DYNAMIC_CURRENT_ENV: 'test-env',
    collectionsAccessed,
    init() {},
    getWXContext() {
      return { OPENID: opts.openid || 'admin-openid' }
    },
    database() {
      return {
        command: {
          gte(value) {
            return makeRange({ gte: value })
          },
          lt(value) {
            return makeRange({ lt: value })
          }
        },
        collection(name) {
          collectionsAccessed.push(name)
          const missing = Array.isArray(opts.missingCollections) && opts.missingCollections.indexOf(name) !== -1
          return new FakeQuery(fixtures[name] || [], null, 0, 0, null, missing)
        }
      }
    }
  }
}

async function withAdminStatsMain(fakeCloud, callback) {
  const originalLoad = Module._load
  const modulePath = require.resolve('../cloudfunctions/adminStats/index.js')
  delete require.cache[modulePath]

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const { main } = require('../cloudfunctions/adminStats/index.js')
    return await callback(main)
  } finally {
    Module._load = originalLoad
    delete require.cache[modulePath]
  }
}

test('admin stats counts measurement events stored with createTimeMs', async () => {
  const originalAdminOpenids = process.env.ADMIN_OPENIDS
  process.env.ADMIN_OPENIDS = 'admin-openid'

  try {
    const resultTimestamp = Date.now()
    const fakeCloud = createFakeCloud({
      measureEvents: [
        {
          _id: 'measure-1',
          openid: 'user-a',
          sessionId: 'session-a',
          mode: 'precision',
          quotaSource: 'paid',
          createTimeMs: resultTimestamp
        }
      ],
      orders: [],
      users: []
    })

    await withAdminStatsMain(fakeCloud, async (main) => {
      const result = await main({ action: 'stats', days: 1 })
      assert.equal(result.ok, true)
      assert.equal(result.today.measurementUsers, 1)
      assert.equal(result.today.measurementSessions, 1)
    })
  } finally {
    if (typeof originalAdminOpenids === 'undefined') delete process.env.ADMIN_OPENIDS
    else process.env.ADMIN_OPENIDS = originalAdminOpenids
  }
})

function restoreEnv(key, value) {
  if (typeof value === 'undefined') delete process.env[key]
  else process.env[key] = value
}

test('getRecentPaidOrders rejects unauthorized caller and never reads orders', async () => {
  const originalOpenids = process.env.ADMIN_OPENIDS
  const originalToken = process.env.ADMIN_API_TOKEN
  process.env.ADMIN_OPENIDS = 'someone-else'
  delete process.env.ADMIN_API_TOKEN

  try {
    const fakeCloud = createFakeCloud(
      { orders: [{ outTradeNo: 'vp1', status: 'paid', amount: 990, openid: 'u1', payTime: new Date('2026-06-21T10:00:00.000Z') }] },
      { openid: 'not-admin' }
    )
    await withAdminStatsMain(fakeCloud, async (main) => {
      const result = await main({ action: 'getRecentPaidOrders' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'UNAUTHORIZED')
      assert.equal(fakeCloud.collectionsAccessed.includes('orders'), false)
    })
  } finally {
    restoreEnv('ADMIN_OPENIDS', originalOpenids)
    restoreEnv('ADMIN_API_TOKEN', originalToken)
  }
})

test('getRecentPaidOrders returns paid orders desc by payTime, excludes pending, honors limit', async () => {
  const originalOpenids = process.env.ADMIN_OPENIDS
  process.env.ADMIN_OPENIDS = 'admin-openid'

  try {
    const older = new Date('2026-06-20T10:00:00.000Z')
    const newer = new Date('2026-06-21T10:00:00.000Z')
    const fakeCloud = createFakeCloud({
      orders: [
        { _id: 'o1', outTradeNo: 'vp-old', status: 'paid', amount: 990, plan: 'single', channel: 'virtual', openid: 'u1', payTime: older },
        { _id: 'o2', outTradeNo: 'vp-new', status: 'paid', amount: 1990, plan: 'annual', channel: 'virtual', openid: 'u2', payTime: newer, deliveryStatus: 'delivered' },
        { _id: 'o3', outTradeNo: 'vp-pending', status: 'pending', amount: 990, plan: 'single', openid: 'u3', payTime: null }
      ]
    })
    await withAdminStatsMain(fakeCloud, async (main) => {
      const result = await main({ action: 'getRecentPaidOrders', limit: 10 })
      assert.equal(result.ok, true)
      assert.equal(result.count, 2)
      assert.equal(result.limit, 10)
      assert.equal(result.orders[0].outTradeNo, 'vp-new')
      assert.equal(result.orders[0].amountYuan, 19.9)
      assert.equal(result.orders[1].outTradeNo, 'vp-old')
      assert.equal(result.orders.some((o) => o.status === 'pending'), false)
    })
  } finally {
    restoreEnv('ADMIN_OPENIDS', originalOpenids)
  }
})

test('getRecentPaidOrders returns empty list when orders collection is missing', async () => {
  const originalOpenids = process.env.ADMIN_OPENIDS
  process.env.ADMIN_OPENIDS = 'admin-openid'

  try {
    const fakeCloud = createFakeCloud({}, { missingCollections: ['orders'] })
    await withAdminStatsMain(fakeCloud, async (main) => {
      const result = await main({ action: 'getRecentPaidOrders' })
      assert.equal(result.ok, true)
      assert.equal(result.count, 0)
      assert.deepEqual(result.orders, [])
    })
  } finally {
    restoreEnv('ADMIN_OPENIDS', originalOpenids)
  }
})
