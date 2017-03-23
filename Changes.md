
## 1.0.4 - 2017-03-23

- for outbound, find domain at hmail.todo.domain then hmail.domain.
- noop: use es6 arrow functions

## 1.0.3 - 2017-03-09

- add `enabled=false` flag for each limit type, defaults to off, matching the docs.


## 1.0.2 - 2017-02-06

- when redis handle goes away, skip processing
- add a 5 minute expiration on outbound rate limit entries

## 1.0.1 - 2017-01-28

- increment rate_conn on connect_init
- increment rate_rcpt_host on rcpt/rcpt_ok

