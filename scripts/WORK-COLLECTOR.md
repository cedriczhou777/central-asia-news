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

With Python 3, Pillow and lxml installed, run `pnpm test:work-collector`.
Tests use synthetic HTML and mocked transport, never real news or publication.
The 15 regressions cover decompression, corrupt HTTP 200 responses, SVG titles,
cache expiry, bounded retries, denials, handoff identity and premature cutoff.

Cover readback diagnostics additionally compare the actual WeChat cover URL with
the first transported body image identity. A thumbnail merely being present is
not sufficient. This check is read-only and does not recreate existing drafts.
