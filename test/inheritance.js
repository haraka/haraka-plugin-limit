'use strict';

const assert = require('assert')

const fixtures     = require('haraka-test-fixtures');

describe('inheritance', function () {

    beforeEach(function (done) {
        this.plugin = new fixtures.plugin('index');
        done();
    })

    it('inherits redis', function (done) {
        this.plugin.inherits('haraka-plugin-redis');
        assert.equal(typeof this.plugin.load_redis_ini, 'function');
        done();
    })

    it('can call parent functions', function (done) {
        this.plugin.inherits('haraka-plugin-redis');
        this.plugin.load_redis_ini();
        assert.ok(this.plugin.redisCfg); // loaded config
        done();
    })

    it('register', function (done) {
        this.plugin.register();
        assert.ok(this.plugin.cfg); // loaded config
        done();
    })
})