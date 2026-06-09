const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('node:test')

const constants = require('haraka-constants')
const { assertResult } = require('haraka-test-fixtures')

const { Address, bare, conn, hook, redisPlugin } = require('./helpers')

const { DENYSOFT, DENYSOFTDISCONNECT } = constants

describe('get_host_key', () => {
  // [label, type, cfg, remote, expected | undefined, errRegExp?]
  const cases = [
    [
      'rate_conn default',
      'rate_conn',
      { rate_conn: { default: 5 } },
      { ip: '1.2.3.4', host: 'test.com' },
      ['1.2.3.4', 5],
    ],
    [
      'rate_rcpt_host default',
      'rate_rcpt_host',
      { rate_rcpt_host: { default: '50/5m' } },
      { ip: '1.2.3.4', host: 'test.com' },
      ['1.2.3.4', '50/5m'],
    ],
    [
      'rDNS host match',
      'rate_conn',
      { rate_conn: { 'mail.example.com': 3 } },
      { ip: '8.8.8.8', host: 'mail.example.com' },
      ['mail.example.com', 3],
    ],
    [
      'IPv6 address (normalized, full)',
      'rate_conn',
      { rate_conn: { '2001:db8:0:0:0:0:0:5': 7 } },
      { ip: '2001:db8::5', host: '' },
      ['2001:db8:0:0:0:0:0:5', 7],
    ],
    [
      'IPv6 prefix (group-wise pop)',
      'rate_conn',
      { rate_conn: { '2001:db8': 9 } },
      { ip: '2001:db8::5', host: '' },
      ['2001:db8', 9],
    ],
    [
      'custom default',
      'rate_conn',
      { rate_conn: { default: 5 } },
      { ip: '8.8.8.8', host: 'mail.example.com' },
      ['8.8.8.8', 5],
    ],
    [
      'unlimited (0) with no match',
      'rate_conn',
      { rate_conn: {} },
      { ip: '8.8.8.8', host: 'mail.example.com' },
      ['8.8.8.8', 0],
    ],
    [
      'error: type not configured',
      'rate_conn',
      {},
      { ip: '8.8.8.8', host: '' },
      undefined,
      /rate_conn: not configured/,
    ],
    [
      'error: unparseable ip',
      'rate_conn',
      { rate_conn: { default: 5 } },
      { ip: 'not-an-ip', host: '' },
      undefined,
      /rate_conn:/,
    ],
  ]

  for (const [label, type, cfg, remote, expected, errRe] of cases) {
    it(label, () => {
      const plugin = bare(cfg)
      const c = conn(remote)
      const r = plugin.get_host_key(type, c)
      if (expected === undefined) {
        assert.equal(r, undefined)
        assert.match(c.results.get(plugin).err.join(' '), errRe)
      } else {
        assert.deepEqual(r, expected)
      }
    })
  }

  it('falls back to the history limit', () => {
    const plugin = bare({
      rate_conn: {},
      rate_conn_history: { enabled: true, plugin: 'karma', good: 11 },
    })
    const c = conn({ ip: '8.8.8.8', host: '' })
    c.results.add({ name: 'karma' }, { history: 1 }) // good
    assert.deepEqual(plugin.get_host_key('rate_conn', c), ['8.8.8.8', 11])
  })

  it('a 0 (unlimited) history limit overrides the configured default', () => {
    const plugin = bare({
      rate_conn: { default: 5 },
      rate_conn_history: { enabled: true, plugin: 'karma', good: 0 },
    })
    const c = conn({ ip: '8.8.8.8', host: '' })
    c.results.add({ name: 'karma' }, { history: 1 }) // good
    assert.deepEqual(plugin.get_host_key('rate_conn', c), ['8.8.8.8', 0])
  })
})

