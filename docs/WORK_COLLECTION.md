# Daily Work collection and quantity contract

The five countries are KZ, UZ, KG, TJ and AZ. The issue window is
`[D-1 06:00, D 06:00)` in Asia/Shanghai. Deliver five independently reviewed
WeChat drafts around 08:00; never publish. Normal supply is 15–20 distinct
business/investment stories per country. Ten to fourteen is an evidence-backed
scarcity exception; fewer than ten remains an open shortfall.

## Collect from real entrypoints

`config/work-source-registry.json` records public publisher/agency entrypoints,
final URLs, languages and actual observations. A registry entry is permission
to attempt discovery, not proof of readable current news. Multiple brands from
one media group count as one family. HTTP errors, redirects, encoding errors
and unavailable sources remain separate from successful full-text coverage.

Run the Python helpers in the Work execution environment (Python 3, lxml,
Pillow), not in the Node-only CloudBase runtime. The persisted editorial config
contains the exact same helper source and runtime registry for fresh executions.

```
python3 scripts/discover_work_sources.py --registry config/work-source-registry.json \
  --country kz --issue-date YYYY-MM-DD --output issue/kz
```

Each country uses its own durable issue directory. Persist the whole source
archive, append-only scan events and candidate ledger between scheduled runs.
Resume that directory; do not recreate it on every wake-up. After extracting a saved source archive, run `discover_work_sources.py --rebase-only --output issue/kz` to validate and relocate its internal evidence paths. After the cutoff,
also pass `--listing-not-before YYYY-MM-DDT06:00:00+08:00`. Never pass a future
cutoff or change an actual fetchedAt timestamp. Follow observed sections,
pagination and date archives to retrieve the previous local day, including
late recovery when a homepage mostly contains post-cutoff stories. Increase
bounded budgets on resume while gaps remain; a finite crawl is not exhaustion.

## Close the selection chain

For each candidate preserve discovery, fetched full text, article identity,
publication evidence, first-disclosure checks, duplicate checks and its final
selection decision with specific evidence. A publication timestamp is not proof
of first disclosure. Date-only/unknown time requires actual contextual review;
modification time cannot replace publication time. Preserve article-bound
JSON-LD and reject timestamps belonging to recommended stories.

Read the full original before drafting. Include practical SME subjects such as
tax operations, inspections, labor, finance, legal changes, utilities, logistics
and local business conditions alongside industry investment. Do not reject a
story merely for lacking an image. Do not manufacture supply using old stories,
duplicate events or splitting one event into multiple items.

Complete smaller manuscripts may be handed over immediately for independent
pre-review. This does not close their quantity shortfall. The quantity helper
recomputes coverage and ledger closure; arbitrary free-text explanations do not
qualify. The default aggregate gate requires quantity readiness as well as all
existing fact, source, image, layout and independent-review checks.

## Hand over and transport each ready country

After restoring an original-image archive in a fresh workspace, pass its
extracted root to `finalize_writer_handoff.py --image-root`. Locate the adopted
bytes using the recorded URL, SHA-256 and length, not an obsolete absolute path.
Path rebinding must preserve all editorial and image identity fields and must
not certify a visual review. Preserve old/new handoff hashes and obtain the
matching independent review before transport.

Do not wait for all five countries to finish before staging or submitting a
country that has already passed final review. Partial transport is explicit:
`build_work_package.py --countries kz,uz` emits `readyCountries` and exactly
those entries in `countries`. The scoped aggregate must contain only the same
drafts and reviews. Run `validate_work_package.py --countries kz,uz` for both
ingest and deliver; all existing checks still apply to every selected country.
The image manifest must contain the adopted images for that scope. Without an
explicit scope, building and validation continue to require all five countries.

Use partial transport only when the first necessary in-window health response
reports `capabilities.partialCountries=true` and the expected runtime. An older
deployment retains the existing full-package contract; record its version and
do not repeatedly POST unsupported partial payloads. Do not wake the service
outside its existing reservation to check a deployment.

