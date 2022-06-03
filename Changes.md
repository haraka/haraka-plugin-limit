
### Unreleased

### [1.0.7] - 2022-06-03

- chore: add .release as a submodule
- ci: limit dependabot updates to production deps

### 1.0.6 - 2022-05-25

- feat: update redis commands to be v4 compatible
- feat: only load redis when needed, fixes #23
- style: replaced callbacks with async/await in:
    get_host_key, get_mail_key, and rate_limit
- dep(eslint): v6 -> v8
- dep(redis): 3 -> 4
- ci: add codeql & publish


### 1.0.5 - 2022-03-08

- fix invalid main field in package.json


### 1.0.4 - 2017-03-23

- for outbound, find domain at hmail.todo.domain then hmail.domain.
- noop: use es6 arrow functions


### 1.0.3 - 2017-03-09

- add `enabled=false` flag for each limit type, defaults to off, matching the docs.


### 1.0.2 - 2017-02-06

- when redis handle goes away, skip processing
- add a 5 minute expiration on outbound rate limit entries


### 1.0.1 - 2017-01-28

- increment rate_conn on connect_init
- increment rate_rcpt_host on rcpt/rcpt_ok


[1.0.7]: https://github.com/haraka/haraka-plugin-limit/releases/tag/1.0.7
