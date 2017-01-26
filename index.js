'use strict';

var constants = require('haraka-constants');
var ipaddr    = require('ipaddr.js');

exports.register = function () {
    var plugin = this;
    plugin.inherits('haraka-plugin-redis');

    plugin.register_hook('init_master',  'init_redis_plugin');
    plugin.register_hook('init_child',   'init_redis_plugin');

    plugin.load_limit_ini();

    if (plugin.cfg.concurrency) {
        plugin.register_hook('connect_init', 'incr_concurrency');
        plugin.register_hook('connect',      'check_concurrency');
        plugin.register_hook('disconnect',   'decr_concurrency');
    }

    if (plugin.cfg.errors) {
        ['helo','ehlo','mail','rcpt','data'].forEach(function (hook) {
            plugin.register_hook(hook, 'max_errors');
        });
    }

    if (plugin.cfg.recipients) {
        plugin.register_hook('rcpt', 'max_recipients');
    }

    if (plugin.cfg.unrecognized_commands) {
        plugin.register_hook('unrecognized_command', 'max_unrecognized_commands');
    }
};

exports.load_limit_ini = function () {
    var plugin = this;
    plugin.cfg = plugin.config.get('limit.ini', function () {
        plugin.load_limit_ini();
    });

    if (!plugin.cfg.concurrency) {   // no config file
        plugin.cfg.concurrency = {};
    }

    plugin.merge_redis_ini();
};

exports.shutdown = function () {
    if (this.db) this.db.quit();
}

exports.max_unrecognized_commands = function(next, connection, cmd) {
    var plugin = this;
    if (!plugin.cfg.unrecognized_commands) { return next(); }

    connection.results.add(plugin, {fail: 'unrecognized: ' + cmd, emit: true});
    connection.results.incr(plugin, {unrec_cmds: 1});

    var max = parseFloat(plugin.cfg.unrecognized_commands.max);
    if (!max || isNaN(max)) { return next(); }

    var uc = connection.results.get(plugin.name);
    if (parseFloat(uc.unrec_cmds) <= max) { return next(); }

    connection.results.add(plugin, {fail: 'unrec_cmds.max'});
    return next(constants.DENYDISCONNECT, 'Too many unrecognized commands');
};

exports.max_errors = function (next, connection) {
    var plugin = this;
    if (!plugin.cfg.errors) { return next(); } // disabled in config

    var max = parseFloat(plugin.cfg.errors.max);
    if (!max || isNaN(max)) { return next(); }

    if (connection.errors <= max) { return next(); }

    connection.results.add(plugin, {fail: 'errors.max'});
    return next(constants.DENYSOFTDISCONNECT, 'Too many errors');
};

exports.max_recipients = function (next, connection, params) {
    var plugin = this;
    if (!plugin.cfg.recipients) { return next(); } // disabled in config

    var max = plugin.get_recipient_limit(connection);
    if (!max) { return next(); }

    var c = connection.rcpt_count;
    var count = c.accept + c.tempfail + c.reject + 1;
    if (count <= max) { return next(); }

    connection.results.add(plugin, {fail: 'recipients.max'});
    return next(constants.DENYSOFT, 'Too many recipients');
};

exports.get_recipient_limit = function (connection) {
    var plugin = this;

    if (connection.relaying && plugin.cfg.recipients.max_relaying) {
        return plugin.cfg.recipients.max_relaying;
    }

    var history_plugin = plugin.cfg.concurrency.history;
    if (!history_plugin) {
        return plugin.cfg.recipients.max;
    }

    var results = connection.results.get(history_plugin);
    if (!results) {
        connection.logerror(plugin, 'no ' + history_plugin + ' results,' +
               ' disabling history due to misconfiguration');
        delete plugin.cfg.recipients.history;
        return plugin.cfg.recipients.max;
    }

    if (results.history === undefined) {
        connection.logerror(plugin, 'no history from : ' + history_plugin);
        return plugin.cfg.recipients.max;
    }

    var history = parseFloat(results.history);
    connection.logdebug(plugin, 'history: ' + history);
    if (isNaN(history)) { history = 0; }

    if (history > 0) return plugin.cfg.recipients.history_good || 50;
    if (history < 0) return plugin.cfg.recipients.history_bad  || 2;
    return plugin.cfg.recipients.history_none || 15;
};

