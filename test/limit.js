const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('node:test')

const constants = require('haraka-constants')

const { bare, conn, configured, hook, redisPlugin } = require('./helpers')

const { DENYSOFT, DENYSOFTDISCONNECT } = constants

// the max_* deny hooks: a default-pass case plus an over-the-limit case
const denyHooks = [
  {
    hook: 'max_errors',
    over(p, c) {
      c.errors = 10
      p.cfg.errors = { max: 9 }
    },
    rc: DENYSOFTDISCONNECT,
    msg: 'Too many errors',
  },
  {
    hook: 'max_recipients',
    over(p, c) {
      c.rcpt_count = { accept: 3, tempfail: 5, reject: 4 }
      p.cfg.recipients = { max: 10 }
    },
    rc: DENYSOFT,
    msg: 'Too many recipient attempts',
  },
  {
    hook: 'max_unrecognized_commands',
    over(p, c) {
      p.cfg.unrecognized_commands = { max: 5 }
      c.results.push(p, { unrec_cmds: ['1', '2', '3', '4', 5, 6] })
    },
    rc: DENYSOFTDISCONNECT,
    msg: 'Too many unrecognized commands',
  },
]

for (const { hook: name, over, rc, msg } of denyHooks) {
  describe(name, () => {
    let plugin, c
    beforeEach(() => {
      plugin = configured()
      c = conn()
    })

    it('passes by default', async () => {
      assert.equal((await hook(plugin, name, c)).rc, undefined)
    })

    it('denies when over the limit', async () => {
      over(plugin, c)
      const r = await hook(plugin, name, c)
      assert.equal(r.rc, rc)
      assert.equal(r.msg, msg)
    })
  })
}

describe('check_concurrency', () => {
  let plugin, c
  beforeEach(() => {
    plugin = configured()
    c = conn()
  })

  for (const [label, setup, rc, msg] of [
    ['no configured limit', () => {}, undefined, undefined],
    [
      'at the max',
      (p, cn) => {
        p.cfg.concurrency = { max: 4 }
        cn.results.add(p, { concurrent_count: 4 })
      },
      undefined,
      undefined,
    ],
    [
      'over the max',
      (p, cn) => {
        p.cfg.concurrency = { max: 4 }
        cn.results.add(p, { concurrent_count: 5 })
      },
      DENYSOFTDISCONNECT,
      'Too many concurrent connections',
    ],
  ]) {
    it(label, async () => {
      setup(plugin, c)
      const r = await hook(plugin, 'check_concurrency', c)
      assert.equal(r.rc, rc)
      assert.equal(r.msg, msg)
    })
  }

  it('records concurrent.unset when the count is not a number', async () => {
    plugin.cfg.concurrency = { max: 5 }
    c.results.add(plugin, { concurrent_count: 'nope' })
    const { rc } = await hook(plugin, 'check_concurrency', c)
    assert.equal(rc, undefined)
    assert.equal(c.results.get(plugin).err.join(' '), 'concurrent.unset')
  })

  it('treats a 0 (unlimited) history limit as unlimited, not an error', async () => {
    plugin.cfg = {
      concurrency: { max: 5 },
      concurrency_history: { enabled: true, plugin: 'karma', good: 0 },
      main: {},
    }
    c.results.add({ name: 'karma' }, { history: 1 }) // good reputation
    c.results.add(plugin, { concurrent_count: 5 })
    const { rc } = await hook(plugin, 'check_concurrency', c)
    assert.equal(rc, undefined)
    assert.equal(c.results.get(plugin).err.length, 0)
  })
})

describe('get_limit', () => {
  it('uses max_relaying for relaying recipients', () => {
    const plugin = bare({ recipients: { max: 5, max_relaying: 100 } })
    const c = conn()
    c.relaying = true
    assert.equal(plugin.get_limit('recipients', c), 100)
  })

  it('respects an explicit 0 (unlimited) max over the default', () => {
    const plugin = bare({ concurrency: { max: 0, default: 5 } })
    assert.equal(plugin.get_limit('concurrency', conn()), 0)
  })

  it('returns a 0 (unlimited) history limit instead of the configured max', () => {
    const plugin = bare({
      concurrency: { max: 5 },
      concurrency_history: { enabled: true, plugin: 'karma', good: 0 },
    })
    const c = conn()
    c.results.add({ name: 'karma' }, { history: 1 }) // good reputation
    assert.equal(plugin.get_limit('concurrency', c), 0)
  })
})

describe('get_concurrency_key', () => {
  it('keys on the remote ip', () => {
    const plugin = bare()
    assert.equal(
      plugin.get_concurrency_key(conn({ ip: '10.0.0.1' })),
      'concurrency|10.0.0.1',
    )
  })
})

