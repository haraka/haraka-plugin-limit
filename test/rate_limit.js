'use strict';

const assert       = require('assert')
const path         = require('path');

const Address      = require('address-rfc2821').Address;
const constants    = require('haraka-constants');
const fixtures     = require('haraka-test-fixtures');

function setUp () {
    this.plugin = new fixtures.plugin('rate_limit');

    this.connection = new fixtures.connection.createConnection();
    this.connection.remote = { ip: '1.2.3.4', host: 'test.com' };

    this.plugin.register();
}

describe('get_host_key', function () {
    before(setUp)
    it('rate_conn', function () {
        const [ ip, limit ] = this.plugin.get_host_key('rate_conn', this.connection)
        assert.equal(ip, '1.2.3.4');
        assert.equal(limit, 5);
    })

    it('rate_rcpt_host', function () {
        const [ ip, limit ] = this.plugin.get_host_key('rate_rcpt_host', this.connection)
        assert.equal(ip, '1.2.3.4');
        assert.equal(limit, '50/5m');
    })
})

describe('get_mail_key', function () {
    beforeEach(function () {
        this.plugin = new fixtures.plugin('rate_limit');
        this.connection = new fixtures.connection.createConnection();
        this.plugin.register();
    })

    it('rate_rcpt_sender', function () {
        const [ addr, limit ] = this.plugin.get_mail_key('rate_rcpt_sender', new Address('<user@example.com>'))
        // console.log(arguments);
        assert.equal(addr, 'user@example.com');
        assert.equal(limit, '50/5m');
    })
    it('rate_rcpt_null', function () {
        const [ addr, limit ] = this.plugin.get_mail_key('rate_rcpt_null', new Address('<postmaster>'))
        // console.log(arguments);
        assert.equal(addr, 'postmaster');
        assert.equal(limit, '1');
    })
    it('rate_rcpt', function () {
        const [ addr, limit ] = this.plugin.get_mail_key('rate_rcpt', new Address('<user@example.com>'))
        // console.log(arguments);
        assert.equal(addr, 'user@example.com');
        assert.equal(limit, '50/5m');
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

    it('no limit', async function () {
        const is_limited = await this.plugin.rate_limit(this.connection, 'key', 0)
        assert.equal(is_limited, false);
    })

    it('below 50/5m limit', async function () {
        const is_limited = await this.plugin.rate_limit(this.connection, 'key', '50/5m')
        assert.equal(is_limited, false);
    })
})

describe('rate_conn', function () {
    beforeEach(function (done) {
        this.server = { notes: {} };

        this.plugin = new fixtures.plugin('rate_limit');
        this.plugin.config = this.plugin.config.module_config(path.resolve('test'));

        this.connection = new fixtures.connection.createConnection();
        this.connection.remote.ip = '1.2.3.4';
        this.connection.remote.host = 'mail.example.com';

        this.plugin.register();
        this.plugin.init_redis_plugin(function () {
            done();
        },
        this.server);
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