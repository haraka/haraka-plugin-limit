# limit

[![Build Status][ci-img]][ci-url]
[![Code Climate][clim-img]][clim-url]
[![NPM][npm-img]][npm-url]

Apply many types of limits to SMTP connections:

    - concurrent connections
    - max recipients
    - max unrecognized commands
    - max SMTP errors
    - outbound concurrency
    - rate limits
        - max connections / period
        - max recipients / period
            - by host
            - by sender
        - max null recipients / period


## Installation

```sh
cd /etc/haraka
npm i haraka-plugin-limit
echo 'limit' >> config/plugins
```

## Configure

Each limit type has values that can be defined in limit.ini. See the default limit.ini in this packages config directory.

Each limit type is disabled until `enabled=true` is set within it's block in limit.ini.

Haraka's config loader loads the defaults from limit.ini within this plugins installed config directory and applies any overrides found in the limit.ini within your Haraka install/config directory.


### [main]

- tarpit_delay = seconds *(optional)*

Set this to the length in seconds that you want to delay every SMTP
response to a remote client that has exceeded the rate limits.


## [redis]

Redis is the cluster-safe storage backend for maintaining the counters necessary to impose limits reliably.

- host (default: 127.0.0.1)
- port (default: 6379)
- db   (default: 0)

If this [redis] section or any values are missing, the defaults from redis.ini are used.


## concurrency

When `[concurrency]max` is defined, it limits the maximum number of simultaneous connections per IP address. Connection attempts in excess of the limit are optionally delayed before being disconnected.

This works well in conjunction with a history / reputation database, so that
one can assign very low concurrency (1) to bad or unknown senders and higher
limits for reputable mail servers.


### History

History: when enabled, the `history` setting is the name of a plugin that stores IP history / reputation results. The result store must have a positive value for good connections and negative integers for poor / undesirable connections. Karma is one such plugin.


## recipients

When `[recipients]max` is defined, each connection is limited to that number of recipients. The limit is imposed against **all** recipient attempts. Attempts in excess of the limit are issued a temporary failure.


## unrecognized_commands

When `[unrecognized_commands]max` is set, a connection that exceeeds the limit is disconnected.

Unrecognized commands are normally SMTP verbs invalidly issued by the client.
Examples:

* issuing AUTH when we didn't advertise AUTH extension
* issuing STARTTLS when we didn't advertise STARTTLS
* invalid SMTP verbs


### Limitations

The unrecognized_command hook is used by the `tls` and `auth` plugins, so
running this plugin before those would result in valid operations getting
counted against that connections limits. The solution is simple: list
`limit` in config/plugins after those.


## errors

When `[errors]max` is set, a connection that exceeeds the limit is disconnected. Errors that count against this limit include:

* issuing commands out of turn (MAIL before EHLO, RCPT before MAIL, etc)
* attempting MAIL on port 465/587 without AUTH
* MAIL or RCPT addresses that fail to parse



# Rate Limits

By default DENYSOFT will be returned when rate limits are exceeded. You can
also tarpit the connection delaying every response.

Missing sections disable that particular test.

They all use a common configuration format:

- \<lookup\> = \<limit\>[/time[unit]]  *(optional)*

   'lookup' is based upon the limit being enforced and is either an IP
   address, rDNS name, sender address or recipient address either in full
   or part.
   The lookup order is as follows and the first match in this order is
   returned and is used as the record key in Redis (except for 'default'
   which always uses the full lookup for that test as the record key):

   **IPv4/IPv6 address or rDNS hostname:**

   <pre>
   fe80:0:0:0:202:b3ff:fe1e:8329
   fe80:0:0:0:202:b3ff:fe1e
   fe80:0:0:0:202:b3ff
   fe80:0:0:0:202
   fe80:0:0:0
   fe80:0:0
   fe80:0
   fe80
   1.2.3.4
   1.2.3
   1.2
   1
   host.part.domain.com
   part.domain.com
   domain.com
   com
   default
   </pre>

   **Sender or Recipient address:**

   <pre>
   user@host.sub.part.domain.com
   host.sub.part.domain.com
   sub.part.domain.com
   part.domain.com
   domain.com
   com
   default
   </pre>

   In all tests 'default' is used to specify a default limit if nothing else has
   matched.

   'limit' specifies the limit for this lookup.  Specify 0 (zero) to disable
   limits on a matching lookup.

   'time' is optional and if missing defaults to 60 seconds.  You can optionally
   specify the following time units (case-insensitive):

   - s (seconds)
   - m (minutes)
   - h (hours)
   - d (days)


### [rate_conn]

This section limits the number of connections per interval from a given host
or set of hosts.

IP and rDNS names are looked up by this test.


### [rate_rcpt_host]

This section limits the number of recipients per interval from a given host or
set of hosts.

IP and rDNS names are looked up by this test.


### [rate_rcpt_sender]

This section limits the number of recipients per interval from a sender or
sender domain.

The sender is looked up by this test.


### [rate_rcpt]

This section limits the rate which a recipient or recipient domain can
receive messages over an interval.

Each recipient is looked up by this test.


### [rate_rcpt_null]

This section limits the rate at which a recipient can receive messages from
a null sender (e.g. DSN, MDN etc.) over an interval.

Each recipient is looked up by this test.


### [outbound]

enabled=true
; delay=30
;example.com=10

The number after the domain is the maximum concurrency limit for that domain.

Delay is the number of seconds to wait before retrying this message. Outbound concurrency is checked on every attempt to deliver.


## CAUTION

Applying strict connection and rate limits is an effective way to reduce spam delivery. It's also an effective way to inflict a stampeding herd on your mail server. When spam/malware is delivered by MTAs that have queue retries, if you disconnect early (which the rate limits do) with a 400 series code (a sane default), the remote is likely to try again. And again. And again. And again. This can cause an obscene rise in the number of connections your mail server handles. Plan a strategy for handling that.

## Strategies

- Don't enforce limits early. I use karma and wait until DATA before disconnecting. By then, the score of the connection is determinate and I can return a 500 series code telling the remote not to try again.
- enforce rate limits with your firewall instead


### TODO

Code coverage for plugins doesn't work because we run plugins under
vm.runInNewContext().

[![Code Coverage][cov-img]][cov-url]
[![Greenkeeper badge][gk-img]][gk-url]


[ci-img]: https://travis-ci.org/haraka/haraka-plugin-limit.svg
[ci-url]: https://travis-ci.org/haraka/haraka-plugin-limit
[cov-img]: https://codecov.io/github/haraka/haraka-plugin-limit/coverage.svg
[cov-url]: https://codecov.io/github/haraka/haraka-plugin-limit
[clim-img]: https://codeclimate.com/github/haraka/haraka-plugin-limit/badges/gpa.svg
[clim-url]: https://codeclimate.com/github/haraka/haraka-plugin-limit
[gk-img]: https://badges.greenkeeper.io/haraka/haraka-plugin-limit.svg
[gk-url]: https://greenkeeper.io/
[npm-img]: https://nodei.co/npm/haraka-plugin-limit.png
[npm-url]: https://www.npmjs.com/package/haraka-plugin-limit
