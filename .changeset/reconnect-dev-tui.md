---
"eve": patch
---

Running `eve dev` interactively now reconnects to the healthy loopback dev server already running for the same app root, with a fresh session for each attached terminal UI. Eve records ownership in versioned, process-safe state; a live process retains ownership even when its server is unavailable, while `--host`, `--port`, or `PORT` opts out of attachment and reports the existing process instead.
