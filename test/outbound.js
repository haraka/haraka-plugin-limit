const assert = require('assert')

// var Address      = require('address-rfc2821').Address;
const constants = require('haraka-constants')
const fixtures = require('haraka-test-fixtures')

function _set_up(done) {
  this.plugin = new fixtures.plugin('index')
  this.plugin.register()
  this.server = { notes: {} }
  this.plugin.init_redis_plugin(function () {
    done()
  }, this.server)
}

describe('outbound_increment', function () {
  before(_set_up)

  it('no limit, no delay', async function () {
    await new Promise((resolve) => {
      this.plugin.outbound_increment(
        function (code, msg) {
          assert.equal(code, undefined)
          assert.equal(msg, undefined)
          resolve()
        },
        { domain: 'test.com' },
      )
    })
  })

  it('limits has delay', async function () {
    const self = this
    self.plugin.cfg.outbound['slow.test.com'] = 3
    await self.plugin.db.hSet('outbound-rate:slow.test.com', 'TOTAL', 4)
    await new Promise((resolve) => {
      self.plugin.outbound_increment(
        function (code, delay) {
          assert.equal(code, constants.delay)
          assert.equal(delay, 30)
          resolve()
        },
        { domain: 'slow.test.com' },
      )
    })
  })
})
