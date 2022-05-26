'use strict';

const constants = require('haraka-constants');
const ipaddr    = require('ipaddr.js');

exports.register = function () {
    this.inherits('haraka-plugin-redis');

    this.load_limit_ini();
    let needs_redis = 0

    if (this.cfg.concurrency.enabled) {
        this.register_hook('connect_init', 'conn_concur_incr');
        this.register_hook('connect',      'check_concurrency');
        this.register_hook('disconnect',   'conn_concur_decr');
    }

    if (this.cfg.errors.enabled) {
        ['helo','ehlo','mail','rcpt','data'].forEach(hook => {
            this.register_hook(hook, 'max_errors');
        })
    }

    if (this.cfg.recipients.enabled) {
        this.register_hook('rcpt', 'max_recipients');
    }

    if (this.cfg.unrecognized_commands.enabled) {
        this.register_hook('unrecognized_command', 'max_unrecognized_commands');
    }

    if (this.cfg.rate_conn.enabled) {
        needs_redis++
        this.register_hook('connect_init', 'rate_conn_incr');
        this.register_hook('connect',      'rate_conn_enforce');
    }
    if (this.cfg.rate_rcpt_host.enabled) {
        needs_redis++
        this.register_hook('connect', 'rate_rcpt_host_enforce');
        this.register_hook('rcpt',    'rate_rcpt_host_incr');
    }
    if (this.cfg.rate_rcpt_sender.enabled) {
        needs_redis++
        this.register_hook('rcpt', 'rate_rcpt_sender');
    }
    if (this.cfg.rate_rcpt_null.enabled) {
        needs_redis++
        this.register_hook('rcpt', 'rate_rcpt_null');
    }
    if (this.cfg.rate_rcpt.enabled) {
        needs_redis++
        this.register_hook('rcpt', 'rate_rcpt');
    }

    if (this.cfg.outbound.enabled) {
        needs_redis++
        this.register_hook('send_email', 'outbound_increment');
        this.register_hook('delivered',  'outbound_decrement');
        this.register_hook('deferred',   'outbound_decrement');
        this.register_hook('bounce',     'outbound_decrement');
    }

    if (needs_redis) {
        this.register_hook('init_master',  'init_redis_plugin');
        this.register_hook('init_child',   'init_redis_plugin');
    }
}

exports.load_limit_ini = function () {
    const plugin = this;
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

    if (!this.cfg.concurrency) {   // no config file
        this.cfg.concurrency = {};
    }

    this.merge_redis_ini();
}

exports.shutdown = function () {
    if (this.db) this.db.quit();
}

exports.max_unrecognized_commands = function (next, connection, cmd) {

    if (!this.cfg.unrecognized_commands) return next();

    connection.results.push(this, {unrec_cmds: cmd, emit: true});

    const max = parseFloat(this.cfg.unrecognized_commands.max);
    if (!max || isNaN(max)) return next();

    const uc = connection.results.get(this).unrec_cmds;
    if (!uc || !uc.length) return next();

    if (uc.length <= max) return next();

    connection.results.add(this, { fail: 'unrec_cmds.max' });
    this.penalize(connection, true, 'Too many unrecognized commands', next);
}

exports.max_errors = function (next, connection) {
    if (!this.cfg.errors) return next();  // disabled in config

    const max = parseFloat(this.cfg.errors.max);
    if (!max || isNaN(max)) return next();

    if (connection.errors <= max) return next();

    connection.results.add(this, {fail: 'errors.max'});
    this.penalize(connection, true, 'Too many errors', next);
}

exports.max_recipients = function (next, connection, params) {
    if (!this.cfg.recipients) return next(); // disabled in config

    const max = this.get_limit('recipients', connection);
    if (!max || isNaN(max)) return next();

    const c = connection.rcpt_count;
    const count = c.accept + c.tempfail + c.reject + 1;
    if (count <= max) return next();

    connection.results.add(this, { fail: 'recipients.max' });
    this.penalize(connection, false, 'Too many recipient attempts', next);
}

exports.get_history_limit = function (type, connection) {

    const history_cfg = `${type}_history`;
    if (!this.cfg[history_cfg]) return;

    const history_plugin = this.cfg[history_cfg].plugin;
    if (!history_plugin) return;

    const results = connection.results.get(history_plugin);
    if (!results) {
        connection.logerror(this, `no ${history_plugin} results, disabling history due to misconfiguration`);
        delete this.cfg[history_cfg];
        return;
    }

    if (results.history === undefined) {
        connection.logdebug(this, `no history from : ${history_plugin}`);
        return;
    }

    const history = parseFloat(results.history);
    connection.logdebug(this, `history: ${history}`);
    if (isNaN(history)) return;

    if (history > 0) return this.cfg[history_cfg].good;
    if (history < 0) return this.cfg[history_cfg].bad;
    return this.cfg[history_cfg].none;
}

