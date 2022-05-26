'use strict';

const assert = require('assert')
const path   = require('path')

// const constants    = require('haraka-constants');
const fixtures     = require('haraka-test-fixtures');

describe('get_history_limit', function () {

    before(function () {
        this.plugin = new fixtures.plugin('index');
        this.plugin.config = this.plugin.config.module_config(path.resolve('test'));

        this.connection = new fixtures.connection.createConnection();
        this.connection.transaction = new fixtures.transaction.createTransaction();

        this.plugin.register();

        this.plugin.cfg.concurrency_history = {
            plugin: 'karma',
            good: 5,
            bad: 1,
            none: 2,
        };
    })

    it('good', function () {
        this.connection.results.add({name: 'karma'}, { history: 1 });
        assert.equal(
            5,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
    })

    it('bad', function () {
        this.connection.results.add({name: 'karma'}, { history: -1 });
        assert.equal(
            1,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
    })

    it('none', function () {
        this.connection.results.add({name: 'karma'}, { history: 0 });
        assert.equal(
            2,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
    })
})
