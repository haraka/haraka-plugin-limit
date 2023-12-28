'use strict';

const assert = require('assert')

const path         = require('path');
const fixtures     = require('haraka-test-fixtures');

const default_config = {
    main: { tarpit_delay: 0 },
    outbound: { enabled: false },
    recipients: { enabled: false },
    recipients_history: { enabled: false },
    unrecognized_commands: { enabled: false },
    errors: { enabled: false },
    rate_conn: { '127': 0, enabled: false, default: 5 },
    rate_conn_history: { enabled: false },
    rate_rcpt: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_host: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_sender: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_null: { enabled: false, default: 1 },
    redis: { database: 4, socket: { host: '127.0.0.1', port: '6379' } },
    concurrency: { plugin: 'karma', good: 10, bad: 1, none: 2 },
    concurrency_history: { enabled: false },
};

describe('plugin_setup', function () {

    before(function () {
        this.plugin = new fixtures.plugin('index');
        this.plugin.config = this.plugin.config.module_config(path.resolve('test'));
    })

    it('loads config', function () {
        // gotta inherit b/c config loader merges in defaults from redis.ini
        this.plugin.inherits('haraka-plugin-redis');
        this.plugin.load_limit_ini();
        assert.deepEqual(this.plugin.cfg, default_config); // loaded config
    })

    it('registers', function () {
        this.plugin.register();
        assert.deepEqual(this.plugin.cfg, default_config);
    })
})
