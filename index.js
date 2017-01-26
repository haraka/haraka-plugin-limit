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

    plugin.register_hook('connect', 'rate_rcpt_host');
    plugin.register_hook('connect', 'rate_conn');

    ['rcpt', 'rcpt_ok'].forEach(function (h) {
        plugin.register_hook(h,    'rate_rcpt_sender');
        plugin.register_hook(h,    'rate_rcpt_null');
        plugin.register_hook(h,    'rate_rcpt');
    });
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

    plugin.db.incr(dbkey, function (err, concurrent) {

        if (concurrent === undefined) {
            connection.results.add(plugin, {err: 'concurrency not returned by incr!'});
            return next();
        }
        if (isNaN(concurrent)) {
            connection.results.add(plugin, {err: 'concurrency isNaN!'});
            return next();
        }

        connection.logdebug(plugin, 'concurrency incremented to ' + concurrent);

        // repair negative concurrency counters
        if (concurrent < 1) {
            connection.loginfo(plugin, 'resetting ' + concurrent + ' to 1');
            plugin.db.set(dbkey, 1);
        }

        connection.notes.concurrent=concurrent;
        plugin.db.expire(dbkey, 60);
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

    var concurrent = parseInt(connection.notes.concurrent);
    if (isNaN(concurrent)) {
        connection.results.add(plugin, { err: 'concurrent unset' });
        return next();
    }

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
        connection.results.add(plugin, {msg: 'concurrency=' + concurrent});
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

exports.lookup_mail_key = function (type, mail, cb) {
    var plugin = this;
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

function getTTL (qty, units) {
    var ttl = qty ? qty : 60;  // Default 60s
    if (!units) return ttl;

    // Unit
    switch (units.toLowerCase()) {
        case 's':               // Default is seconds
            break;
        case 'm':
            ttl *= 60;          // minutes
            break;
        case 'h':
            ttl *= (60*60);     // hours
            break;
        case 'd':
            ttl *= (60*60*24);  // days
            break;
        default:
            return;
    }
    return ttl;
}

exports.rate_limit = function (connection, key, value, cb) {
    var plugin = this;

    if (value === 0) {     // Limit disabled for this host
        connection.loginfo(this, 'rate limit disabled for: ' + key);
        return cb(null, false);
    }

    // CAUTION: !value would match that 0 value -^
    if (!key || !value) return cb();

    var match = /^(\d+)(?:\/(\d+)(\S)?)?$/.exec(value);
    if (!match) {
        return cb(new Error('syntax error: key=' + key + ' value=' + value));
    }

    var limit = match[1];
    var ttl = getTTL(match[2], match[3]);
    if (!ttl) {
        return cb(new Error('unknown time unit \'' + match[3] + '\' key=' + key));
    }

    connection.logdebug(plugin, 'key=' + key + ' limit=' + limit + ' ttl=' + ttl);

    plugin.db.get(key, function (err, val) {
        if (err) return cb(err);

        if (val == null) {      // new key
            plugin.db.setex(key, ttl, 1);
            return cb(null, false);
        }

        connection.logdebug(plugin, 'key=' + key + ' current value=' + (val || 'NEW' ));

        plugin.db.incr(key, function (err2, newval) {
            if (err2) return cb(err2);

            var key_str = key + ':' + newval;
            var limit_str = limit + '/' + ttl + 's';

            if (parseInt(newval) > parseInt(limit)) {
                // Limit exceeded
                connection.results.add(plugin, { fail: key_str + ' > ' + limit_str, emit: true } );
                return cb(null, true);
            }

            connection.results.add(plugin, { pass: key_str + ' < ' + limit_str, emit: true });
            cb(null, false);
        });
    });
};

exports.rate_rcpt_host = function (next, connection) {
    var plugin = this;

    if (!plugin.cfg.rate_rcpt_host) return next();

    plugin.lookup_host_key('rate_rcpt_host', connection.remote, function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }

        if (!key || !value) return next();

        var match = /^(\d+)/.exec(value);
        var limit = match[0];
        if (!limit) return next();

        plugin.db.get('rate_rcpt_host:' + key, function (err2, result) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }

            if (!result) return next();
            if (result <= limit) return next();

            connection.results.add(plugin, {fail: 'rate_rcpt_host:' + key + ':' + result });
            if (!plugin.cfg.main.tarpit_delay) {
                return next(constants.DENYSOFT, 'connection rate limit exceeded');
            }
            connection.notes.tarpit = plugin.cfg.main.tarpit_delay;
            next();
        });
    });
}