describe('get_mail_key', () => {
  // [label, type, cfg, address, expected]
  const cases = [
    [
      'full email address',
      'rate_rcpt',
      { rate_rcpt: { 'user@example.com': 2 } },
      '<user@example.com>',
      ['user@example.com', 2],
    ],
    [
      'RHS host',
      'rate_rcpt',
      { rate_rcpt: { 'host.example.com': 3 } },
      '<user@host.example.com>',
      ['host.example.com', 3],
    ],
    [
      'custom default',
      'rate_rcpt',
      { rate_rcpt: { default: '9/1m' } },
      '<user@nomatch.com>',
      ['user@nomatch.com', '9/1m'],
    ],
    [
      'unlimited (0) with no match',
      'rate_rcpt',
      { rate_rcpt: {} },
      '<user@nomatch.com>',
      ['user@nomatch.com', 0],
    ],
    [
      'rate_rcpt_sender default',
      'rate_rcpt_sender',
      { rate_rcpt_sender: { default: '50/5m' } },
      '<user@example.com>',
      ['user@example.com', '50/5m'],
    ],
    [
      'rate_rcpt_null postmaster default',
      'rate_rcpt_null',
      { rate_rcpt_null: { default: 1 } },
      '<postmaster>',
      ['postmaster', 1],
    ],
  ]

  for (const [label, type, cfg, addr, expected] of cases) {
    it(label, () => {
      const r = bare(cfg).get_mail_key(type, new Address(addr))
      assert.deepEqual(r, expected)
    })
  }

  it('returns undefined when type unconfigured or mail missing', () => {
    assert.equal(bare().get_mail_key('rate_rcpt', null), undefined)
    assert.equal(
      bare({ rate_rcpt: {} }).get_mail_key('rate_rcpt', null),
      undefined,
    )
  })
})

