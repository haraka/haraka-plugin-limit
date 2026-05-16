const assert = require('assert')

const fixtures = require('haraka-test-fixtures')

const { bare, redisPlugin } = require('./helpers')

describe('inheritance', () => {
  let plugin

  beforeEach(() => {
    plugin = new fixtures.plugin('index')
  })

  it('inherits redis', function () {
    this.plugin.inherits('haraka-plugin-redis')
    assert.equal(typeof this.plugin.load_redis_ini, 'function')
  })

  it('can call parent functions', function () {
    this.plugin.inherits('haraka-plugin-redis')
    this.plugin.load_redis_ini()
    assert.ok(this.plugin.redisCfg) // loaded config
  })

  it('register', function () {
    this.plugin.register()
    assert.ok(this.plugin.cfg) // loaded config
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