Accepted versions are immutable. Persist a pending submission and its scope
before POST; an unknown result is checked using the same version before any
retry. A changed package uses the next real issue revision (`-r2` onward).
Automatic recovery chooses the newest accepted package containing each missing
country, while an active receipt pins its original version. Already succeeded
countries are not recreated when another country's package arrives.

A partial receipt is never five-country completion. Read issue-level state
across versions, then diagnose each country's actual receipt version. Only
five distinct successful countries with full image/layout/cover readback and
their quantity/quality requirements may close the daily issue.

## Preserve punctual transport without claiming quality completion

The 07:25 review run first tries the normal gate and continues actual expansion;
it must keep working until the real 07:30 threshold if the fallback is needed.
From real 07:30 Beijing time, a deadline fallback can transport the existing
independently verified drafts if quantity alone remains short. Run the same
aggregate gate with `--delivery-mode deadline_under_delivery`; this cannot
bypass fact/source/time/image/author checks. From the 2026-11-16 issue, every
transported country still needs at least ten real reviewed stories, including
deadline fallback. A 3–6 story manuscript remains in expansion/pre-review and
does not block another country that is ready. Keep `underDelivery=true`,
`shortfallOpen=true`, `continueExpansion=true`, and `qualityDeliveryComplete=false`
for shortages. Never label a 3–6 story issue completed. Keep a typed open
`kind=quantity_shortfall` issue; do not replace it with a generic closed review.
Continue source expansion while the shortfall remains open. Already accepted drafts retain the existing ownership protections: do not assume that re-ingesting a revision updates a succeeded draft, and never blindly overwrite or recreate one. User
publication closes that issue's content work and prevents further changes.

## Operations and evidence

Two existing Work tasks perform collection and independent review; no extra
monitoring task is required. Determine the issue from the scheduled Beijing
date, checkpoint complete country files and image bytes, and continue from
durable evidence rather than the chat connection. The backend only transports
an accepted package; it cannot repair a missing upstream manuscript by itself.

The user's cloud-cost constraint preserves the photographed **05:50–09:30**
warm interval (3 hours 40 minutes); the previously proposed extension to 15:00
was rejected and must not be applied. Work collection runs at 03:10, 04:10,
05:10, 06:10, 07:10 and 08:10 Beijing time. Independent review runs at :25
from 03 through 09. A real-time admission check forbids collection before
03:00, including early scheduler dispatch. Before 05:50, review is local/file
work only: a health probe or private image upload would also wake CloudBase.

The first post-cutoff delivery target is 06:25; 07:25 performs the main recovery
and acceptance work, while the 08:25 run continues already-owned repairs toward
the safe write cutoff. The 09:25 run reads saved state or database receipts only,
without calling CloudBase. New automatic country/image work stops at 09:20;
automatic recovery admits no work outside 05:50–09:30 and has no self-HTTP
heartbeat. Image staging enforces 05:50–09:20 for new requests by default;
its explicit manual override is reserved for a separately requested one-off
manual recovery, never scheduled work. Preserve unknown external results and
known media IDs rather than blindly recreating a draft after a time limit.

These are application controls, not a claim that provider billing is exactly
3 hours 40 minutes: in-flight work and provider idle reclamation still follow
the provider's rules. This repository does not change control-plane settings.
Do not shorten the paid warm interval until measured full-volume delivery shows
the same quality and sufficient recovery margin. Current evidence does not establish an OOM or identify
the actual model of the failed runs. Do not attribute failures to Terra, CPU
size or frontend disconnection without corresponding evidence.

Validation: `pnpm verify:offline`, `pnpm test:work-collector`, and
`python3 scripts/validate_work_package.py --selftest`. Live discovery smoke
tests are read-only and report candidate counts, never fabricated story counts.
