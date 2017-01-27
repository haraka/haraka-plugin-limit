'use strict';

var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {
    this.plugin = new fixtures.plugin('index');
    done();
};

var default_config = {
    main: {},
    recipients: {},
    unrecognized_commands: {},
    errors: {},
    redis: { db: 4, host: '127.0.0.1', port: '6379' },
    concurrency: { },
    rate_conn: { '127': 0, default: 5 },
    rate_rcpt_host: { '127': 0, default: '50/5m' },
    rate_rcpt_sender: { '127': 0, default: '50/5m' },
    rate_rcpt: { '127': 0, default: '50/5m' },
    rate_rcpt_null: { default: 1 },
    outbound: { enabled: false }
};

exports.plugin_setup = {
    setUp : _set_up,
    'loads config': function (test) {
        test.expect(1);
        // gotta inhert b/c config loader merges in defaults from redis.ini
        this.plugin.inherits('haraka-plugin-redis');
        this.plugin.load_limit_ini();
        test.deepEqual(this.plugin.cfg, default_config); // loaded config
        test.done();
    },
    'registers': function (test) {
        test.expect(1);
        this.plugin.register();
        test.deepEqual(this.plugin.cfg, default_config); // loaded config
        test.done();
    },
};