exports.get_limit = function (type, connection) {

    if (type === 'recipients') {
        if (connection.relaying && this.cfg.recipients.max_relaying) {
            return this.cfg.recipients.max_relaying;
        }
    }

    if (this.cfg[`${type}_history`]) {
        const history = this.get_history_limit(type, connection);
        if (history) return history;
    }

    return this.cfg[type].max || this.cfg[type].default;
}

exports.conn_concur_incr = async function (next, connection) {
    if (!this.db) return next();
    if (!this.cfg.concurrency) return next();

    const dbkey = this.get_concurrency_key(connection);

    try {
        const count = await this.db.incr(dbkey)

        if (isNaN(count)) {
            connection.results.add(this, {err: 'conn_concur_incr got isNaN'});
            return next();
        }

        connection.results.add(this, { concurrent_count: count });

        // repair negative concurrency counters
        if (count < 1) {
            connection.results.add(this, {
                msg: `resetting concurrent ${count} to 1`
            });
            this.db.set(dbkey, 1);
        }

        this.db.expire(dbkey, 3 * 60); // 3 minute lifetime
    }
    catch (err) {
        connection.results.add(this, { err: `conn_concur_incr:${err}` });
    }
    next();
}

exports.get_concurrency_key = function (connection) {
    return `concurrency|${connection.remote.ip}`;
}

exports.check_concurrency = function (next, connection) {

    const max = this.get_limit('concurrency', connection);
    if (!max || isNaN(max)) {
        connection.results.add(this, {err: "concurrency: no limit?!"});
        return next();
    }

    const count = parseInt(connection.results.get(this.name).concurrent_count);
    if (isNaN(count)) {
        connection.results.add(this, { err: 'concurrent.unset' });
        return next();
    }

    connection.results.add(this, { concurrent: `${count}/${max}` });

    if (count <= max) return next();

    connection.results.add(this, { fail: 'concurrency.max' });

    this.penalize(connection, true, 'Too many concurrent connections', next);
}

exports.penalize = function (connection, disconnect, msg, next) {
    const code = disconnect ? constants.DENYSOFTDISCONNECT : constants.DENYSOFT;

    if (!this.cfg.main.tarpit_delay) return next(code, msg);

    const delay = this.cfg.main.tarpit_delay;
    connection.loginfo(this, `tarpitting for ${delay}s`);

    setTimeout(() => {
        if (!connection) return;
        next(code, msg);
    }, delay * 1000);
}

exports.conn_concur_decr = async function (next, connection) {

    if (!this.db) return next();
    if (!this.cfg.concurrency) return next();

    try {
        const dbkey = this.get_concurrency_key(connection);
        await this.db.incrby(dbkey, -1)
    }
    catch (err) {
        connection.results.add(this, { err: `conn_concur_decr:${err}` })
    }
    next();
}

exports.get_host_key = function (type, connection) {

    if (!this.cfg[type]) {
        connection.results.add(this, { err: `${type}: not configured` });
        return
    }

    let ip;
    try {
        ip = ipaddr.parse(connection.remote.ip);
        if (ip.kind === 'ipv6') {
            ip = ipaddr.toNormalizedString();
        }
        else {
            ip = ip.toString();
        }
    }
    catch (err) {
        connection.results.add(this, { err: `${type}: ${err.message}` });
        return
    }

    const ip_array = ((ip.kind === 'ipv6') ? ip.split(':') : ip.split('.'));
    while (ip_array.length) {
        const part = ((ip.kind === 'ipv6') ? ip_array.join(':') : ip_array.join('.'));
        if (this.cfg[type][part] || this.cfg[type][part] === 0) {
            return [ part, this.cfg[type][part] ]
        }
        ip_array.pop();
    }

    // rDNS
    if (connection.remote.host) {
        const rdns_array = connection.remote.host.toLowerCase().split('.');
        while (rdns_array.length) {
            const part2 = rdns_array.join('.');
            if (this.cfg[type][part2] || this.cfg[type][part2] === 0) {
                return [ part2, this.cfg[type][part2] ]
            }
            rdns_array.pop();
        }
    }

    if (this.cfg[`${type}_history`]) {
        const history = this.get_history_limit(type, connection);
        if (history) return [ ip, history ]
    }

    // Custom Default
    if (this.cfg[type].default) {
        return [ ip, this.cfg[type].default ]
    }

    // Default 0 = unlimited
    return [ ip, 0 ]
}

