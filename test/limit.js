
const assert = require('assert')
const path = require('path')

const constants = require('haraka-constants')
const fixtures = require('haraka-test-fixtures')

function setUp() {
  this.plugin = new fixtures.plugin('index')
  this.plugin.config = this.plugin.config.module_config(path.resolve('test'))

  this.connection = new fixtures.connection.createConnection()
  this.connection.init_transaction()

  this.plugin.register()
}

describe('max_errors', function () {
  before(setUp)

  it('none', function (done) {
    // console.log(this);
    this.plugin.max_errors(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, null)
      assert.equal(msg, null)
      done()
    }, this.connection)
  })

  it('too many', function (done) {
    // console.log(this);
    this.connection.errors = 10
    this.plugin.cfg.errors = { max: 9 }
    this.plugin.max_errors(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, constants.DENYSOFTDISCONNECT)
      assert.equal(msg, 'Too many errors')
      done()
    }, this.connection)
  })
})

describe('max_recipients', function () {
  before(setUp)

  it('none', function (done) {
    this.plugin.max_recipients(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, null)
      assert.equal(msg, null)
      done()
    }, this.connection)
  })

  it('too many', function (done) {
    this.connection.rcpt_count = { accept: 3, tempfail: 5, reject: 4 }
    this.plugin.cfg.recipients = { max: 10 }
    this.plugin.max_recipients(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, constants.DENYSOFT)
      assert.equal(msg, 'Too many recipient attempts')
      done()
    }, this.connection)
  })
})

describe('max_unrecognized_commands', function () {
  before(setUp)

  it('none', function (done) {
    // console.log(this);
    this.plugin.max_unrecognized_commands(function (rc, msg) {
      assert.equal(rc, null)
      assert.equal(msg, null)
      done()
    }, this.connection)
  })

  it('too many', function (done) {
    // console.log(this);
    this.plugin.cfg.unrecognized_commands = { max: 5 }
    this.connection.results.push(this.plugin, {
      unrec_cmds: ['1', '2', '3', '4', 5, 6],
    })
    this.plugin.max_unrecognized_commands(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, constants.DENYSOFTDISCONNECT)
      assert.equal(msg, 'Too many unrecognized commands')
      done()
    }, this.connection)
  })
})

describe('check_concurrency', function () {
  before(setUp)

  it('none', function (done) {
    this.plugin.check_concurrency(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, null)
      assert.equal(msg, null)
      done()
    }, this.connection)
  })

  it('at max', function (done) {
    this.plugin.cfg.concurrency.history = undefined
    this.plugin.cfg.concurrency = { max: 4 }
    this.connection.results.add(this.plugin, { concurrent_count: 4 })
    this.plugin.check_concurrency(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, null)
      assert.equal(msg, null)
      done()
    }, this.connection)
  })

  it('too many', function (done) {
    this.plugin.cfg.concurrency.history = undefined
    this.plugin.cfg.concurrency = { max: 4 }
    this.plugin.cfg.concurrency.disconnect_delay = 1
    this.connection.results.add(this.plugin, { concurrent_count: 5 })
    this.plugin.check_concurrency(function (rc, msg) {
      // console.log(arguments);
      assert.equal(rc, constants.DENYSOFTDISCONNECT)
      assert.equal(msg, 'Too many concurrent connections')
      done()
    }, this.connection)
  })
})
