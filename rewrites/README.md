# Rewrite assets

This directory contains page assets and the home for future HTML/CSS/JavaScript rewrite policies.

- intercept.css styles the fixed timer and status toolbar appended to proxied HTML.
- Add per-site rules here when a site needs transformations beyond the generic same-origin URL rewriting in src/main.rs.

Keep rewrite rules narrow and test them. Do not use a rewrite rule to silently expand a session to arbitrary upstream hosts; cross-origin routing needs its own allow-list, DNS pinning, cookie isolation, and request authorization policy.
