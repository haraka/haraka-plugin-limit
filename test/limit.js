'use strict';

var path         = require('path');

var constants    = require('haraka-constants');
var fixtures     = require('haraka-test-fixtures');

var _set_up = function (done) {

    this.plugin = new fixtures.plugin('index');
    this.plugin.config = this.plugin.config.module_config(path.resolve('test'));

    this.connection = new fixtures.connection.createConnection();
    this.connection.transaction = new fixtures.transaction.createTransaction();

    this.plugin.register();
    done();
};

exports.max_errors = {
    setUp : _set_up,
    'none': function (test) {
        // console.log(this);
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, null);
            test.equal(msg, null);
            test.done();
        };
        this.plugin.max_errors(cb, this.connection);
    },
    'too many': function (test) {
        // console.log(this);
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, constants.DENYSOFTDISCONNECT);
            test.equal(msg, 'Too many errors');
            test.done();
        };
        this.connection.errors=10;
        this.plugin.cfg.errors = { max: 9 };
        this.plugin.max_errors(cb, this.connection);
    },
};

exports.max_recipients = {
    setUp : _set_up,
    'none': function (test) {
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, null);
            test.equal(msg, null);
            test.done();
        };
        this.plugin.max_recipients(cb, this.connection);
    },
    'too many': function (test) {
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, constants.DENYSOFT);
            test.equal(msg, 'Too many recipient attempts');
            test.done();
        };
        this.connection.rcpt_count = { accept: 3, tempfail: 5, reject: 4 };
        this.plugin.cfg.recipients = { max: 10 };
        this.plugin.max_recipients(cb, this.connection);
    },
};

exports.max_unrecognized_commands = {
    setUp : _set_up,
    'none': function (test) {
        // console.log(this);
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, null);
            test.equal(msg, null);
            test.done();
        };
        this.plugin.max_unrecognized_commands(cb, this.connection);
    },
    'too many': function (test) {
        // console.log(this);
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, constants.DENYSOFTDISCONNECT);
            test.equal(msg, 'Too many unrecognized commands');
            test.done();
        };
        this.plugin.cfg.unrecognized_commands = { max: 5 };
        this.connection.results.push(this.plugin, {
            'unrec_cmds': ['1','2','3','4',5,6]
        });
        this.plugin.max_unrecognized_commands(cb, this.connection);
    },
};

exports.check_concurrency = {
    setUp : _set_up,
    'none': function (test) {
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, null);
            test.equal(msg, null);
            test.done();
        };
        this.plugin.check_concurrency(cb, this.connection);
    },
    'at max': function (test) {
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, null);
            test.equal(msg, null);
            test.done();
        };
        var self = this;
        self.plugin.cfg.concurrency.history = undefined;
        self.plugin.cfg.concurrency = { max: 4 };
        self.connection.results.add(self.plugin, { concurrent_count: 4 });
        self.plugin.check_concurrency(cb, self.connection);
    },
    'too many': function (test) {
        test.expect(2);
        var cb = function (rc, msg) {
            // console.log(arguments);
            test.equal(rc, constants.DENYSOFTDISCONNECT);
            test.equal(msg, 'Too many concurrent connections');
            test.done();
        };
        var self = this;
        self.plugin.cfg.concurrency.history = undefined;
        self.plugin.cfg.concurrency = { max: 4 };
        self.plugin.cfg.concurrency.disconnect_delay=1;
        self.connection.results.add(self.plugin, { concurrent_count: 5 });
        self.plugin.check_concurrency(cb, self.connection);
    },
};
