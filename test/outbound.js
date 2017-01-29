'use strict';

// var Address      = require('address-rfc2821').Address;
var constants    = require('haraka-constants');
var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {
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
};

exports.outbound_increment = {
    setUp : _set_up,
    'no limit, no delay': function (test) {
        test.expect(2);
        this.plugin.outbound_increment(function (code, msg) {
            test.equal(code, undefined);
            test.equal(msg, undefined);
            test.done();
        },
        { domain: 'test.com'});
    },
    'limits has delay': function (test) {
        test.expect(2);
        var self = this;
        self.plugin.cfg.outbound['slow.test.com'] = 3;
        self.plugin.db.hset('outbound-rate:slow.test.com', 'TOTAL', 4, function () {
            self.plugin.outbound_increment(function (code, delay) {
                test.equal(code, constants.delay);
                test.equal(delay, 30);
                test.done();
            },
            { domain: 'slow.test.com'});
        });
    },
};