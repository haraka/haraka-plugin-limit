'use strict';

var Address      = require('address-rfc2821').Address;
var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {
    this.plugin = new fixtures.plugin('index');
    this.connection = new fixtures.connection.createConnection();
    this.connection.transaction = new fixtures.transaction.createTransaction();
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
    rate_rcpt_null: { default: 1 }
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

exports.lookup_host_key = {
    setUp : function (done) {

        this.plugin = new fixtures.plugin('rate_limit');

        this.connection = new fixtures.connection.createConnection();
        this.connection.remote = { ip: '1.2.3.4', host: 'test.com' };
        // this.connection.transaction = new fixtures.transaction.createTransaction();

        this.plugin.register();
        done();
    },
    'rate_conn' : function (test) {
        test.expect(3);
        this.plugin.lookup_host_key('rate_conn', this.connection.remote, function (err, ip, limit) {
            test.equal(err, undefined);
            test.equal(ip, '1.2.3.4');
            test.equal(limit, 5);
            test.done();
        });
    },
    'rate_rcpt_host' : function (test) {
        test.expect(3);
        this.plugin.lookup_host_key('rate_rcpt_host', this.connection.remote, function (err, ip, limit) {
            test.equal(err, undefined);
            test.equal(ip, '1.2.3.4');
            test.equal(limit, '50/5m');
            test.done();
        });
    },
}

exports.lookup_mail_key = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
        done();
    },
    'rate_rcpt_sender' : function (test) {
        test.expect(3);
        this.plugin.lookup_mail_key('rate_rcpt_sender', new Address('<user@example.com>'), function (err, addr, limit) {
            // console.log(arguments);
            test.equal(err, undefined);
            test.equal(addr, 'user@example.com');
            test.equal(limit, '50/5m');
            test.done();
        });
    },
    'rate_rcpt_null' : function (test) {
        test.expect(3);
        this.plugin.lookup_mail_key('rate_rcpt_null', new Address('<postmaster>'), function (err, addr, limit) {
            // console.log(arguments);
            test.equal(err, undefined);
            test.equal(addr, 'postmaster');
            test.equal(limit, '1');
            test.done();
        });
    },
    'rate_rcpt' : function (test) {
        test.expect(3);
        this.plugin.lookup_mail_key('rate_rcpt', new Address('<user@example.com>'), function (err, addr, limit) {
            // console.log(arguments);
            test.equal(err, undefined);
            test.equal(addr, 'user@example.com');
            test.equal(limit, '50/5m');
            test.done();
        });
    },
}

exports.rate_limit = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
        var server = { notes: {} };
        this.plugin.init_redis_plugin(function () {
            done();
        },
        server);
    },
    'no limit' : function (test) {
        test.expect(2);
        this.plugin.rate_limit(this.connection, 'key', 0, function (err, is_limited) {
            console.log(arguments);
            test.equal(err, undefined);
            test.equal(is_limited, false);
            test.done();
        })
    },
    'below 50/5m limit' : function (test) {
        test.expect(2);
        this.plugin.rate_limit(this.connection, 'key', '50/5m', function (err, is_limited) {
            console.log(arguments);
            test.equal(err, undefined);
            test.equal(is_limited, false);
            test.done();
        })
    }
}
