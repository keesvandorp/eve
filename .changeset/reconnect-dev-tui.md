---
"eve": patch
---

Running `eve dev` interactively now reattaches to the dev server already running for the same app root instead of refusing to start. Ownership is recorded in `.eve/dev-server.json`, claimed atomically under a lock, and reuse is gated on the owner process being alive, its health route responding, and a loopback URL. An explicit `--host`/`--port`/`PORT` opts out of reuse. A live server that cannot be reused still prints the package-manager-aware connect command.