describe('redis-backed rate limits', () => {
  let plugin

  before(async () => {
    plugin = await redisPlugin(5)
  })
  after(async () => {
    if (plugin?.db) await plugin.db.quit()
  })
  beforeEach(async () => {
    await plugin.db.flushDb()
  })

  describe('rate_limit', () => {
    let c
    beforeEach(() => {
      plugin.cfg = {}
      c = conn()
    })

    it('disabled (value 0) returns false', async () => {
      assert.equal(await plugin.rate_limit(c, 'k', 0), false)
    })

    it('returns undefined without a db', async () => {
      assert.equal(await bare().rate_limit(c, 'k', '5/1m'), undefined)
    })

    it('records a syntax error for a bad value', async () => {
      assert.equal(await plugin.rate_limit(c, 'k', 'abc'), undefined)
      assert.match(c.results.get(plugin).err.join(' '), /syntax error/)
    })

    for (const value of ['5/2m', '5/2h', '5/2d', '5/2s']) {
      it(`parses "${value}" and stays under the limit`, async () => {
        assert.equal(await plugin.rate_limit(c, `k:${value}`, value), false)
      })
    }

    it('rejects an unrecognized time unit as a syntax error', async () => {
      assert.equal(await plugin.rate_limit(c, 'k', '5/2x'), undefined)
      assert.match(c.results.get(plugin).err.join(' '), /syntax error/)
    })

    it('trips when the count exceeds the limit', async () => {
      await plugin.db.set('hot', 2)
      assert.equal(await plugin.rate_limit(c, 'hot', '2/1m'), true)
    })

    it('records an error on a real redis WRONGTYPE', async () => {
      await plugin.db.hSet('hashkey', 'f', '1') // wrong type for INCR
      await plugin.rate_limit(c, 'hashkey', '5/1m')
      assert.match(c.results.get(plugin).err.join(' '), /hashkey/)
    })
  })

  describe('rate_rcpt_host', () => {
    let c
    beforeEach(() => {
      plugin.cfg = { rate_rcpt_host: { '1.2.3.4': '2/5m' }, main: {} }
      c = conn({ ip: '1.2.3.4', host: '' })
    })

    it('incr increments the host counter', async () => {
      await hook(plugin, 'rate_rcpt_host_incr', c)
      assert.equal(await plugin.db.get('rate_rcpt_host:1.2.3.4'), '1')
    })

    it('incr is a no-op without a db', async () => {
      assert.equal(
        (await hook(bare(plugin.cfg), 'rate_rcpt_host_incr', c)).rc,
        undefined,
      )
    })

    it('incr records an error on a real WRONGTYPE', async () => {
      await plugin.db.hSet('rate_rcpt_host:1.2.3.4', 'f', '1')
      await hook(plugin, 'rate_rcpt_host_incr', c)
      assertResult(c, plugin, 'err')
    })

    it('enforce passes when no counter is stored', async () => {
      assert.equal(
        (await hook(plugin, 'rate_rcpt_host_enforce', c)).rc,
        undefined,
      )
    })

    it('enforce passes when under the limit', async () => {
      await plugin.db.set('rate_rcpt_host:1.2.3.4', 1)
      assert.equal(
        (await hook(plugin, 'rate_rcpt_host_enforce', c)).rc,
        undefined,
      )
    })

    it('enforce penalizes when over the limit', async () => {
      await plugin.db.set('rate_rcpt_host:1.2.3.4', 9)
      const { rc, msg } = await hook(plugin, 'rate_rcpt_host_enforce', c)
      assert.equal(rc, DENYSOFT)
      assert.equal(msg, 'recipient rate limit exceeded')
      assert.equal(c.results.get(plugin).fail.join(' '), 'rate_rcpt_host')
    })

    it('enforce records an error on a real WRONGTYPE', async () => {
      await plugin.db.hSet('rate_rcpt_host:1.2.3.4', 'f', '1')
      const { rc } = await hook(plugin, 'rate_rcpt_host_enforce', c)
      assert.equal(rc, undefined)
      assert.match(c.results.get(plugin).err.join(' '), /rate_rcpt_host/)
    })

    it('enforce records syntax error and passes on a malformed limit value', async () => {
      plugin.cfg.rate_rcpt_host['1.2.3.4'] = 'totally-bogus'
      const { rc } = await hook(plugin, 'rate_rcpt_host_enforce', c)
      assert.equal(rc, undefined)
      assert.match(
        c.results.get(plugin).err.join(' '),
        /rate_rcpt_host:syntax:totally-bogus/,
      )
    })
  })

  describe('rate_conn', () => {
    let c
    beforeEach(() => {
      plugin.cfg = { rate_conn: { '1.2.3.4': '2/5m' }, main: {} }
      c = conn({ ip: '1.2.3.4', host: '' })
    })

    it('incr then enforce passes under the default limit', async () => {
      plugin.cfg.rate_conn = { default: 5 }
      await hook(plugin, 'rate_conn_incr', c)
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.match(c.results.get(plugin).rate_conn, /^1:/)
    })

    it('incr records an error on a real WRONGTYPE', async () => {
      await plugin.db.set('rate_conn:1.2.3.4', 'str')
      await hook(plugin, 'rate_conn_incr', c)
      assertResult(c, plugin, 'err')
    })

    it('enforce flags a bad limit syntax', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = 'abc'
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.match(c.results.get(plugin).err.join(' '), /rate_conn:syntax/)
    })

    it('enforce expires stale timestamps and passes', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = '5/5m'
      const key = 'rate_conn:1.2.3.4'
      await plugin.db.hSet(key, '1000', '1') // ancient (epoch 1s)
      await plugin.db.hSet(key, String(Date.now()), '1') // fresh
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.equal((await plugin.db.hGetAll(key))['1000'], undefined)
    })

    it('enforce penalizes when over the limit', async () => {
      const key = 'rate_conn:1.2.3.4'
      const now = Date.now()
      await plugin.db.hSet(key, String(now), '5')
      await plugin.db.hSet(key, String(now + 1), '5')
      const { rc, msg } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, DENYSOFTDISCONNECT)
      assert.equal(msg, 'connection rate limit exceeded')
    })

    it('enforce honors a sub-minute window (30s, not a whole minute)', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = '5/30s'
      const key = 'rate_conn:1.2.3.4'
      const now = Date.now()
      const stale = String(now - 45000) // 45s ago: outside the 30s window
      await plugin.db.hSet(key, stale, '1')
      await plugin.db.hSet(key, String(now), '1')
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.equal((await plugin.db.hGetAll(key))[stale], undefined)
    })

    it('enforce prunes multiple stale timestamps in a single hDel', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = '5/30s'
      const key = 'rate_conn:1.2.3.4'
      const now = Date.now()
      const stale1 = String(now - 60000)
      const stale2 = String(now - 45000)
      await plugin.db.hSet(key, stale1, '1')
      await plugin.db.hSet(key, stale2, '1')
      await plugin.db.hSet(key, String(now), '1')

      const orig = plugin.db.hDel.bind(plugin.db)
      let calls = 0
      plugin.db.hDel = (...args) => {
        calls++
        return orig(...args)
      }
      try {
        await hook(plugin, 'rate_conn_enforce', c)
      } finally {
        plugin.db.hDel = orig
      }

      const remaining = await plugin.db.hGetAll(key)
      assert.equal(remaining[stale1], undefined)
      assert.equal(remaining[stale2], undefined)
      assert.equal(remaining[String(now)], '1')
      assert.equal(calls, 1) // batched, not one round-trip per stale field
    })

    it('enforce flags an invalid time unit instead of over-counting', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = '5/2x' // valid limit, bad unit
      const key = 'rate_conn:1.2.3.4'
      const now = Date.now()
      // more events than the limit: with a NaN window these would all count
      for (let i = 0; i < 9; i++)
        await plugin.db.hSet(key, String(now + i), '1')
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.match(
        c.results.get(plugin).err.join(' '),
        /rate_conn:syntax:5\/2x/,
      )
    })

    it('incr flags an invalid time unit and stores nothing', async () => {
      plugin.cfg.rate_conn['1.2.3.4'] = '5/2x'
      const { rc } = await hook(plugin, 'rate_conn_incr', c)
      assert.equal(rc, undefined)
      assert.match(
        c.results.get(plugin).err.join(' '),
        /rate_conn:syntax:5\/2x/,
      )
      assert.equal(await plugin.db.exists('rate_conn:1.2.3.4'), 0)
    })

    it('enforce passes (no throw) when the ip is unparseable', async () => {
      const badConn = conn({ ip: 'not-an-ip', host: '' })
      const { rc } = await hook(plugin, 'rate_conn_enforce', badConn)
      assert.equal(rc, undefined)
    })

    it('enforce records an error on a real WRONGTYPE', async () => {
      await plugin.db.set('rate_conn:1.2.3.4', 'str')
      const { rc } = await hook(plugin, 'rate_conn_enforce', c)
      assert.equal(rc, undefined)
      assert.match(c.results.get(plugin).err.join(' '), /rate_conn/)
    })

    it('enforce errors when no timestamps stored (fault injection)', async () => {
      // real redis hGetAll yields {} (not falsy) for a missing hash
      const orig = plugin.db.hGetAll
      plugin.db.hGetAll = async () => null
      try {
        const { rc } = await hook(plugin, 'rate_conn_enforce', c)
        assert.equal(rc, undefined)
        assert.match(
          c.results.get(plugin).err.join(' '),
          /rate_conn:no_tstamps/,
        )
      } finally {
        plugin.db.hGetAll = orig
      }
    })
  })

  describe('rate_rcpt_sender / rate_rcpt_null / rate_rcpt', () => {
    let c
    beforeEach(() => {
      plugin.cfg = {
        rate_rcpt_sender: { 'spammer@x.com': '1/1m' },
        rate_rcpt_null: { default: '1/1m' },
        rate_rcpt: { 'victim@y.com': '1/1m' },
        main: {},
      }
      c = conn()
    })

    it('rate_rcpt_sender penalizes when over', async () => {
      c.transaction.mail_from = new Address('<spammer@x.com>')
      await plugin.db.set('rate_rcpt_sender:spammer@x.com', 5)
      const { rc, msg } = await hook(plugin, 'rate_rcpt_sender', c)
      assert.equal(rc, DENYSOFT)
      assert.equal(msg, 'rcpt rate limit exceeded')
    })

    it('rate_rcpt_null skips when no params', async () => {
      assert.equal((await hook(plugin, 'rate_rcpt_null', c)).rc, undefined)
    })

    it('rate_rcpt_null skips when mail_from is not the null sender', async () => {
      c.transaction.mail_from = new Address('<sender@x.com>')
      await plugin.db.set('rate_rcpt_null:user@y.com', 5)
      const { rc } = await hook(
        plugin,
        'rate_rcpt_null',
        c,
        new Address('<user@y.com>'),
      )
      assert.equal(rc, undefined)
    })

    it('rate_rcpt_null penalizes the recipient when mail_from is null and over', async () => {
      c.transaction.mail_from = new Address('<>')
      await plugin.db.set('rate_rcpt_null:user@y.com', 5)
      const { rc, msg } = await hook(plugin, 'rate_rcpt_null', c, [
        new Address('<user@y.com>'),
      ])
      assert.equal(rc, DENYSOFT)
      assert.equal(msg, 'null recip rate limit')
    })

    it('rate_rcpt penalizes when over', async () => {
      await plugin.db.set('rate_rcpt:victim@y.com', 5)
      const { rc, msg } = await hook(plugin, 'rate_rcpt', c, [
        new Address('<victim@y.com>'),
      ])
      assert.equal(rc, DENYSOFT)
      assert.equal(msg, 'rate limit exceeded')
    })

    it('rate_rcpt passes when under', async () => {
      const { rc } = await hook(plugin, 'rate_rcpt', c, [
        new Address('<victim@y.com>'),
      ])
      assert.equal(rc, undefined)
    })

    it('rate_rcpt passes (no throw) when the recipient is missing', async () => {
      const { rc } = await hook(plugin, 'rate_rcpt', c, [null])
      assert.equal(rc, undefined)
    })
  })
})
