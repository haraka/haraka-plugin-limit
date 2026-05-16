const assert = require('node:assert/strict')

const { describe, it } = require('node:test')

const { bare, conn } = require('./helpers')

describe('get_history_limit', () => {
  const HIST = { enabled: true, plugin: 'karma', good: 5, bad: 1, none: 2 }

  for (const [label, history, expected] of [
    ['good (history > 0)', 1, 5],
    ['bad (history < 0)', -1, 1],
    ['none (history == 0)', 0, 2],
  ]) {
    it(label, () => {
      const plugin = bare({ concurrency_history: { ...HIST } })
      const c = conn()
      c.results.add({ name: 'karma' }, { history })
      assert.equal(plugin.get_history_limit('concurrency', c), expected)
    })
  }

  it('disables the history config when its plugin has no results', () => {
    const plugin = bare({ concurrency_history: { ...HIST } })
    assert.equal(plugin.get_history_limit('concurrency', conn()), undefined)
    assert.equal(plugin.cfg.concurrency_history, undefined)
  })

  for (const [reason, cfg, results] of [
    ['results carry no history field', { ...HIST }, { note: 'x' }],
    ['the history config is disabled', { enabled: false }, null],
    ['no plugin is named', { enabled: true }, null],
  ]) {
    it(`returns undefined when ${reason}`, () => {
      const plugin = bare({ concurrency_history: cfg })
      const c = conn()
      if (results) c.results.add({ name: 'karma' }, results)
      assert.equal(plugin.get_history_limit('concurrency', c), undefined)
    })
  }
})
