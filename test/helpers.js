// Shared test factories. This file has no tests of its own; it is required
// by the sibling test files. (node --test runs it as a zero-test file.)

const { Address } = require('@haraka/email-address')
const { callHook, makeConnection, makePlugin } = require('haraka-test-fixtures')

// plugin with limit.ini loaded from test/config/, registered, no redis
function configured() {
  return makePlugin('index', { configDir: __dirname })
}

// plugin with an explicit cfg and no redis client (for !this.db paths)
function bare(cfg = {}) {
  const p = makePlugin('index', { register: false })
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
  const c = makeConnection({ withTxn: true })
  if (remote) c.remote = remote
  return c
}

// invoke a next()-style hook, resolving to { rc, msg }
function hook(plugin, name, connection, ...extra) {
  return callHook(plugin, name, connection, ...extra)
}

module.exports = {
  Address,
  bare,
  conn,
  configured,
  hook,
  redisPlugin,
}
