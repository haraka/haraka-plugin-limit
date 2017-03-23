'use strict';

var constants = require('haraka-constants');
var ipaddr    = require('ipaddr.js');

exports.register = function () {
    var plugin = this;
    plugin.inherits('haraka-plugin-redis');

    plugin.register_hook('init_master',  'init_redis_plugin');
    plugin.register_hook('init_child',   'init_redis_plugin');

    plugin.load_limit_ini();

    if (plugin.cfg.concurrency.enabled) {
        plugin.register_hook('connect_init', 'conn_concur_incr');
        plugin.register_hook('connect',      'check_concurrency');
        plugin.register_hook('disconnect',   'conn_concur_decr');
    }

    if (plugin.cfg.errors.enabled) {
        ['helo','ehlo','mail','rcpt','data'].forEach(hook => {
            plugin.register_hook(hook, 'max_errors');
        })
    }

    if (plugin.cfg.recipients.enabled) {
        plugin.register_hook('rcpt', 'max_recipients');
    }

    if (plugin.cfg.unrecognized_commands.enabled) {
        plugin.register_hook('unrecognized_command', 'max_unrecognized_commands');
    }

    if (plugin.cfg.rate_conn.enabled) {
        plugin.register_hook('connect_init', 'rate_conn_incr');
        plugin.register_hook('connect',      'rate_conn_enforce');
    }
    if (plugin.cfg.rate_rcpt_host.enabled) {
        plugin.register_hook('connect', 'rate_rcpt_host_enforce');
        plugin.register_hook('rcpt',    'rate_rcpt_host_incr');
    }
    if (plugin.cfg.rate_rcpt_sender.enabled) {
        plugin.register_hook('rcpt', 'rate_rcpt_sender');
    }
    if (plugin.cfg.rate_rcpt_null.enabled) {
        plugin.register_hook('rcpt', 'rate_rcpt_null');
    }
    if (plugin.cfg.rate_rcpt.enabled) {
        plugin.register_hook('rcpt', 'rate_rcpt');
    }

    if (plugin.cfg.outbound.enabled) {
        plugin.register_hook('send_email', 'outbound_increment');
        plugin.register_hook('delivered',  'outbound_decrement');
        plugin.register_hook('deferred',   'outbound_decrement');
        plugin.register_hook('bounce',     'outbound_decrement');
    }
}

