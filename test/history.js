'use strict';

var path         = require('path');

// var constants    = require('haraka-constants');
var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {

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
    done();
};

exports.get_history_limit = {
    setUp: _set_up,
    'good': function (test) {
        test.expect(1);
        this.connection.results.add({name: 'karma'}, { history: 1 });
        test.equal(
            5,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
        test.done();
    },
    'bad': function (test) {
        test.expect(1);
        this.connection.results.add({name: 'karma'}, { history: -1 });
        test.equal(
            1,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
        test.done();
    },
    'none': function (test) {
        test.expect(1);
        this.connection.results.add({name: 'karma'}, { history: 0 });
        test.equal(
            2,
            this.plugin.get_history_limit('concurrency', this.connection)
        );
        test.done();
    }
}