'use strict';

var fixtures     = require('haraka-test-fixtures');

exports.inheritance = {
    setUp : function (done) {
        this.plugin = new fixtures.plugin('index');
        done();
    },
    'inherits redis': function (test) {
        test.expect(1);
        this.plugin.inherits('haraka-plugin-redis');
        test.equal(typeof this.plugin.load_redis_ini, 'function');
        test.done();
    },
    'can call parent functions': function (test) {
        test.expect(1);
        this.plugin.inherits('haraka-plugin-redis');
        this.plugin.load_redis_ini();
        test.ok(this.plugin.redisCfg); // loaded config
        test.done();
    },
    'register': function (test) {
        test.expect(1);
        this.plugin.register();
        test.ok(this.plugin.cfg); // loaded config
        test.done();
    },
};