exports.load_limit_ini = function () {
    var plugin = this;
    plugin.cfg = plugin.config.get('limit.ini', {
        booleans: [
            '-outbound.enabled',
            '-recipients.enabled',
            '-unrecognized_commands.enabled',
            '-errors.enabled',
            '-rate_conn.enabled',
            '-rate_rcpt.enabled',
            '-rate_rcpt_host.enabled',
            '-rate_rcpt_sender.enabled',
            '-rate_rcpt_null.enabled',
        ]
    },
    function () {
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

exports.max_unrecognized_commands = function (next, connection, cmd) {
    var plugin = this;
    if (!plugin.cfg.unrecognized_commands) return next();

    connection.results.push(plugin, {unrec_cmds: cmd, emit: true});

    var max = parseFloat(plugin.cfg.unrecognized_commands.max);
    if (!max || isNaN(max)) return next();

    var uc = connection.results.get(plugin).unrec_cmds;
    if (!uc || !uc.length) return next();

    if (uc.length <= max) return next();

    connection.results.add(plugin, { fail: 'unrec_cmds.max' });
    plugin.penalize(connection, true, 'Too many unrecognized commands', next);
};

exports.max_errors = function (next, connection) {
    var plugin = this;
    if (!plugin.cfg.errors) return next();  // disabled in config

    var max = parseFloat(plugin.cfg.errors.max);
    if (!max || isNaN(max)) return next();

    if (connection.errors <= max) return next();

    connection.results.add(plugin, {fail: 'errors.max'});
    plugin.penalize(connection, true, 'Too many errors', next);
};

exports.max_recipients = function (next, connection, params) {
    var plugin = this;
    if (!plugin.cfg.recipients) return next(); // disabled in config

    var max = plugin.get_limit('recipients', connection);
    if (!max || isNaN(max)) return next();

    var c = connection.rcpt_count;
    var count = c.accept + c.tempfail + c.reject + 1;
    if (count <= max) return next();

    connection.results.add(plugin, { fail: 'recipients.max' });
    plugin.penalize(connection, false, 'Too many recipient attempts', next);
};

exports.get_history_limit = function (type, connection) {
    var plugin = this;

    var history_cfg = type + '_history';
    if (!plugin.cfg[history_cfg]) return;

    var history_plugin = plugin.cfg[history_cfg].plugin;
    if (!history_plugin) return;

    var results = connection.results.get(history_plugin);
    if (!results) {
        connection.logerror(plugin, 'no ' + history_plugin + ' results,' +
               ' disabling history due to misconfiguration');
        delete plugin.cfg[history_cfg];
        return;
    }

    if (results.history === undefined) {
        connection.logdebug(plugin, 'no history from : ' + history_plugin);
        return;
    }

    var history = parseFloat(results.history);
    connection.logdebug(plugin, 'history: ' + history);
    if (isNaN(history)) return;

    if (history > 0) return plugin.cfg[history_cfg].good;
    if (history < 0) return plugin.cfg[history_cfg].bad;
    return plugin.cfg[history_cfg].none;
};

exports.get_limit = function (type, connection) {
    var plugin = this;

    if (type === 'recipients') {
        if (connection.relaying && plugin.cfg.recipients.max_relaying) {
            return plugin.cfg.recipients.max_relaying;
        }
    }

    if (plugin.cfg[type + '_history']) {
        var history = plugin.get_history_limit(type, connection);
        if (history) return history;
    }

    return plugin.cfg[type].max || plugin.cfg[type].default;
};

exports.conn_concur_incr = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();
    if (!plugin.cfg.concurrency) return next();

    var dbkey = plugin.get_concurrency_key(connection);

    plugin.db.incr(dbkey, (err, count) => {
        if (err) {
            connection.results.add(plugin, { err: 'conn_concur_incr:' + err });
            return next();
        }

        if (isNaN(count)) {
            connection.results.add(plugin, {err: 'conn_concur_incr got isNaN'});
            return next();
        }

        connection.results.add(plugin, { concurrent_count: count });

        // repair negative concurrency counters
        if (count < 1) {
            connection.results.add(plugin, {
                msg: 'resetting concurrent ' + count + ' to 1'
            });
            plugin.db.set(dbkey, 1);
        }

        plugin.db.expire(dbkey, 3 * 60); // 3 minute lifetime
        next();
    });
};

exports.get_concurrency_key = function (connection) {
    return 'concurrency|' + connection.remote.ip;
};

exports.check_concurrency = function (next, connection) {
    var plugin = this;

    var max = plugin.get_limit('concurrency', connection);
    if (!max || isNaN(max)) {
        connection.results.add(plugin, {err: "concurrency: no limit?!"});
        return next();
    }

    var count = parseInt(connection.results.get(plugin.name).concurrent_count);
    if (isNaN(count)) {
        connection.results.add(plugin, { err: 'concurrent.unset' });
        return next();
    }

    connection.results.add(plugin, { concurrent: count + '/' + max });

    if (count <= max) return next();

    connection.results.add(plugin, { fail: 'concurrency.max' });

    plugin.penalize(connection, true, 'Too many concurrent connections', next);
};

exports.penalize = function (connection, disconnect, msg, next) {
    var plugin = this;
    var code = disconnect ? constants.DENYSOFTDISCONNECT : constants.DENYSOFT;

    if (!plugin.cfg.main.tarpit_delay) {
        return next(code, msg);
    }

    var delay = plugin.cfg.main.tarpit_delay;
    connection.loginfo(plugin, 'tarpitting for ' + delay + 's');

    setTimeout(() => {
        if (!connection) return;
        next(code, msg);
    }, delay * 1000);
}

exports.conn_concur_decr = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();
    if (!plugin.cfg.concurrency) return next();

    var dbkey = plugin.get_concurrency_key(connection);
    plugin.db.incrby(dbkey, -1, (err, concurrent) => {
        if (err) connection.results.add(plugin, { err: 'conn_concur_decr:' + err })
        return next();
    });
};

exports.get_host_key = function (type, connection, cb) {
    var plugin = this;
    if (!plugin.cfg[type]) {
        return cb(new Error(type + ': not configured'));
    }

    try {
        var ip = ipaddr.parse(connection.remote.ip);
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
    if (connection.remote.host) {
        var rdns_array = connection.remote.host.toLowerCase().split('.');
        while (rdns_array.length) {
            var part2 = rdns_array.join('.');
            if (plugin.cfg[type][part2] || plugin.cfg[type][part2] === 0) {
                return cb(null, part2, plugin.cfg[type][part2]);
            }
            rdns_array.pop();
        }
    }

    if (plugin.cfg[type + '_history']) {
        var history = plugin.get_history_limit(type, connection);
        if (history) return cb(null, ip, history);
    }

    // Custom Default
    if (plugin.cfg[type].default) {
        return cb(null, ip, plugin.cfg[type].default);
    }

    // Default 0 = unlimited
    cb(null, ip, 0);
};

exports.get_mail_key = function (type, mail, cb) {
    var plugin = this;
    if (!plugin.cfg[type] || !mail) return cb();

    // Full e-mail address (e.g. smf@fsl.com)
    var email = mail.address();
    if (plugin.cfg[type][email] || plugin.cfg[type][email] === 0) {
        return cb(email, plugin.cfg[type][email]);
    }

    // RHS parts e.g. host.sub.sub.domain.com
    if (mail.host) {
        var rhs_split = mail.host.toLowerCase().split('.');
        while (rhs_split.length) {
            var part = rhs_split.join('.');
            if (plugin.cfg[type][part] || plugin.cfg[type][part] === 0) {
                return cb(part, plugin.cfg[type][part]);
            }
            rhs_split.pop();
        }
    }

    // Custom Default
    if (plugin.cfg[type].default) {
        return cb(email, plugin.cfg[type].default);
    }

    // Default 0 = unlimited
    cb(email, 0);
};

function getTTL (value) {

    var match = /^(\d+)(?:\/(\d+)(\S)?)?$/.exec(value);
    if (!match) return;

    var qty = match[2];
    var units = match[3];

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

function getLimit (value) {
    var match = /^([\d]+)/.exec(value);
    if (!match) return 0;
    return parseInt(match[1], 10);
}

exports.rate_limit = function (connection, key, value, cb) {
    var plugin = this;

    if (value === 0) {     // Limit disabled for this host
        connection.loginfo(this, 'rate limit disabled for: ' + key);
        return cb(null, false);
    }

    // CAUTION: !value would match that 0 value -^
    if (!key || !value) return cb();
    if (!plugin.db) return cb();

    var limit = getLimit(value);
    var ttl = getTTL(value);

    if (!limit || ! ttl) {
        return cb(new Error('syntax error: key=' + key + ' value=' + value));
    }

    connection.logdebug(plugin, 'key=' + key + ' limit=' + limit + ' ttl=' + ttl);

    plugin.db.incr(key, (err, newval) => {
        if (err) return cb(err);

        if (newval === 1) plugin.db.expire(key, ttl);
        cb(err, parseInt(newval, 10) > limit); // boolean true/false
    })
}

exports.rate_rcpt_host_incr = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();

    plugin.get_host_key('rate_rcpt_host', connection, (err, key, value) => {
        if (!key || !value) return next();

        key = 'rate_rcpt_host:' + key;
        plugin.db.incr(key, (err2, newval) => {
            if (newval === 1) plugin.db.expire(key, getTTL(value));
            next();
        })
    })
}

exports.rate_rcpt_host_enforce = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();

    plugin.get_host_key('rate_rcpt_host', connection, (err, key, value) => {
        if (err) {
            connection.results.add(plugin, { err: 'rate_rcpt_host:' + err });
            return next();
        }

        if (!key || !value) return next();

        var match = /^(\d+)/.exec(value);
        var limit = parseInt(match[0], 10);
        if (!limit) return next();

        plugin.db.get('rate_rcpt_host:' + key, (err2, result) => {
            if (err2) {
                connection.results.add(plugin, { err: 'rate_rcpt_host:' + err2 });
                return next();
            }

            if (!result) return next();
            connection.results.add(plugin, {
                rate_rcpt_host: key + ':' + result + ':' + value
            });

            if (result <= limit) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt_host' });
            plugin.penalize(connection, false, 'recipient rate limit exceeded', next);
        });
    });
}

exports.rate_conn_incr = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();

    plugin.get_host_key('rate_conn', connection, (err, key, value) => {
        if (!key || !value) return next();

        key = 'rate_conn:' + key;
        plugin.db.hincrby(key, + new Date(), 1, (err2, newval) => {
            // extend key expiration on every new connection
            plugin.db.expire(key, getTTL(value) * 2);
            next();
        });
    });
}

