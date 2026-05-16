const assert = require('node:assert')
const { beforeEach, describe, it } = require('node:test')

const fixtures = require('haraka-test-fixtures')

const { bare, redisPlugin } = require('./helpers')

describe('inheritance', () => {
  let plugin

  beforeEach(() => {
    plugin = new fixtures.plugin('index')
  })

  it('inherits redis', function () {
    plugin.inherits('haraka-plugin-redis')
    assert.equal(typeof plugin.load_redis_ini, 'function')
  })

  it('can call parent functions', function () {
    plugin.inherits('haraka-plugin-redis')
    plugin.load_redis_ini()
    assert.ok(plugin.redisCfg) // loaded config
  })

  it('register', function () {
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
