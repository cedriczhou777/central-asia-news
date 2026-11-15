# Work collection and handoff

These helpers mirror the scripts used by the scheduled Work collector. Work loads
its current durable configuration before each run. Updating this repository alone
does not install that configuration into a Work task.

`fetch_work_sources.py` accepts a JSON URL array on stdin and optionally `--audit`.
It validates HTML after gzip/deflate decoding, prefers the article metadata title,
refreshes listing evidence after 15 minutes, reuses unchanged article evidence,
and retries transient failures at most three times. Access denials are recorded
and never retried or bypassed. Its private evidence cache is git-ignored.

`finalize_writer_handoff.py` accepts `--draft`, `--source-audit`, and `--output`.
It validates the real publication window and adopted image bytes, requires actual
listing scans through cutoff, and separates a complete manuscript from the time
window being open. It never certifies independent content review. Country codes
are canonicalized; writer identity, category, source, time evidence, and actual
image inspection/captions or a concrete image gap are required.

With Python 3, Pillow and lxml installed, run
`python3 -m unittest discover -s scripts -p 'test_work_*.py' -v`.
Tests use synthetic HTML and mocked transport, never real news or publication.
The 19 regressions cover decompression, corrupt HTTP 200 responses, SVG titles,
cache expiry, bounded retries, denials, handoff identity, premature cutoff and
private-service startup readiness. The image stager waits at most three minutes
for a transient cold start before uploading; authentication denials and nonprivate
storage fail immediately. Readiness failures are saved without creating drafts.

The first-image thumbnail material ID is persisted before draft creation and
compared with the actual draft readback. Missing or different IDs cannot be
reported as successful delivery. Recovery may fix the same unverified draft only
when its title, digest, text and body images still match; it never recreates it.
Older receipts without the material ID retain a read-only WeChat image identity
comparison. User-published completed deliveries are not read or modified again.

Authenticated `GET /api/wechat/push?health=1&selftest=cover` reports the deployed
diagnostics version and a pure cover-comparison smoke check. It creates no media
or drafts and does not substitute for real daily delivery acceptance.

Recovery v7 also reconciles known draft IDs left in `updating` after an
interrupted update. It reads the same draft without preparing, creating or
updating anything. An exact readback closes the receipt; a mismatch or missing
draft ID keeps the existing lock and never creates a replacement.