exports.rate_conn_enforce = function (next, connection) {
    var plugin = this;
    if (!plugin.db) return next();

    plugin.get_host_key('rate_conn', connection, (err, key, value) => {
        if (err) {
            connection.results.add(plugin, { err: 'rate_conn:' + err });
            return next();
        }

        if (!key || !value) return next();

        var limit = getLimit(value);
        if (!limit) {
            connection.results.add(plugin, { err: 'rate_conn:syntax:' + value });
            return next();
        }

        plugin.db.hgetall('rate_conn:' + key, (err2, tstamps) => {
            if (err2) {
                connection.results.add(plugin, { err: 'rate_conn:' + err });
                return next();
            }

            if (!tstamps) {
                connection.results.add(plugin, { err: 'rate_conn:no_tstamps' });
                return next();
            }

            var d = new Date();
            d.setMinutes(d.getMinutes() - (getTTL(value) / 60));
            var periodStartTs = + d;  // date as integer

            var connections_in_ttl_period = 0;
            Object.keys(tstamps).forEach(ts => {
                if (parseInt(ts, 10) < periodStartTs) return; // older than ttl
                connections_in_ttl_period = connections_in_ttl_period + parseInt(tstamps[ts], 10);
            })
            connection.results.add(plugin, { rate_conn: connections_in_ttl_period + ':' + value});

            if (connections_in_ttl_period <= limit) return next();

            connection.results.add(plugin, { fail: 'rate_conn' });

            plugin.penalize(connection, true, 'connection rate limit exceeded', next);
        });
    });
};

