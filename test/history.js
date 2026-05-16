const assert = require('assert')
const path = require('path')

// const constants    = require('haraka-constants');
const fixtures = require('haraka-test-fixtures')

describe('get_history_limit', function () {
  before(function () {
    this.plugin = new fixtures.plugin('index')
    this.plugin.config = this.plugin.config.module_config(path.resolve('test'))

    this.connection = new fixtures.connection.createConnection()
    this.connection.init_transaction()

    this.plugin.register()

    this.plugin.cfg.concurrency_history = {
      enabled: true,
      plugin: 'karma',
      good: 5,
      bad: 1,
      none: 2,
    }
  })

  it('good', () => {
    connection.results.add({ name: 'karma' }, { history: 1 })
    assert.equal(5, plugin.get_history_limit('concurrency', connection))
  })

  it('bad', () => {
    connection.results.add({ name: 'karma' }, { history: -1 })
    assert.equal(1, plugin.get_history_limit('concurrency', connection))
  })

  it('none', () => {
    connection.results.add({ name: 'karma' }, { history: 0 })
    assert.equal(2, plugin.get_history_limit('concurrency', connection))
  })
})
