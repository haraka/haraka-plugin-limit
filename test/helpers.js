// Shared test factories. This file has no tests of its own; it is required
// by the sibling test files. (node --test runs it as a zero-test file.)

const path = require('node:path')

const { Address } = require('@haraka/email-address')
const fixtures = require('haraka-test-fixtures')

// plugin with limit.ini loaded from test/config/, registered, no redis
function configured() {
  const p = new fixtures.plugin('index')
  p.config = p.config.module_config(path.resolve('test'))
  p.register()
  return p
}

// plugin with an explicit cfg and no redis client (for !this.db paths)
function bare(cfg = {}) {
  const p = new fixtures.plugin('index')
  p.cfg = cfg
  return p
}

// configured plugin with a live redis client on a dedicated db index.
// Each test file passes its own index so flushDb() can't clobber a
// sibling file's keys when node runs the files concurrently.
function redisPlugin(database) {
  const p = configured()
  p.cfg.redis.database = database
  return new Promise((resolve) => {
    p.init_redis_plugin(() => resolve(p), { notes: {} })
  })
}

function conn(remote) {
  const c = new fixtures.connection.createConnection()
  c.init_transaction()
  if (remote) c.remote = remote
  return c
}

// invoke a next()-style hook, resolving to { rc, msg }
function hook(plugin, name, connection, ...extra) {
  return new Promise((resolve) => {
    plugin[name]((rc, msg) => resolve({ rc, msg }), connection, ...extra)
  })
}

module.exports = {
  Address,
  fixtures,
  bare,
  conn,
  configured,
  hook,
  redisPlugin,
}