exports.rate_rcpt_sender = function (next, connection, params) {
    var plugin = this;

    plugin.get_mail_key('rate_rcpt_sender', connection.transaction.mail_from, (key, value) => {

        plugin.rate_limit(connection, 'rate_rcpt_sender' + ':' + key, value, (err, over) => {
            if (err) {
                connection.results.add(plugin, { err: 'rate_rcpt_sender:' + err });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt_sender: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt_sender' });
            plugin.penalize(connection, false, 'rcpt rate limit exceeded', next);
        });
    });
};

exports.rate_rcpt_null = function (next, connection, params) {
    var plugin = this;

    if (!params) return next();
    if (Array.isArray(params)) params = params[0];
    if (params.user) return next();

    // Message from the null sender
    plugin.get_mail_key('rate_rcpt_null', params, (key, value) => {

        plugin.rate_limit(connection, 'rate_rcpt_null' + ':' + key, value, (err2, over) => {
            if (err2) {
                connection.results.add(plugin, { err: 'rate_rcpt_null:' + err2 });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt_null: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt_null' });
            plugin.penalize(connection, false, 'null recip rate limit', next);
        });
    });
};

exports.rate_rcpt = function (next, connection, params) {
    var plugin = this;
    if (Array.isArray(params)) params = params[0];
    plugin.get_mail_key('rate_rcpt', params, (key, value) => {

        plugin.rate_limit(connection, 'rate_rcpt' + ':' + key, value, (err2, over) => {
            if (err2) {
                connection.results.add(plugin, { err: 'rate_rcpt:' + err2 });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt' });
            plugin.penalize(connection, false, 'rate limit exceeded', next);
        });
    });
};

/*
 *        Outbound Rate Limits
 *
 */

function getOutDom (hmail) {
    // outbound isn't internally consistent in the use of hmail.domain
    // vs hmail.todo.domain.
    // TODO: fix haraka/Haraka/outbound/HMailItem to be internally consistent.
    if (hmail.todo && hmail.todo.domain) return hmail.todo.domain;
    return hmail.domain;
}

function getOutKey (domain) {
    return 'outbound-rate:' + domain;
}

exports.outbound_increment = function (next, hmail) {
    var plugin = this;
    if (!plugin.db) return next();

    var outDom = getOutDom(hmail);
    var outKey = getOutKey(outDom);

    plugin.db.hincrby(outKey, 'TOTAL', 1, (err, count) => {
        if (err) {
            plugin.logerror("outbound_increment: " + err);
            return next(); // just deliver
        }


        plugin.db.expire(outKey, 300);  // 5 min expire

        if (!plugin.cfg.outbound[outDom]) return next();
        var limit = parseInt(plugin.cfg.outbound[outDom], 10);
        if (!limit) return next();

        count = parseInt(count, 10);
        if (count <= limit) return next();

        var delay = plugin.cfg.outbound.delay || 30;
        next(constants.delay, delay);
    })
}

exports.outbound_decrement = function (next, hmail) {
    var plugin = this;
    if (!plugin.db) return next();

    plugin.db.hincrby(getOutKey(getOutDom(hmail)), 'TOTAL', -1);
    return next();
}
