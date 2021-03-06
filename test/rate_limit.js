'use strict';

const assert       = require('assert')
const path         = require('path');

const Address      = require('address-rfc2821').Address;
const constants    = require('haraka-constants');
const fixtures     = require('haraka-test-fixtures');

function setUp (done) {
    this.plugin = new fixtures.plugin('rate_limit');

    this.connection = new fixtures.connection.createConnection();
    this.connection.remote = { ip: '1.2.3.4', host: 'test.com' };

    this.plugin.register();
    done();
}

describe('get_host_key', function () {
    before(setUp)
    it('rate_conn', function (done) {
        this.plugin.get_host_key('rate_conn', this.connection, function (err, ip, limit) {
            assert.equal(err, undefined);
            assert.equal(ip, '1.2.3.4');
            assert.equal(limit, 5);
            done();
        })
    })

    it('rate_rcpt_host', function (done) {
        this.plugin.get_host_key('rate_rcpt_host', this.connection, function (err, ip, limit) {
            assert.equal(err, undefined);
            assert.equal(ip, '1.2.3.4');
            assert.equal(limit, '50/5m');
            done();
        })
    })
})

describe('get_mail_key', function () {
    beforeEach(function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
        done();
    })

    it('rate_rcpt_sender', function (done) {
        this.plugin.get_mail_key('rate_rcpt_sender', new Address('<user@example.com>'), function (addr, limit) {
            // console.log(arguments);
            assert.equal(addr, 'user@example.com');
            assert.equal(limit, '50/5m');
            done();
        });
    })
    it('rate_rcpt_null', function (done) {
        this.plugin.get_mail_key('rate_rcpt_null', new Address('<postmaster>'), function (addr, limit) {
            // console.log(arguments);
            assert.equal(addr, 'postmaster');
            assert.equal(limit, '1');
            done();
        });
    })
    it('rate_rcpt', function (done) {
        this.plugin.get_mail_key('rate_rcpt', new Address('<user@example.com>'), function (addr, limit) {
            // console.log(arguments);
            assert.equal(addr, 'user@example.com');
            assert.equal(limit, '50/5m');
            done();
        });
    })
})

describe('rate_limit', function () {
    beforeEach(function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
        const server = { notes: {} };
        this.plugin.init_redis_plugin(function () {
            done();
        },
        server);
    })

    it('no limit', function (done) {
        this.plugin.rate_limit(this.connection, 'key', 0, function (err, is_limited) {
            // console.log(arguments);
            assert.equal(err, undefined);
            assert.equal(is_limited, false);
            done();
        })
    })

    it('below 50/5m limit', function (done) {
        this.plugin.rate_limit(this.connection, 'key', '50/5m', function (err, is_limited) {
            // console.log(arguments);
            assert.equal(err, undefined);
            assert.equal(is_limited, false);
            done();
        })
    })
})

describe('rate_conn', function () {
    beforeEach(function (done) {
        this.plugin = new fixtures.plugin('rate_limit');
        this.plugin.config = this.plugin.config.module_config(path.resolve('test'));

        this.connection = new fixtures.connection.createConnection();
        this.connection.remote.ip = '1.2.3.4';
        this.connection.remote.host = 'mail.example.com';

        this.plugin.register();
        const server = { notes: {} };
        this.plugin.init_redis_plugin(function () {
            done();
        },
        server);
    })

    it('default limit', function (done) {
        const plugin = this.plugin;
        const connection = this.connection;

        plugin.rate_conn_incr(function () {
            plugin.rate_conn_enforce(function (code, msg) {
                const rc = connection.results.get(plugin.name);
                assert.ok(rc.rate_conn);

                const match = /([\d]+):(.*)$/.exec(rc.rate_conn);  // 1/5

                if (parseInt(match[1]) <= parseInt(match[2])) {
                    assert.equal(code, undefined);
                    assert.equal(msg, undefined);
                }
                else {
                    assert.equal(code, constants.DENYSOFTDISCONNECT);
                    assert.equal(msg, 'connection rate limit exceeded');
                }
                done();
            }.bind(this),
            connection);
        }, connection);
    })

    it('defined limit', function (done) {
        const plugin = this.plugin;
        const connection = this.connection;
        plugin.cfg.rate_conn['1.2.3.4'] = '1/5m';

        plugin.rate_conn_incr(function () {
            plugin.rate_conn_enforce(function (code, msg) {
                const rc = connection.results.get(plugin.name);
                assert.ok(rc.rate_conn);
                const match = /^([\d]+):(.*)$/.exec(rc.rate_conn);  // 1/5m
                if (parseInt(match[1]) <= parseInt(match[2])) {
                    assert.equal(code, undefined);
                    assert.equal(msg, undefined);
                }
                else {
                    assert.equal(code, constants.DENYSOFTDISCONNECT);
                    assert.equal(msg, 'connection rate limit exceeded');
                }
                done();
            }.bind(this),
            connection);
        }, connection);
    })
})