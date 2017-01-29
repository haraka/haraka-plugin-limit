'use strict';

var path         = require('path');

var Address      = require('address-rfc2821').Address;
var constants    = require('haraka-constants');
var fixtures     = require('haraka-test-fixtures');

exports.get_host_key = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('rate_limit');

        this.connection = new fixtures.connection.createConnection();
        this.connection.remote = { ip: '1.2.3.4', host: 'test.com' };

        this.plugin.register();
        done();
    },
    'rate_conn' : function (test) {
        test.expect(3);
        this.plugin.get_host_key('rate_conn', this.connection, function (err, ip, limit) {
            test.equal(err, undefined);
            test.equal(ip, '1.2.3.4');
            test.equal(limit, 5);
            test.done();
        });
    },
    'rate_rcpt_host' : function (test) {
        test.expect(3);
        this.plugin.get_host_key('rate_rcpt_host', this.connection, function (err, ip, limit) {
            test.equal(err, undefined);
            test.equal(ip, '1.2.3.4');
            test.equal(limit, '50/5m');
            test.done();
        });
    },
}

exports.get_mail_key = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
        done();
    },
    'rate_rcpt_sender' : function (test) {
        test.expect(2);
        this.plugin.get_mail_key('rate_rcpt_sender', new Address('<user@example.com>'), function (addr, limit) {
            // console.log(arguments);
            test.equal(addr, 'user@example.com');
            test.equal(limit, '50/5m');
            test.done();
        });
    },
    'rate_rcpt_null' : function (test) {
        test.expect(2);
        this.plugin.get_mail_key('rate_rcpt_null', new Address('<postmaster>'), function (addr, limit) {
            // console.log(arguments);
            test.equal(addr, 'postmaster');
            test.equal(limit, '1');
            test.done();
        });
    },
    'rate_rcpt' : function (test) {
        test.expect(2);
        this.plugin.get_mail_key('rate_rcpt', new Address('<user@example.com>'), function (addr, limit) {
            // console.log(arguments);
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
            // console.log(arguments);
            test.equal(err, undefined);
            test.equal(is_limited, false);
            test.done();
        })
    },
    'below 50/5m limit' : function (test) {
        test.expect(2);
        this.plugin.rate_limit(this.connection, 'key', '50/5m', function (err, is_limited) {
            // console.log(arguments);
            test.equal(err, undefined);
            test.equal(is_limited, false);
            test.done();
        })
    }
}

exports.rate_conn = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.plugin.config = this.plugin.config.module_config(path.resolve('test'));

        this.connection = new fixtures.connection.createConnection();
        this.connection.remote.ip = '1.2.3.4';
        this.connection.remote.host = 'mail.example.com';

        this.plugin.register();
        var server = { notes: {} };
        this.plugin.init_redis_plugin(function () {
            done();
        },
        server);
    },
    'default limit' : function (test) {
        test.expect(3);
        var plugin = this.plugin;
        var connection = this.connection;

        plugin.rate_conn_incr(function () {
            plugin.rate_conn_enforce(function (code, msg) {
                var rc = connection.results.get(plugin.name);
                test.ok(rc.rate_conn);

                var match = /([\d]+):(.*)$/.exec(rc.rate_conn);  // 1/5

                if (parseInt(match[1]) <= parseInt(match[2])) {
                    test.equal(code, undefined);
                    test.equal(msg, undefined);
                }
                else {
                    test.equal(code, constants.DENYSOFTDISCONNECT);
                    test.equal(msg, 'connection rate limit exceeded');
                }
                test.done();
            }.bind(this),
            connection);
        }, connection);
    },
    'defined limit' : function (test) {
        test.expect(3);
        var plugin = this.plugin;
        var connection = this.connection;
        plugin.cfg.rate_conn['1.2.3.4'] = '1/5m';

        plugin.rate_conn_incr(function () {
            plugin.rate_conn_enforce(function (code, msg) {
                var rc = connection.results.get(plugin.name);
                test.ok(rc.rate_conn);
                var match = /^([\d]+):(.*)$/.exec(rc.rate_conn);  // 1/5m
                if (parseInt(match[1]) <= parseInt(match[2])) {
                    test.equal(code, undefined);
                    test.equal(msg, undefined);
                }
                else {
                    test.equal(code, constants.DENYSOFTDISCONNECT);
                    test.equal(msg, 'connection rate limit exceeded');
                }
                test.done();
            }.bind(this),
            connection);
        }, connection);
    },
}