exports.incr_concurrency = function (next, connection) {
    var plugin = this;
    if (!plugin.cfg.concurrency) { return next(); }

    var dbkey = plugin.get_key(connection);

    plugin.db.incrby(dbkey, 1, function (err, concurrent) {

        if (concurrent === undefined) {
            connection.logerror(plugin, 'concurrency not returned by incrby!');
            return next();
        }
        if (isNaN(concurrent)) {
            connection.logerror(plugin, 'concurrency isNaN!');
            return next();
        }

        connection.logdebug(plugin, 'concurrency incremented to ' + concurrent);

        // repair negative concurrency counters
        if (concurrent < 1) {
            connection.loginfo(plugin, 'resetting ' + concurrent + ' to 1');
            plugin.db.set(dbkey, 1);
        }

        connection.notes.limit=concurrent;
        next();
    });
};

exports.get_key = function (connection) {
    return 'concurrency|' + connection.remote.ip;
};

exports.check_concurrency = function (next, connection) {
    var plugin = this;

    var max = plugin.get_concurrency_limit(connection);
    if (!max || isNaN(max)) {
        connection.logerror(plugin, "no limit?!");
        return next();
    }
    connection.logdebug(plugin, 'concurrent max: ' + max);

    var concurrent = parseInt(connection.notes.limit);

    if (concurrent <= max) {
        connection.results.add(plugin, { pass: concurrent + '/' + max});
        return next();
    }

    connection.results.add(plugin, {
        fail: 'concurrency: ' + concurrent + '/' + max,
    });

    var delay = 3;
    if (plugin.cfg.concurrency.disconnect_delay) {
        delay = parseFloat(plugin.cfg.concurrency.disconnect_delay);
    }

    // Disconnect slowly.
    setTimeout(function () {
        return next(constants.DENYSOFTDISCONNECT, 'Too many concurrent connections');
    }, delay * 1000);
};

exports.get_concurrency_limit = function (connection) {
    var plugin = this;

    var history_plugin = plugin.cfg.concurrency.history;
    if (!history_plugin) {
        return plugin.cfg.concurrency.max;
    }

    var results = connection.results.get(history_plugin);
    if (!results) {
        connection.logerror(plugin, 'no ' + history_plugin + ' results,' +
               ' disabling history due to misconfiguration');
        delete plugin.cfg.concurrency.history;
        return plugin.cfg.concurrency.max;
    }

    if (results.history === undefined) {
        connection.loginfo(plugin, 'no IP history from : ' + history_plugin);
        return plugin.cfg.concurrency.max;
    }

    var history = parseFloat(results.history);
    connection.logdebug(plugin, 'history: ' + history);
    if (isNaN(history)) { history = 0; }

    if (history < 0) { return plugin.cfg.concurrency.history_bad  || 1; }
    if (history > 0) { return plugin.cfg.concurrency.history_good || 5; }
    return plugin.cfg.concurrency.history_none || 3;
};

exports.decr_concurrency = function (next, connection) {
    var plugin = this;
    if (!plugin.cfg.concurrency) { return next(); }

    var dbkey = plugin.get_key(connection);
    plugin.db.incrby(dbkey, -1, function (err, concurrent) {
        connection.logdebug(plugin, 'decrement concurrency to ' + concurrent);

        // if connections didn't increment properly (this happened a lot
        // before we added the connect_init hook), the counter can go
        // negative. check for and repair negative concurrency counters
        if (concurrent < 0) {
            connection.loginfo(plugin, 'resetting ' + concurrent + ' to 1');
            plugin.db.set(dbkey, 1);
        }

        return next();
    });
};



