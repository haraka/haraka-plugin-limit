const assert = require('assert')
const { before, describe, it } = require('node:test')
const path = require('path')

const fixtures = require('haraka-test-fixtures')

const { bare } = require('./helpers')

const default_config = {
  main: { tarpit_delay: 0 },
  outbound: { enabled: false },
  rate_outbound: { enabled: false },
  recipients: { enabled: false },
  recipients_history: { enabled: false },
  unrecognized_commands: { enabled: false },
  errors: { enabled: false },
  rate_conn: { 127: 0, enabled: false, default: 5 },
  rate_conn_history: { enabled: false },
  rate_rcpt: { 127: 0, enabled: false, default: '50/5m' },
  rate_rcpt_host: { 127: 0, enabled: false, default: '50/5m' },
  rate_rcpt_sender: { 127: 0, enabled: false, default: '50/5m' },
  rate_rcpt_null: { enabled: false, default: 1 },
  redis: { database: 4, socket: { host: '127.0.0.1', port: '6379' } },
  concurrency: { plugin: 'karma', good: 10, bad: 1, none: 2 },
  concurrency_history: { enabled: false },
}

describe('plugin_setup', () => {
  let plugin

  before(() => {
    plugin = new fixtures.plugin('index')
    plugin.config = plugin.config.module_config(path.resolve('test'))
  })

  it('loads config', () => {
    // gotta inherit b/c config loader merges in defaults from redis.ini
    plugin.inherits('haraka-plugin-redis')
    plugin.load_limit_ini()
    assert.deepEqual(plugin.cfg, default_config) // loaded config
  })

  it('registers', () => {
    plugin.register()
    assert.deepEqual(plugin.cfg, default_config)
  })

  it('registers every hook when all features are enabled', () => {
    const p = new fixtures.plugin('index')
    p.load_limit_ini = function () {
      this.cfg = {
        main: {},
        concurrency: { enabled: true },
        errors: { enabled: true },
        recipients: { enabled: true },
        unrecognized_commands: { enabled: true },
        rate_conn: { enabled: true },
        rate_rcpt_host: { enabled: true },
        rate_rcpt_sender: { enabled: true },
        rate_rcpt_null: { enabled: true },
        rate_rcpt: { enabled: true },
        outbound: { enabled: true },
        rate_outbound: { enabled: true },
      }
    }
    p.register()
    assert.ok(p.cfg.concurrency.enabled)
  })

  it('defaults concurrency to {} when absent from config', () => {
    const p = bare()
    p.config = { get: () => ({ main: {} }) }
    p.merge_redis_ini = () => {}
    p.load_limit_ini()
    assert.deepEqual(p.cfg.concurrency, {})
  })
})