exports.rate_conn = function (next, connection) {
    var plugin = this;

    plugin.lookup_host_key('rate_conn', connection.remote, function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }

        plugin.rate_limit(connection, 'rate_conn:' + key, value, function (err2, over) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }
            connection.results.add(plugin, { rate_conn: value });
            if (!over) return next();

            if (!plugin.cfg.main.tarpit_delay) {
                connection.results.add(plugin, { fail: 'rate_conn' });
                return next(constants.DENYSOFT, 'connection rate limit exceeded');
            }
            connection.notes.tarpit = plugin.cfg.main.tarpit_delay;
            next();
        });
    });
};

exports.rate_rcpt_sender = function (next, connection, params) {
    var plugin = this;

    plugin.lookup_mail_key('rate_rcpt_sender', connection.transaction.mail_from, function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }

        plugin.rate_limit(connection, 'rate_rcpt_sender' + ':' + key, value, function (err2, over) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }
            if (!over) {
                connection.results.add(plugin, { pass: 'rate_rcpt_sender:' + value });
                return next();
            }

            connection.results.add(plugin, { fail: 'rate_rcpt_sender:' + value });
            if (!plugin.cfg.main.tarpit_delay) {  // tarpitting disabled
                return next(constants.DENYSOFT, 'rate limit exceeded');
            }

            var delay = plugin.cfg.main.tarpit_delay;
            connection.loginfo(plugin, 'tarpitting for ' + delay + 's');
            setTimeout(function () {
                if (connection) {
                    return next(constants.DENYSOFT, 'rate limit exceeded');
                }
            }, delay * 1000);
        });
    });
};

exports.rate_rcpt_null = function (next, connection, params) {
    var plugin = this;

    if (params.user) return next();

    // Message from the null sender
    plugin.lookup_mail_key('rate_rcpt_null', params[0], function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }

        plugin.rate_limit(connection, 'rate_rcpt_null' + ':' + key, value, function (err2, over) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }
            if (!over) {
                connection.results.add(plugin, { pass: 'rate_rcpt_null:' + value });
                return next();
            }

            connection.results.add(plugin, { fail: 'rate_rcpt_null:' + value });
            if (!plugin.cfg.main.tarpit_delay) {             // tarpitting disabled
                return next(constants.DENYSOFT, 'rate limit exceeded');
            }

            var delay = plugin.cfg.main.tarpit_delay;
            connection.loginfo(plugin, 'tarpitting for ' + delay + 's');
            setTimeout(function () {
                if (connection) {
                    return next(constants.DENYSOFT, 'rate limit exceeded');
                }
            }, delay * 1000);
        });
    });
};

exports.rate_rcpt = function (next, connection, params) {
    var plugin = this;

    plugin.lookup_mail_key('rate_rcpt', params[0], function (err, key, value) {
        if (err) {
            connection.results.add(plugin, { err: err });
            return next();
        }

        plugin.rate_limit(connection, 'rate_rcpt' + ':' + key, value, function (err2, over) {
            if (err2) {
                connection.results.add(plugin, { err: err2 });
                return next();
            }
            if (!over) {
                connection.results.add(plugin, { pass: 'rate_rcpt:' + value });
                return next();
            }

            connection.results.add(plugin, { fail: 'rate_rcpt:' + value });
            if (!plugin.cfg.main.tarpit_delay) {             // tarpitting disabled
                return next(constants.DENYSOFT, 'rate limit exceeded');
            }

            var delay = plugin.cfg.main.tarpit_delay;
            connection.loginfo(plugin, 'tarpitting for ' + delay + 's');
            setTimeout(function () {
                if (connection) {
                    return next(constants.DENYSOFT, 'rate limit exceeded');
                }
            }, delay * 1000);
        });
    });
};