exports.lookup_host_key = function (type, remote, cb) {
    var plugin = this;
    if (!plugin.cfg[type]) {
        return cb(new Error(type + ': not configured'));
    }

    try {
        var ip = ipaddr.parse(remote.ip);
        if (ip.kind === 'ipv6') {
            ip = ipaddr.toNormalizedString();
        }
        else {
            ip = ip.toString();
        }
    }
    catch (err) {
        return cb(err);
    }

    var ip_array = ((ip.kind === 'ipv6') ? ip.split(':') : ip.split('.'));
    while (ip_array.length) {
        var part = ((ip.kind === 'ipv6') ? ip_array.join(':') : ip_array.join('.'));
        if (plugin.cfg[type][part] || plugin.cfg[type][part] === 0) {
            return cb(null, part, plugin.cfg[type][part]);
        }
        ip_array.pop();
    }

    // rDNS
    if (remote.host) {
        var rdns_array = remote.host.toLowerCase().split('.');
        while (rdns_array.length) {
            var part2 = rdns_array.join('.');
            if (plugin.cfg[type][part2] || plugin.cfg[type][part2] === 0) {
                return cb(null, part2, plugin.cfg[type][part2]);
            }
            rdns_array.pop();
        }
    }

    // Custom Default
    if (plugin.cfg[type].default) {
        return cb(null, ip, plugin.cfg[type].default);
    }

    // Default 0 = unlimited
    return cb(null, ip, 0);
};

exports.lookup_mail_key = function (type, args, cb) {
    var plugin = this;
    var mail = args[0];
    if (!plugin.cfg[type] || !mail) {
        return cb();
    }

    // Full e-mail address (e.g. smf@fsl.com)
    var email = mail.address();
    if (plugin.cfg[type][email] || plugin.cfg[type][email] === 0) {
        return cb(null, email, plugin.cfg[type][email]);
    }

    // RHS parts e.g. host.sub.sub.domain.com
    if (mail.host) {
        var rhs_split = mail.host.toLowerCase().split('.');
        while (rhs_split.length) {
            var part = rhs_split.join('.');
            if (plugin.cfg[type][part] || plugin.cfg[type][part] === 0) {
                return cb(null, part, plugin.cfg[type][part]);
            }
            rhs_split.pop();
        }
    }

    // Custom Default
    if (plugin.cfg[type].default) {
        return cb(null, email, plugin.cfg[type].default);
    }
    // Default 0 = unlimited
    return cb(null, email, 0);
};

exports.rate_limit = function (connection, key, value, cb) {
    var plugin = this;

    if (value === 0) {     // Limit disabled for this host
        connection.loginfo(this, 'rate limit disabled for: ' + key);
        return cb(null, false);
    }

    // CAUTION: !value would match a valid 0 value
    if (!key || !value) return cb();

    var match = /^(\d+)(?:\/(\d+)(\S)?)?$/.exec(value);
    if (match) {
        var limit = match[1];
        var ttl = ((match[2]) ? match[2] : 60);  // Default 60s
        if (match[3]) {
            // Unit
            switch (match[3].toLowerCase()) {
                case 's':
                    // Default is seconds
                    break;
                case 'm':
                    ttl *= 60;
                    break;
                case 'h':
                    ttl *= (60*60);
                    break;
                case 'd':
                    ttl *= (60*60*24);
                    break;
                default:
                    // Unknown time unit
                    return cb(new Error('unknown time unit \'' + match[3] + '\' key=' + key));
            }
        }
    }
    else {
        // Syntax error
        return cb(new Error('syntax error: key=' + key + ' value=' + value));
    }

    connection.logdebug(plugin, 'key=' + key + ' limit=' + limit + ' ttl=' + ttl);

    plugin.db.get(key, function (err, val) {
        if (err) return cb(err);

        connection.logdebug(plugin, 'key=' + key + ' current value=' + (val || 'NEW' ));

        var check_limits = function (err2, result){
            if (err2) return cb(err2);

            var key_str = key + ':' + val;
            var limit_str = limit + '/' + ttl + 's';

            if (parseInt(val) + 1 > parseInt(limit)) {
                // Limit breached
                connection.results.add(plugin, { fail: key_str + ' > ' + limit_str, emit: true } );
                return cb(null, true);
            }
            else {
                // OK
                connection.results.add(plugin, { pass: key_str + ' < ' + limit_str, emit: true });
                return cb(null, false);
            }

        };

        if (val == null) { // new key
            plugin.db.setex(key, ttl, 1, check_limits);
        }
        else { // old key
            plugin.db.incr(key, function (err3, result) {
                if (result === 1) {
                    plugin.db.expire(key, ttl);
                }
                check_limits(err3, result);
            });
        }
    });
};