exports.get_mail_key = function (type, mail, cb) {
    if (!this.cfg[type] || !mail) return cb();

    // Full e-mail address (e.g. smf@fsl.com)
    const email = mail.address();
    if (this.cfg[type][email] || this.cfg[type][email] === 0) {
        return cb(email, this.cfg[type][email]);
    }

    // RHS parts e.g. host.sub.sub.domain.com
    if (mail.host) {
        const rhs_split = mail.host.toLowerCase().split('.');
        while (rhs_split.length) {
            const part = rhs_split.join('.');
            if (this.cfg[type][part] || this.cfg[type][part] === 0) {
                return cb(part, this.cfg[type][part]);
            }
            rhs_split.pop();
        }
    }

    // Custom Default
    if (this.cfg[type].default) {
        return cb(email, this.cfg[type].default);
    }

    // Default 0 = unlimited
    cb(email, 0);
}

function getTTL (value) {

    const match = /^(\d+)(?:\/(\d+)(\S)?)?$/.exec(value);
    if (!match) return;

    const qty = match[2];
    const units = match[3];

    let ttl = qty ? qty : 60;  // Default 60s
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
            return ttl;
    }
    return ttl;
}

function getLimit (value) {
    const match = /^([\d]+)/.exec(value);
    if (!match) return 0;
    return parseInt(match[1], 10);
}

exports.rate_limit = async function (connection, key, value, cb) {

    if (value === 0) {     // Limit disabled for this host
        connection.loginfo(this, `rate limit disabled for: ${key}`);
        return cb(null, false);
    }

    // CAUTION: !value would match that 0 value -^
    if (!key || !value) return cb();
    if (!this.db) return cb();

    const limit = getLimit(value);
    const ttl = getTTL(value);

    if (!limit || ! ttl) {
        return cb(new Error(`syntax error: key=${key} value=${value}`));
    }

    connection.logdebug(this, `key=${key} limit=${limit} ttl=${ttl}`);

    try {
        const newval = await this.db.incr(key)
        if (newval === 1) this.db.expire(key, ttl);
        cb(null, parseInt(newval, 10) > limit); // boolean
    }
    catch (err) {
        cb(err);
    }
}

exports.rate_rcpt_host_incr = async function (next, connection) {
    if (!this.db) return next();

    const [ key, value ] = this.get_host_key('rate_rcpt_host', connection)
    if (!key || !value) return next();

    try {
        const newval = await this.db.incr(`rate_rcpt_host:${key}`)
        if (newval === 1) await this.db.expire(`rate_rcpt_host:${key}`, getTTL(value));
    }
    catch (err) {
        connection.results.add(this, { err })
    }
    next();
}

exports.rate_rcpt_host_enforce = async function (next, connection) {
    if (!this.db) return next();

    const [ key, value ] = this.get_host_key('rate_rcpt_host', connection)
    if (!key || !value) return next();

    const match = /^(\d+)/.exec(value);
    const limit = parseInt(match[0], 10);
    if (!limit) return next();

    try {
        const result = await this.db.get(`rate_rcpt_host:${key}`)

        if (!result) return next();
        connection.results.add(this, {
            rate_rcpt_host: `${key}:${result}:${value}`
        });

        if (result <= limit) return next();

        connection.results.add(this, { fail: 'rate_rcpt_host' });
        this.penalize(connection, false, 'recipient rate limit exceeded', next);
    }
    catch (err2) {
        connection.results.add(this, { err: `rate_rcpt_host:${err2}` });
        next();
    }
}

exports.rate_conn_incr = async function (next, connection) {
    if (!this.db) return next();

    const [ key, value ] = this.get_host_key('rate_conn', connection)
    if (!key || !value) return next();

    try {
        await this.db.hIncrBy(`rate_conn:${key}`, (+ new Date()).toString(), 1)
        // extend key expiration on every new connection
        await this.db.expire(`rate_conn:${key}`, getTTL(value) * 2)
    }
    catch (err2) {
        console.error(err2)
        connection.results.add(this, { err: err2 });
    }
    next()
}

