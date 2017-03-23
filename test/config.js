'use strict';

var path         = require('path');
var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {
    this.plugin = new fixtures.plugin('index');
    this.plugin.config = this.plugin.config.module_config(path.resolve('test'));
    done();
};

var default_config = {
    main: { tarpit_delay: 0 },
    outbound: { enabled: false },
    recipients: { enabled: false },
    unrecognized_commands: { enabled: false },
    errors: { enabled: false },
    rate_conn: { '127': 0, enabled: false, default: 5 },
    rate_rcpt: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_host: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_sender: { '127': 0, enabled: false, default: '50/5m' },
    rate_rcpt_null: { enabled: false, default: 1 },
    redis: { db: 4, host: '127.0.0.1', port: '6379' },
    concurrency: { plugin: 'karma', good: 10, bad: 1, none: 2 }
};

exports.plugin_setup = {
    setUp : _set_up,
    'loads config': function (test) {
        test.expect(1);
        // gotta inherit b/c config loader merges in defaults from redis.ini
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