describe('penalize', () => {
  it('tarpits before returning the code', async () => {
    const plugin = bare({ main: { tarpit_delay: 0.001 } })
    const started = Date.now()
    const { rc, msg } = await new Promise((resolve) => {
      plugin.penalize(conn(), false, 'slow down', (code, m) =>
        resolve({ rc: code, msg: m }),
      )
    })
    assert.equal(rc, DENYSOFT)
    assert.equal(msg, 'slow down')
    assert.ok(Date.now() >= started)
  })
})

describe('connection concurrency (redis)', () => {
  let plugin, c

  before(async () => {
    plugin = await redisPlugin(7)
  })
  after(async () => {
    if (plugin?.db) await plugin.db.quit()
  })
  beforeEach(async () => {
    await plugin.db.flushDb()
    plugin.cfg = { concurrency: { max: 5 }, main: {} }
    c = conn({ ip: '1.2.3.4' })
  })

  it('incr is a no-op without a db', async () => {
    const noDb = bare({ concurrency: { max: 5 } })
    assert.equal((await hook(noDb, 'conn_concur_incr', c)).rc, undefined)
  })

  it('incr increments and records the count', async () => {
    await hook(plugin, 'conn_concur_incr', c)
    assert.equal(c.results.get(plugin).concurrent_count, 1)
  })

  it('incr repairs a negative counter back to 1', async () => {
    await plugin.db.set('concurrency|1.2.3.4', -5)
    await hook(plugin, 'conn_concur_incr', c)
    assert.match(
      c.results.get(plugin).msg.join(' '),
      /resetting concurrent -4 to 1/,
    )
  })

  it('incr records an error on a real WRONGTYPE', async () => {
    await plugin.db.set('concurrency|1.2.3.4', 'not-an-int')
    await hook(plugin, 'conn_concur_incr', c)
    assert.match(c.results.get(plugin).err.join(' '), /conn_concur_incr/)
  })

  it('incr records an error when redis returns NaN (fault injection)', async () => {
    const orig = plugin.db.incr
    plugin.db.incr = async () => NaN
    try {
      await hook(plugin, 'conn_concur_incr', c)
      assert.match(c.results.get(plugin).err.join(' '), /isNaN/)
    } finally {
      plugin.db.incr = orig
    }
  })

  it('decr is a no-op without a db', async () => {
    const noDb = bare({ concurrency: { max: 5 } })
    assert.equal((await hook(noDb, 'conn_concur_decr', c)).rc, undefined)
  })

  it('decr decrements the counter', async () => {
    await plugin.db.set('concurrency|1.2.3.4', 4)
    await hook(plugin, 'conn_concur_decr', c)
    assert.equal(await plugin.db.get('concurrency|1.2.3.4'), '3')
  })

  it('decr records an error on a real WRONGTYPE', async () => {
    await plugin.db.set('concurrency|1.2.3.4', 'not-an-int')
    await hook(plugin, 'conn_concur_decr', c)
    assert.match(c.results.get(plugin).err.join(' '), /conn_concur_decr/)
  })

  it('decr sets a ttl so a key recreated after expiry cannot leak', async () => {
    // no prior key: mimics a connection that outlived the incr-set TTL
    await hook(plugin, 'conn_concur_decr', c)
    const ttl = await plugin.db.ttl('concurrency|1.2.3.4')
    assert.ok(ttl > 0, `expected a positive ttl, got ${ttl}`)
  })

  it('incr records an error when expire rejects (fault injection)', async () => {
    const orig = plugin.db.expire
    plugin.db.expire = async () => {
      throw new Error('expire boom')
    }
    try {
      await hook(plugin, 'conn_concur_incr', c)
      assert.match(c.results.get(plugin).err.join(' '), /expire boom/)
    } finally {
      plugin.db.expire = orig
    }
  })

  it('prune arms a ttl on leaked (ttl-less) keys it owns', async () => {
    await plugin.db.set('concurrency|9.9.9.9', -1) // leaked concurrency key
    await plugin.db.set('concurrency|8.8.8.8', 3)
    await plugin.db.expire('concurrency|8.8.8.8', 120) // healthy: has ttl
    await plugin.db.hSet('outbound-rate:undefined', 'TOTAL', '-1') // leaked bucket
    await plugin.db.set('other-plugin|key', 1) // unrelated: must be untouched

    await new Promise((resolve) => plugin.prune_stale_keys(resolve))

    assert.ok((await plugin.db.ttl('concurrency|9.9.9.9')) > 0)
    assert.ok((await plugin.db.ttl('concurrency|8.8.8.8')) > 0)
    assert.ok((await plugin.db.ttl('outbound-rate:undefined')) > 0)
    assert.equal(await plugin.db.ttl('other-plugin|key'), -1)
  })

  it('prune is a no-op without a db', async () => {
    const noDb = bare({ concurrency: {} })
    await new Promise((resolve) => noDb.prune_stale_keys(resolve))
  })
})