exports.hook_connect = function (next, connection) {
    var plugin = this;

    this.lookup_host_key('rate_conn', connection.remote, function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }
        // Check rate limit
        plugin.rate_limit(connection, 'rate_conn:' + key, value, function (err2, over) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }
            if (over) {
                if (plugin.cfg.main.tarpit_delay) {
                    connection.notes.tarpit = plugin.cfg.main.tarpit_delay;
                }
                else {
                    connection.results.add(plugin, {fail: 'rate_conn:' + key + ' value ' + over });
                    return next(constants.DENYSOFT, 'connection rate limit exceeded');
                }
            }

            // See if we need to tarpit rate_rcpt_host
            if (!plugin.cfg.main.tarpit_delay) {
                return next();
            }

            plugin.lookup_host_key('rate_rcpt_host', connection.remote, function (err3, key2, value2) {
                if (err3) {
                    connection.results.add(plugin, { err: err3 });
                    return next();
                }
                if (!key2 || !value2) {
                    return next();
                }

                var match = /^(\d+)/.exec(value2);
                var limit = match[0];
                if (!limit) return next();

                plugin.db.get('rate_rcpt_host:' + key2, function (err4, result) {
                    if (err4) {
                        connection.results.add(plugin, { err: err4 });
                        return next();
                    }

                    if (!result) return next();

                    connection.results.add(plugin, {fail: 'rate_rcpt_host:' + key2 + ' value2 ' + result });
                    connection.logdebug(plugin, 'rate_rcpt_host:' + key2 + ' value2 ' + result + ' exceeds limit ' + limit);
                    if (result > limit) {
                        connection.notes.tarpit = plugin.cfg.main.tarpit_delay;
                    }
                    next();
                });
            });
        });
    });
};

exports.hook_rcpt = function (next, connection, params) {
    var plugin = this;
    var transaction = connection.transaction;

    var chain = [
        {
            name:           'rate_rcpt_host',
            lookup_func:    'lookup_host_key',
            lookup_args:    connection.remote,
        },
        {
            name:           'rate_rcpt_sender',
            lookup_func:    'lookup_mail_key',
            lookup_args:    [connection.transaction.mail_from],
        },
        {
            name:           'rate_rcpt_null',
            lookup_func:    'lookup_mail_key',
            lookup_args:    [params[0]],
            check_func:     function () {
                if (transaction && !transaction.mail_from.user) {
                    // Message from the null sender
                    return true;
                }
                return false;
            },
        },
        {
            name:           'rate_rcpt',
            lookup_func:    'lookup_mail_key',
            lookup_args:    [params[0]],
        },
    ];

    var chain_caller = function (code, msg) {
        if (code)          return next(code, msg);
        if (!chain.length) return next();

        var next_in_chain = chain.shift();
        // Run any check functions
        if (next_in_chain.check_func && typeof next_in_chain.check_func === 'function') {
            if (!next_in_chain.check_func()) {
                return chain_caller();
            }
        }
        plugin[next_in_chain.lookup_func](next_in_chain.name, next_in_chain.lookup_args, function (err, key, value) {
            if (err) {
                connection.results.add(plugin, { err: err });
                return chain_caller();
            }

            plugin.rate_limit(connection, next_in_chain.name + ':' + key, value, function (err2, over) {
                if (err2) {
                    connection.results.add(plugin, { err: err2 });
                    return chain_caller();
                }
                if (!over) {
                    return chain_caller();
                }

                if (!plugin.cfg.main.tarpit_delay) {             // tarpitting disabled
                    return chain_caller(constants.DENYSOFT, 'rate limit exceeded');
                }

                if (connection.notes.tarpit) {                   // already tarpitting
                    return chain_caller(constants.DENYSOFT, 'rate limit exceeded');
                }
                if (transaction && transaction.notes.tarpit) {   // already tarpitting
                    return chain_caller(constants.DENYSOFT, 'rate limit exceeded');
                }

                connection.loginfo(plugin, 'tarpitting response for ' + plugin.cfg.main.tarpit + 's');
                setTimeout(function () {
                    if (connection) {
                        return chain_caller(constants.DENYSOFT, 'rate limit exceeded');
                    }
                }, plugin.cfg.main.tarpit_delay*1000);
            });
        });
    };
    chain_caller();
};
