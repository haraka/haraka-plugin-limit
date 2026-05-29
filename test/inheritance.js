const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('node:test')

const { makePlugin } = require('haraka-test-fixtures')

const { bare, redisPlugin } = require('./helpers')

describe('inheritance', () => {
  let plugin

  beforeEach(() => {
    plugin = makePlugin('index', { register: false })
  })

  it('inherits redis', () => {
    plugin.inherits('haraka-plugin-redis')
    assert.equal(typeof plugin.load_redis_ini, 'function')
  })

  it('can call parent functions', () => {
    plugin.inherits('haraka-plugin-redis')
    plugin.load_redis_ini()
    assert.ok(plugin.redisCfg) // loaded config
  })

  it('register', () => {
    plugin.register()
    assert.ok(plugin.cfg) // loaded config
  })
})

describe('shutdown', () => {
  it('quits the inherited redis client when present', async () => {
    const plugin = await redisPlugin(8)
    let called = false
    const realQuit = plugin.db.quit.bind(plugin.db)
    plugin.db.quit = () => {
      called = true
      return realQuit() // actually close, so no dangling handle
    }
    plugin.shutdown()
    assert.equal(called, true)
  })

  it('is a no-op without a db', () => {
    assert.doesNotThrow(() => bare().shutdown())
  })
})
