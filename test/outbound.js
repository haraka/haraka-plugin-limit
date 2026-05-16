const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('node:test')

const constants = require('haraka-constants')

const { bare, hook, redisPlugin } = require('./helpers')

describe('outbound', () => {
  let plugin

  before(async () => {
    plugin = await redisPlugin(6)
  })
  after(async () => {
    if (plugin?.db) await plugin.db.quit()
  })
  beforeEach(async () => {
    await plugin.db.flushDb()
    plugin.cfg.outbound = {}
  })

  describe('outbound_increment', () => {
    it('delivers (no limit) and counts the message', async () => {
      const { rc } = await hook(plugin, 'outbound_increment', {
        domain: 'test.com',
      })
      assert.equal(rc, undefined)
      const h = await plugin.db.hGetAll('outbound-rate:test.com')
      assert.equal(h.TOTAL, '1')
    })

    it('delays when the domain limit is exceeded', async () => {
      plugin.cfg.outbound['slow.com'] = 1
      await plugin.db.hSet('outbound-rate:slow.com', 'TOTAL', '5')
      const { rc, msg } = await hook(plugin, 'outbound_increment', {
        todo: { domain: 'slow.com' },
      })
      assert.equal(rc, constants.delay)
      assert.equal(msg, 30)
    })

    it('just delivers on a real redis WRONGTYPE error', async () => {
      await plugin.db.set('outbound-rate:test.com', 'str')
      const { rc } = await hook(plugin, 'outbound_increment', {
        domain: 'test.com',
      })
      assert.equal(rc, undefined)
    })

    it('is a no-op without a db', async () => {
      const { rc } = await hook(bare({ outbound: {} }), 'outbound_increment', {
        domain: 'test.com',
      })
      assert.equal(rc, undefined)
    })
  })

  describe('outbound_decrement', () => {
    it('lowers the counter', async () => {
      await plugin.db.hSet('outbound-rate:test.com', 'TOTAL', '3')
      await hook(plugin, 'outbound_decrement', { domain: 'test.com' })
      const h = await plugin.db.hGetAll('outbound-rate:test.com')
      assert.equal(h.TOTAL, '2')
    })

    it('is a no-op without a db', async () => {
      const { rc } = await hook(bare({ outbound: {} }), 'outbound_decrement', {
        domain: 'test.com',
      })
      assert.equal(rc, undefined)
    })
  })
})
