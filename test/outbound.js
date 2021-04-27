'use strict';

const assert       = require('assert')

// var Address      = require('address-rfc2821').Address;
const constants    = require('haraka-constants');
const fixtures     = require('haraka-test-fixtures');

function _set_up (done) {
    this.plugin = new fixtures.plugin('index');
    // gotta inhert b/c config loader merges in defaults from redis.ini
    // this.plugin.inherits('haraka-plugin-redis');
    this.plugin.register();
    this.server = { notes: {} };
    this.plugin.init_redis_plugin(function () {
        // console.log(arguments);
        done();
    },
    this.server);
}

describe('outbound_increment', function () {
    before(_set_up);

    it('no limit, no delay', function (done) {
        this.plugin.outbound_increment(function (code, msg) {
            assert.equal(code, undefined);
            assert.equal(msg, undefined);
            done();
        },
        { domain: 'test.com'});
    })

    it('limits has delay', function (done) {
        const self = this;
        self.plugin.cfg.outbound['slow.test.com'] = 3;
        self.plugin.db.hset('outbound-rate:slow.test.com', 'TOTAL', 4, function () {
            self.plugin.outbound_increment(function (code, delay) {
                assert.equal(code, constants.delay);
                assert.equal(delay, 30);
                done();
            },
            { domain: 'slow.test.com'});
        })
    })
})