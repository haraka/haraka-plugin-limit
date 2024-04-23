
const assert = require('assert')

const fixtures = require('haraka-test-fixtures')

describe('inheritance', function () {
  beforeEach(function () {
    this.plugin = new fixtures.plugin('index')
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
