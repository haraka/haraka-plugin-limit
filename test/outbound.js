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

    it('concurrency lifecycle: TOTAL stays correct across deliver/delay/decrement', async () => {
      plugin.cfg.outbound['slow.com'] = 1

      // First message: under limit, should deliver and TOTAL=1
      const r1 = await hook(plugin, 'outbound_increment', {
        domain: 'slow.com',
      })
      assert.equal(r1.rc, undefined)
      let h = await plugin.db.hGetAll('outbound-rate:slow.com')
      assert.equal(h.TOTAL, '1')

      // Second message while first is in-flight: over limit, should delay, TOTAL stays 1 (undo worked)
      const r2 = await hook(plugin, 'outbound_increment', {
        domain: 'slow.com',
      })
      assert.equal(r2.rc, constants.delay)
      h = await plugin.db.hGetAll('outbound-rate:slow.com')
      assert.equal(h.TOTAL, '1')

      // First message delivers: TOTAL decrements to 0
      await hook(plugin, 'outbound_decrement', { domain: 'slow.com' })
      h = await plugin.db.hGetAll('outbound-rate:slow.com')
      assert.equal(h.TOTAL, '0')

      // Second message retries: slot is free, should deliver, TOTAL=1
      const r3 = await hook(plugin, 'outbound_increment', {
        domain: 'slow.com',
      })
      assert.equal(r3.rc, undefined)
      h = await plugin.db.hGetAll('outbound-rate:slow.com')
      assert.equal(h.TOTAL, '1')
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

  describe('rate_outbound', () => {
    beforeEach(() => {
      plugin.cfg.rate_outbound = {}
    })

    it('is a no-op without a db', async () => {
      const { rc } = await hook(bare({ rate_outbound: {} }), 'rate_outbound', {
        domain: 'test.com',
      })
      assert.equal(rc, undefined)
    })

    it('delivers when under the limit', async () => {
      plugin.cfg.rate_outbound['fast.com'] = '10/1m'
      const { rc } = await hook(plugin, 'rate_outbound', { domain: 'fast.com' })
      assert.equal(rc, undefined)
      const count = await plugin.db.get('rate_outbound:fast.com')
      assert.equal(count, '1')
    })

    it('delays when the limit is exceeded', async () => {
      plugin.cfg.rate_outbound['slow.com'] = '1/30s'
      await plugin.db.set('rate_outbound:slow.com', '5')
      const { rc, msg } = await hook(plugin, 'rate_outbound', {
        domain: 'slow.com',
      })
      assert.equal(rc, constants.delay)
      assert.equal(msg, 30) // delay = TTL = 30s
    })

    it('passes through when value is 0 (disabled for domain)', async () => {
      plugin.cfg.rate_outbound['exempt.com'] = 0
      const { rc } = await hook(plugin, 'rate_outbound', {
        domain: 'exempt.com',
      })
      assert.equal(rc, undefined)
    })

    it('passes through when domain is not configured', async () => {
      const { rc } = await hook(plugin, 'rate_outbound', {
        domain: 'unknown.com',
      })
      assert.equal(rc, undefined)
    })

    it('uses subdomain lookup (sub.slow.com matches slow.com limit)', async () => {
      plugin.cfg.rate_outbound['slow.com'] = '1/1m'
      await plugin.db.set('rate_outbound:slow.com', '5')
      const { rc } = await hook(plugin, 'rate_outbound', {
        todo: { domain: 'mx.slow.com' },
      })
      assert.equal(rc, constants.delay)
    })

    it('fails open on a redis WRONGTYPE error', async () => {
      plugin.cfg.rate_outbound['bad.com'] = '5/1m'
      await plugin.db.hSet('rate_outbound:bad.com', 'field', 'val') // wrong type
      const { rc } = await hook(plugin, 'rate_outbound', { domain: 'bad.com' })
      assert.equal(rc, undefined)
    })
  })
})