exports.rate_conn_enforce = async function (next, connection) {
    if (!this.db) return next();

    const [ key, value ] = this.get_host_key('rate_conn', connection)
    if (!key || !value) return next();

    const limit = getLimit(value);
    if (!limit) {
        connection.results.add(this, { err: `rate_conn:syntax:${value}` });
        return next();
    }

    try {
        const tstamps = await this.db.hGetAll(`rate_conn:${key}`)
        if (!tstamps) {
            connection.results.add(this, { err: 'rate_conn:no_tstamps' });
            return next();
        }

        const d = new Date();
        d.setMinutes(d.getMinutes() - (getTTL(value) / 60));
        const periodStartTs = + d;  // date as integer

        let connections_in_ttl_period = 0;
        Object.keys(tstamps).forEach(ts => {
            if (parseInt(ts, 10) < periodStartTs) return; // older than ttl
            connections_in_ttl_period = connections_in_ttl_period + parseInt(tstamps[ts], 10);
        })
        connection.results.add(this, { rate_conn: `${connections_in_ttl_period}:${value}`});

        if (connections_in_ttl_period <= limit) return next();

        connection.results.add(this, { fail: 'rate_conn' });

        this.penalize(connection, true, 'connection rate limit exceeded', next);
    }
    catch (err2) {
        connection.results.add(this, { err: `rate_conn:${err}` });
        next();
    }
}

exports.rate_rcpt_sender = function (next, connection, params) {
    const plugin = this;

    plugin.get_mail_key('rate_rcpt_sender', connection.transaction.mail_from, (key, value) => {

        plugin.rate_limit(connection, `rate_rcpt_sender:${key}`, value, (err, over) => {
            if (err) {
                connection.results.add(plugin, { err: `rate_rcpt_sender:${err}` });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt_sender: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt_sender' });
            plugin.penalize(connection, false, 'rcpt rate limit exceeded', next);
        });
    });
}

exports.rate_rcpt_null = function (next, connection, params) {
    const plugin = this;

    if (!params) return next();
    if (Array.isArray(params)) params = params[0];
    if (params.user) return next();

    // Message from the null sender
    plugin.get_mail_key('rate_rcpt_null', params, (key, value) => {

        plugin.rate_limit(connection, `rate_rcpt_null:${key}`, value, (err2, over) => {
            if (err2) {
                connection.results.add(plugin, { err: `rate_rcpt_null:${err2}` });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt_null: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt_null' });
            plugin.penalize(connection, false, 'null recip rate limit', next);
        });
    });
}

exports.rate_rcpt = function (next, connection, params) {
    const plugin = this;
    if (Array.isArray(params)) params = params[0];
    plugin.get_mail_key('rate_rcpt', params, (key, value) => {

        plugin.rate_limit(connection, `rate_rcpt:${key}`, value, (err2, over) => {
            if (err2) {
                connection.results.add(plugin, { err: `rate_rcpt:${err2}` });
                return next();
            }

            connection.results.add(plugin, { rate_rcpt: value });

            if (!over) return next();

            connection.results.add(plugin, { fail: 'rate_rcpt' });
            plugin.penalize(connection, false, 'rate limit exceeded', next);
        });
    });
}

/*
 *        Outbound Rate Limits
 *
 */

function getOutDom (hmail) {
    // outbound isn't internally consistent using hmail.domain and hmail.todo.domain.
    // TODO: fix haraka/Haraka/outbound/HMailItem to be internally consistent.
    return hmail?.todo?.domain || hmail.domain;
}

function getOutKey (domain) {
    return `outbound-rate:${domain}`;
}

exports.outbound_increment = async function (next, hmail) {
    if (!this.db) return next();

    const outDom = getOutDom(hmail);
    const outKey = getOutKey(outDom);

    try {
        let count = await this.db.hIncrBy(outKey, 'TOTAL', 1)

        this.db.expire(outKey, 300);  // 5 min expire

        if (!this.cfg.outbound[outDom]) return next();
        const limit = parseInt(this.cfg.outbound[outDom], 10);
        if (!limit) return next();

        count = parseInt(count, 10);
        if (count <= limit) return next();

        const delay = this.cfg.outbound.delay || 30;
        next(constants.delay, delay);
    }
    catch (err) {
        this.logerror(`outbound_increment: ${err}`);
        next(); // just deliver
    }
}

exports.outbound_decrement = function (next, hmail) {
    if (!this.db) return next();

    this.db.hIncrBy(getOutKey(getOutDom(hmail)), 'TOTAL', -1);
    next();
}
