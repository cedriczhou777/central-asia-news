"""Evidence-backed quantity assessment; useful drafts may still go to pre-review.

This is a structural evidence contract, not a substitute for editorial review.
Registry sources use id/country/family/kind/institutionType/entrypoints/allowedHosts.
Evidence is an array of {url, observedAt, description|quote|sha256} objects.
"""
from datetime import datetime, timedelta, timezone
import re
from urllib.parse import urlparse, urlunparse, urlsplit, urlunsplit, parse_qsl, urlencode

from editorial_policy import EFFECTIVE_ISSUE, MAX_ARTICLES, MIN_ARTICLES, TARGET_ARTICLES

POLICY_VERSION = "quantity-v1"
LISTING_ROLES = {"listing", "section", "archive", "feed", "sitemap", "home", "date_archive", "pagination", "language"}
TERMINAL_UNAVAILABLE_STATUSES = {401, 403, 404, 410}


def terminal_source_failure(row):
    """An evidenced refusal, nonretryable unusable response, or actual retry exhaustion."""
    return (row.get('status') in TERMINAL_UNAVAILABLE_STATUSES
            or row.get('error') == 'source_public_https_only' and bool(row.get('attemptedAt'))
            and row.get('fetchRetryable') is not True
            or row.get('status') == 200 and row.get('contentValidated') is False
            and bool(row.get('error')) and bool(row.get('parserVersion'))
            and row.get('fetchRetryable') is not True
            or row.get('retryBudgetExhausted') is True
            and type(row.get('transportAttemptsTotal')) is int
            and row['transportAttemptsTotal'] >= 3 and bool(row.get('error'))
            and row.get('fetchRetryable') is not True)


def _dt(value):
    if not isinstance(value, str) or not value:
        raise ValueError("timezone-aware timestamp required")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timezone required")
    return result


def _url(value):
    if not isinstance(value, str):
        return None
    p = urlparse(value)
    if p.scheme != "https" or not p.hostname or p.username or p.password:
        return None
    return urlunparse(p._replace(fragment=""))


def _detail(value):
    return (isinstance(value, str) and len(value.strip()) >= 8
            and value.strip().lower() not in {
                "not relevant", "irrelevant", "old news", "no news today",
                "insufficient news", "已核查没有新闻", "当天没有新闻", "不符合采用要求",
            })


def _story_source_key(value):
    """Use the same transport URL identity as the aggregate delivery gate."""
    if not _url(value):
        return None
    parts = urlsplit(value)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "gclid", "_ga")]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, urlencode(sorted(query)), ""))


def _registry_sources(registry, country):
    if isinstance(registry, dict):
        registry = registry.get("sources")
    return [r for r in (registry or []) if isinstance(r, dict)
            and str(r.get("country", "")).lower() == country]


def _language(value):
    """HTML language subtags share a base; und is absence of an observation."""
    if not isinstance(value, str):
        return None
    base = value.strip().lower().replace("_", "-").split("-", 1)[0]
    return base if re.fullmatch(r"[a-z]{2,3}", base or "") and base not in {"und", "zxx", "unk"} else None


def _listing_attempt(row):
    # Parser kind may be weak on a real article. Its explicit fetch job remains
    # article; it cannot masquerade as the final listing/section refresh.
    # A registered listing job can discover a specific article instead. Strong
    # article identity cannot stand in for refreshing a listing, even at a
    # mislabelled home/section/language entrypoint. Unknown/failed responses
    # remain attempts; they are never promoted to successful article evidence.
    return ((row.get("role") in LISTING_ROLES and row.get("kind") != "article")
            or (row.get("role") is None and row.get("kind") == "listing"))


def _review_errors(review, record, now, context, identity=False, history=()):
    if not isinstance(review, dict):
        return [context + ": actual review object required"]
    errors = []
    if review.get("status", None if identity else "verified") != "verified":
        errors.append(context + ": verified review status required")
    if not isinstance(review.get("reviewer"), str) or not review["reviewer"].strip():
        errors.append(context + ": actual reviewer identity required")
    actual_hash = record["row"].get("sourceHash")
    if (not re.fullmatch(r"[0-9a-fA-F]{64}", str(actual_hash or ""))
            or review.get("sourceHash") != actual_hash):
        errors.append(context + ": review sourceHash must match this actual text")
    # Same bytes retain a valid prior manual review. A later refetch must not
    # invalidate the original archived text/time/evidence that was reviewed.
    anchors = [record] + [r for r in history if r["source"]["id"] == record["source"]["id"]
                          and r["urls"].intersection(record["urls"])
                          and r["row"].get("sourceHash") == actual_hash and r.get("readable")]
    anchor = min(anchors, key=lambda r: r["time"])
    try:
        reviewed = _dt(review.get("reviewedAt"))
        if not anchor["time"] <= reviewed <= now:
            raise ValueError("review must follow actual fetched text")
        if any(_dt(e.get("observedAt")) > reviewed for e in review.get("evidence", []) if isinstance(e, dict)):
            raise ValueError("review predates evidence")
    except (ValueError, TypeError):
        errors.append(context + ": review must follow this fetch and its evidence")
    errors.extend(_evidence_errors(review.get("evidence"), [anchor], now, context))
    return errors


def _record_candidates(ledger, source_id, urls):
    entries = []
    for candidate in ledger:
        if not isinstance(candidate, dict):
            continue
        entries.append(candidate)
        entries.extend(o for o in (candidate.get("discoveryOrigins") or []) if isinstance(o, dict))
    # An origin keeps its own human review and evidence. The main article's
    # review is never silently substituted for a differently fetched alias.
    return [c for c in entries if c.get("sourceId") == source_id
            and _url(c.get("source_url")) in urls]


def _article_url_identity(url):
    parts = urlparse(url)
    return urlunparse(parts._replace(path=parts.path.rstrip('/')))


def _evidence_errors(value, records, now, context, *, publisher_article_aliases=False):
    """Require actual archived observations, not a free-text explanation alone."""
    if not isinstance(value, list) or not value:
        return [context + ": evidence array required"]
    errors = []
    for index, item in enumerate(value):
        label = f"{context}[{index}]"
        if not isinstance(item, dict) or not _url(item.get("url")):
            errors.append(label + ": public HTTPS evidence URL required")
            continue
        try:
            observed = _dt(item.get("observedAt"))
            if observed > now:
                raise ValueError("future evidence")
        except (ValueError, TypeError):
            errors.append(label + ": real observation timestamp required")
            continue
        evidence_url = _url(item['url'])
        bound = []
        for record in records:
            if record['time'] > observed:
                continue
            if evidence_url in record['urls'] or (
                    publisher_article_aliases and record['row'].get('role')=='article'
                    and any(_article_url_identity(evidence_url)==_article_url_identity(url) for url in record['urls'])):
                bound.append(record)
        if not bound:
            errors.append(label + ": no matching real source observation")
        if not (_detail(item.get("description")) or _detail(item.get("quote"))
                or re.fullmatch(r"[0-9a-fA-F]{64}", str(item.get("sha256", "")))):
            errors.append(label + ": specific observed content or hash required")
    return errors


def _discovery_exception_errors(draft, exception, records, unavailable, now):
    """A bounded crawl cannot certify scarcity while silently leaving work queued."""
    state = draft.get("discoveryState")
    if not isinstance(state, dict):
        return ["quantity exception requires the actual discoveryState summary"]
    errors = []
    if (str(state.get("country", "")).lower() != str(draft.get("country", "")).lower()
            or state.get("issueDate") != draft.get("issueDate")):
        errors.append("discoveryState must identify this issue and country")
    try:
        observed = _dt(state.get("observedAt"))
        if observed > now:
            raise ValueError("future discovery")
    except (ValueError, TypeError):
        errors.append("discoveryState needs its actual observation timestamp")
        observed = now
    budgets = state.get("budgetEvents")
    if not isinstance(budgets, list):
        errors.append("discoveryState budgetEvents array required")
        budgets = []
    queues = []
    for key in ("listingQueueRemaining", "articleQueueRemaining"):
        value = state.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            errors.append("discoveryState " + key + " must be an actual nonnegative queue count")
        else:
            queues.append(value)
    if not isinstance(state.get("needs_expansion"), bool) or not isinstance(state.get("complete"), bool):
        errors.append("discoveryState complete/needs_expansion flags required")
    raw_leads = state.get("rawLeadsQueued", state.get("rawLeadQueueRemaining", 0))
    if not isinstance(raw_leads, int) or isinstance(raw_leads, bool) or raw_leads < 0:
        errors.append("discoveryState rawLeadsQueued must be an actual nonnegative count")
        raw_leads = 0
    if ("rawLeadsQueued" in state and "rawLeadQueueRemaining" in state
            and state["rawLeadsQueued"] != state["rawLeadQueueRemaining"]):
        errors.append("discoveryState raw lead queue counts disagree")
    cutoff = _dt(draft["issueDate"] + "T06:00:00+08:00")
    # Exhausting the queue before 06:00 is a genuine snapshot, but cannot by
    # itself certify scarcity over the still-open remainder of this issue.
    before_cutoff = observed < cutoff
    incomplete = bool(before_cutoff or budgets or any(queues) or raw_leads or state.get("needs_expansion") is not False or state.get("complete") is not True)
    if not incomplete:
        return errors
    review = exception.get("discoveryReview")
    if not isinstance(review, dict):
        return errors + ["pre-cutoff/incomplete discovery needs an evidenced independent discoveryReview"]
    if review.get("reviewedBy") != exception.get("reviewer"):
        errors.append("discoveryReview reviewer must match independent exception reviewer")
    try:
        reviewed = _dt(review.get("reviewedAt"))
        exception_time = _dt(exception.get("reviewedAt"))
        if not observed <= reviewed <= exception_time <= now or any(r["time"] > reviewed for r in records):
            raise ValueError("review must follow actual discovery")
    except (ValueError, TypeError):
        errors.append("discoveryReview must actually follow current discovery and precede exception approval")
        reviewed = now
    readable_ids = {r["source"]["id"] for r in records if r.get("readable")} - set(unavailable)
    reviewed_ids = review.get("sourceIdsReviewed")
    if not isinstance(reviewed_ids, list) or not readable_ids.issubset(set(reviewed_ids)):
        errors.append("discoveryReview must cover every declared readable source")
    if review.get("incompleteSourceIds") != []:
        errors.append("discoveryReview must explicitly close all incompleteSourceIds")
    budget_ids = {b.get("sourceId") for b in budgets if isinstance(b, dict) and b.get("sourceId")}
    if any(not isinstance(b, dict) or not b.get("sourceId") for b in budgets):
        errors.append("discovery budget events require source identity")
    required_resolution = budget_ids - set(unavailable)
    if before_cutoff:
        required_resolution.update(readable_ids)
    # Use the saved queue's actual source identities when available. Anonymous
    # leftover counts require accounting for every readable source instead.
    for count_key, queue_key in (("listingQueueRemaining", "listingQueue"), ("articleQueueRemaining", "articleQueue")):
        count = state.get(count_key)
        if not isinstance(count, int) or count <= 0:
            continue
        queue = state.get(queue_key)
        if (isinstance(queue, list) and len(queue) == count
                and all(isinstance(item, dict) and item.get("sourceId") for item in queue)):
            required_resolution.update(item["sourceId"] for item in queue if item["sourceId"] not in unavailable)
        else:
            required_resolution.update(readable_ids)
    if raw_leads:
        # Unfetched DOM leads are not editorial candidates. A scarcity exception
        # nevertheless needs source-level window/irrelevance evidence for their
        # remaining queue; it never requires fetching every historical link.
        lead_ids = state.get("queuedLeadSourceIds")
        if not (isinstance(lead_ids, list) and lead_ids
                and all(isinstance(sid, str) and sid.strip() for sid in lead_ids)):
            lead_queue = state.get("leadQueue")
            if (isinstance(lead_queue, list) and len(lead_queue) == raw_leads
                    and all(isinstance(item, dict) and isinstance(item.get("sourceId"), str)
                            and item["sourceId"].strip() for item in lead_queue)):
                lead_ids = [item["sourceId"] for item in lead_queue]
            else:
                lead_ids = list(readable_ids)
        required_resolution.update(set(lead_ids) - set(unavailable))
    resolutions = review.get("resolvedBudgetEvidence", [])
    if not isinstance(resolutions, list):
        errors.append("discoveryReview resolvedBudgetEvidence must be an array")
        resolutions = []
    resolved_ids = set()
    for index, item in enumerate(resolutions):
        label = f"discoveryReview.resolvedBudgetEvidence[{index}]"
        if not isinstance(item, dict):
            errors.append(label + ": specific source evidence required")
            continue
        sid = item.get("sourceId")
        source_records = [r for r in records if r["source"]["id"] == sid]
        if before_cutoff:
            # A later signature cannot extend an earlier observation's range.
            # Actual final-window listing attempts can close the early snapshot
            # without rerunning an already completed crawl or altering its time.
            source_records = [r for r in source_records if r["time"] >= cutoff and _listing_attempt(r["row"])]
        item_errors = _evidence_errors([item], source_records, reviewed, label)
        item_errors.extend(_evidence_errors(item.get("evidence"), source_records, reviewed, label + ".evidence"))
        if not _detail(item.get("description")):
            item_errors.append(label + ": explain why this issue window is covered or the remaining work is unrelated")
        if not item_errors:
            resolved_ids.add(sid)
        errors.extend(item_errors)
    if not required_resolution.issubset(resolved_ids):
        errors.append("discoveryReview missing actual budget/queue resolution evidence for: "
                      + ", ".join(sorted(required_resolution - resolved_ids)))
    return errors


def evaluate_quantity(draft, audit, now=None, registry=None):
    """Return quantity/coverage/ledger status without suppressing draft handoff.

    A failed source request is a real attempt, never a successful full-text family.
    Declared sources normally need an actual final-window listing attempt,
    unless every declared entrypoint is proven terminally unavailable this issue
    and no readable alternative listing exists. Never retry a cached refusal just
    to manufacture a later fetchedAt; transient failures still need a final try.
    Plan B may bind an independent, archived gap/discovery review. Short
    editions can use a smaller observed source set with the same story checks.
    Unfetched candidates may be rejected using the matching failure/listing evidence.
    Every successfully fetched article and every adopted article needs a ledger row.
    """
    now = now or datetime.now(timezone.utc)
    country = str(draft.get("country", "")).lower()
    end = _dt(draft["issueDate"] + "T06:00:00+08:00")
    start = end - timedelta(days=1)
    registry = registry if registry is not None else draft.get("sourceRegistry")
    sources = _registry_sources(registry, country)
    coverage_errors = []
    by_id = {}
    for source in sources:
        sid = source.get("id")
        if not sid or sid in by_id:
            coverage_errors.append("registry: missing or duplicate source id")
            continue
        if not source.get("family") or source.get("kind") not in {"media", "institution", "social"}:
            coverage_errors.append(f"registry {sid}: family/type required")
        by_id[sid] = source
    if not by_id:
        coverage_errors.append("registry: no declared country sources")

    records = []
    raw_ledger = draft.get("candidateLedger") if isinstance(draft.get("candidateLedger"), list) else []
    daily_archive = draft.get('planBCoverage') is not None and draft['issueDate'] >= EFFECTIVE_ISSUE
    language_pending, identity_pending, reviewed_identities = [], [], []
    attempts, media_attempts, fulltext_families, institution_types, after_cutoff = set(), set(), set(), set(), set()
    for index, row in enumerate(audit if isinstance(audit, list) else []):
        label = f"audit[{index}]"
        if not isinstance(row, dict):
            coverage_errors.append(label + ": object required")
            continue
        source = by_id.get(row.get("sourceId"))
        if not source:
            coverage_errors.append(label + ": registered sourceId required")
            continue
        family = source.get("family")
        if row.get("family") != family or row.get("sourceType") != source.get("kind"):
            coverage_errors.append(label + ": source identity mismatch")
            continue
        source_type = source.get("institutionType")
        if source.get("kind") == "institution" and (not source_type or row.get("institutionType") != source_type):
            coverage_errors.append(label + ": institution type mismatch")
            continue
        try:
            fetched = _dt(row.get("fetchedAt") or (
                row.get("attemptedAt") if terminal_source_failure(row) else None))
            if not start <= fetched <= now:
                raise ValueError("outside actual scan period")
        except (ValueError, TypeError):
            coverage_errors.append(label + ": real current scan timestamp required")
            continue
        request_url = _url(row.get("url"))
        hosts = {str(h).lower() for h in source.get("allowedHosts", [])}
        if not request_url or urlparse(request_url).hostname not in hosts:
            coverage_errors.append(label + ": request URL outside source allowedHosts")
            continue
        status = row.get("status")
        if not ((isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599)
                or row.get("error")):
            coverage_errors.append(label + ": actual HTTP result/error required")
            continue
        sid = source["id"]
        attempts.add(sid)
        if source.get("kind") == "media":
            media_attempts.add(family)
        elif source_type:
            institution_types.add(source_type)
        if fetched >= end and _listing_attempt(row):
            after_cutoff.add(sid)

        urls = {request_url}
        final_url = _url(row.get("final_url"))
        if final_url:
            urls.add(final_url)
        readable = status == 200 and row.get("contentValidated") is True
        if readable and (not final_url or urlparse(final_url).hostname not in hosts):
            coverage_errors.append(label + ": successful final URL outside source allowedHosts or missing")
            readable = False
        record = {"row": row, "source": source, "urls": urls, "time": fetched, "readable": readable}
        candidates = _record_candidates(raw_ledger, sid, urls)
        if daily_archive and readable and row.get('role')=='article' and final_url:
            canonical = _url(row.get('canonicalURL', row.get('canonical_url')))
            registered = {_url(e.get('url')) for e in source.get('entrypoints', []) if isinstance(e, dict)}
            if (canonical and canonical not in registered and urlparse(canonical).hostname==urlparse(final_url).hostname
                    and urlparse(canonical).path.rstrip('/') not in ('', '/ru', '/en', '/uz', '/kg', '/az', '/tj', '/kz')
                    and any(_url(c.get('canonicalURL'))==canonical and c.get('sourceHash')==row.get('sourceHash')
                            and isinstance(c.get('sourceHash'), str) for c in candidates)):
                urls.add(canonical)
        entries = [e for e in source.get("entrypoints", []) if isinstance(e, dict)]
        exact_entries = [e for e in entries if _url(e.get("url")) == request_url]
        languages = {_language(e.get("language")) for e in (exact_entries or entries)} - {None}
        # An article may inherit a particular entrypoint's declared language.
        inherited = _language(row.get("expectedLanguage"))
        if not exact_entries and inherited in languages:
            languages = {inherited}
        actual_language = _language(row.get("html_lang") or row.get("htmlLanguage") or row.get("language"))
        known_mismatch = row.get("knownLanguageMismatch")
        if known_mismatch and not isinstance(known_mismatch, dict):
            coverage_errors.append(label + ": registered language mismatch evidence must be an object")
            known_mismatch = None
        if known_mismatch:
            # A registered bad HTML declaration is evidence of an unreliable
            # tag, never evidence that a new article's body is that language.
            actual_language = None
        language_review_errors = []
        if readable and actual_language is None:
            reviews = [row.get("languageReview")] + [c.get("languageReview") for c in candidates]
            for review in reviews:
                if not isinstance(review, dict):
                    continue
                errors = _review_errors(review, record, now, label + ".languageReview", history=records)
                reviewed_language = _language(review.get("language"))
                if reviewed_language is None:
                    errors.append(label + ".languageReview: actually identified language required")
                if known_mismatch:
                    revision = row.get("sourceRevisionHash")
                    if (not re.fullmatch(r"[0-9a-fA-F]{64}", str(revision or ""))
                            or review.get("sourceRevisionHash") != revision):
                        errors.append(label + ".languageReview: sourceRevisionHash must match this language evidence revision")
                    if reviewed_language != _language(known_mismatch.get("contentLanguage")):
                        errors.append(label + ".languageReview: registered content language must be actually verified")
                if not errors:
                    actual_language = reviewed_language
                    break
                language_review_errors.extend(errors)
        language_verified = actual_language is not None and (not languages or actual_language in languages)
        if readable and actual_language is not None and languages and actual_language not in languages:
            if daily_archive:
                # Retain the archived attempt for the independent coverage
                # proof. An unexpected language cannot count as readable or
                # supply an adopted original.
                record['readable'] = False
            else:
                coverage_errors.append(label + ": successful response language conflicts with declared registry language")
        if readable and not language_verified:
            language_pending.append({"sourceId": sid, "url": request_url,
                                     "reason": "Actual language requires review; expected language is never substituted",
                                     "reviewErrors": language_review_errors})

        fulltext = readable and language_verified and row.get("kind") == "article"
        identity_reviewed = False
        if readable and language_verified and not fulltext and candidates:
            for candidate in candidates:
                review = candidate.get("articleIdentityReview")
                if not isinstance(review, dict):
                    continue
                errors = _review_errors(review, record, now, label + ".articleIdentityReview", identity=True, history=records)
                if not errors:
                    fulltext = identity_reviewed = True
                    reviewed_identities.append({"sourceId": sid, "url": request_url, "sourceHash": row.get("sourceHash")})
                    break
                identity_pending.append({"sourceId": sid, "url": request_url, "reviewErrors": errors})
        if fulltext:
            fulltext_families.add(family)
        record.update(fulltext=fulltext, languageVerified=language_verified,
                      actualLanguage=actual_language, articleIdentityReviewed=identity_reviewed)
        records.append(record)

    available = {s["id"] for s in by_id.values() if s.get("available") is not False}
    unavailable_evidence = {}
    for sid in sorted(available):
        source = by_id[sid]
        entrypoints = {_url(e.get("url")) for e in source.get("entrypoints", []) if isinstance(e, dict)}
        # A missing/malformed registry entry cannot manufacture an exemption.
        if not entrypoints or None in entrypoints:
            continue
        source_records = [r for r in records if r["source"]["id"] == sid]
        readable_alternative = any(r["readable"] and (_listing_attempt(r["row"])
            or _url(r["row"].get("url")) in entrypoints) for r in source_records)
        if readable_alternative:
            continue
        failures = {}
        for entrypoint in entrypoints:
            matching = [r for r in source_records if _url(r["row"].get("url")) == entrypoint]
            if not matching:
                break
            # Use the latest real request, not a stale refusal followed by a 5xx
            # or a now-readable replacement. Unavailable means all entrypoints.
            latest = max(matching, key=lambda r: r["time"])
            if not terminal_source_failure(latest["row"]):
                break
            failures[entrypoint] = latest
        if len(failures) == len(entrypoints):
            unavailable_evidence[sid] = [
                {"url": url, "status": r["row"]["status"], "fetchedAt": r["time"].isoformat(),
                 "sourceId": sid, "role": r["row"].get("role"),
                 "retryBudgetExhausted": r['row'].get('retryBudgetExhausted', False),
                 "transportAttemptsTotal": r['row'].get('transportAttemptsTotal'),
                 "description": "Actual issue-window refusal or exhausted transport budget; never counted as success"}
                for url, r in sorted(failures.items())
            ]
    unavailable = set(unavailable_evidence)
    unavailable_excluded = available.intersection(unavailable) - after_cutoff
    reviewed_gaps = set()
    proof = draft.get('planBCoverage')
    verified_plan_b = False
    if proof is not None:
        # This contract is attached by cloud_release after recomputing the
        # frozen assessment from its immutable source archive. The independent
        # gap signature is rechecked here; count alone never waives coverage.
        try:
            from source_coverage import require_coverage_review
            if (proof.get('country') != country or _dt(proof.get('windowEnd')) != end
                    or _dt(proof.get('observedAt')) > now
                    or not re.fullmatch(r'[0-9a-f]{64}', str(draft.get('planBFinalHash', '')))):
                raise ValueError('coverage_scope_or_hash_invalid')
            require_coverage_review(proof, draft,
                {'reviewer': draft.get('planBReviewerRun'), 'coverageReview': draft.get('planBCoverageReview')},
                draft['planBFinalHash'], raw_ledger)
            reviewed_gaps = {row['sourceId'] for row in proof.get('gaps', [])}
            if not reviewed_gaps.issubset(available):
                raise ValueError('coverage_gap_source_unregistered')
            verified_plan_b = True
        except (ValueError, TypeError, KeyError) as error:
            coverage_errors.append('independent Plan B coverage: ' + str(error))
            reviewed_gaps = set()
    missing_cutoff = sorted(available - after_cutoff - unavailable - reviewed_gaps)
    articles = draft.get("articles", [])
    count = len(articles)
    daily_policy = verified_plan_b and draft["issueDate"] >= EFFECTIVE_ISSUE
    target = TARGET_ARTICLES if daily_policy else 15
    exception_min = MIN_ARTICLES if daily_policy else (
        1 if verified_plan_b and draft["issueDate"] >= '2026-11-26' else 10)
    short_edition = verified_plan_b and draft["issueDate"] >= '2026-11-26' and 0 < count < 15
    if not short_edition and len(media_attempts) < 8:
        coverage_errors.append("need attempts across at least 8 distinct media families")
    if short_edition and not fulltext_families:
        coverage_errors.append("short edition requires a verified full-text source")
    elif not short_edition and len(fulltext_families) < 3:
        coverage_errors.append("need successful full text from at least 3 distinct source families")
    if not short_edition and len(institution_types) < 3:
        coverage_errors.append("need attempts across at least 3 distinct institution types")
    if missing_cutoff:
        coverage_errors.append("missing after-cutoff listing attempt: " + ", ".join(missing_cutoff))
    coverage = {
        "complete": not coverage_errors,
        "mediaFamiliesAttempted": sorted(media_attempts),
        "fullTextFamiliesSuccessful": sorted(fulltext_families),
        "institutionTypesAttempted": sorted(institution_types),
        "sourceIdsAttempted": sorted(attempts),
        "declaredAvailableSourceIds": sorted(available),
        "afterCutoffSourceIds": sorted(after_cutoff),
        "actualAfterCutoffScanned": bool(available) and available.issubset(after_cutoff),
        "afterCutoffScanned": not missing_cutoff and bool(available),
        "unavailableSourceIds": sorted(unavailable),
        "unavailableExcluded": sorted(unavailable_excluded),
        "unavailableEvidence": unavailable_evidence,
        "independentlyReviewedGapSourceIds": sorted(reviewed_gaps),
        "unfinishedDiscoveryReviewed": proof.get('reviewWork', []) if isinstance(proof, dict) else [],
        "languagePending": language_pending,
        "articleIdentityPending": identity_pending,
        "articleIdentityReviewed": reviewed_identities,
        "missingAfterCutoffSourceIds": missing_cutoff,
        "errors": coverage_errors,
    }

    ledger = draft.get("candidateLedger")
    ledger_errors, seen_ids, seen_urls, selected_urls, candidate_urls = [], set(), set(), set(), set()
    accounted_records = set()
    counts = {"selected": 0, "rejected": 0, "pending": 0, "heldOutOfEdition": 0, "fullTextFetched": 0}
    if not isinstance(ledger, list) or not ledger:
        ledger_errors.append("candidateLedger: nonempty candidate decision ledger required")
        ledger = []
    adopted_ids = [a.get("id") for a in articles]
    if len(set(map(str, adopted_ids))) != len(articles):
        ledger_errors.append("duplicate adopted article IDs")
    adopted_keys = [_story_source_key(a.get("source_url")) for a in articles]
    if len(set(adopted_keys)) != len(articles):
        ledger_errors.append("duplicate adopted source URLs")
    adopted_urls = {_url(a.get("source_url")) for a in articles}
    for index, candidate in enumerate(ledger):
        label = f"candidateLedger[{index}]"
        if not isinstance(candidate, dict):
            ledger_errors.append(label + ": object required")
            continue
        cid, url = candidate.get("id"), _url(candidate.get("source_url"))
        if not cid or cid in seen_ids or not url or url in seen_urls:
            ledger_errors.append(label + ": unique id and source_url required")
        seen_ids.add(cid)
        seen_urls.add(url)
        if url:
            candidate_urls.add(url)
        source = by_id.get(candidate.get("sourceId"))
        if not source or candidate.get("family") != source.get("family"):
            ledger_errors.append(label + ": source identity mismatch")
        bound = [r for r in records if url in r["urls"] and source and r["source"]["id"] == source["id"]]
        accounted_records.update(id(r) for r in bound)
        # A listing can establish discovery or support an unfetched rejection.
        source_observations = [r for r in records if source and r["source"]["id"] == source["id"]]
        try:
            discovered = _dt(candidate.get("discoveredAt"))
            if not start <= discovered <= now:
                raise ValueError("invalid discovery time")
        except (ValueError, TypeError):
            ledger_errors.append(label + ": actual discovery timestamp required")
        decision = candidate.get("decision")
        if decision not in {"selected", "rejected", "pending"}:
            ledger_errors.append(label + ": selected/rejected/pending decision required")
            continue
        held = (daily_policy and decision=='pending' and cid not in adopted_ids
                and candidate.get('editorialState') in ('pending_source_check','pending_time_check')
                and candidate.get('reviewedBy')==draft.get('planBReviewerRun') and bool(draft.get('planBReviewerRun'))
                and _detail(candidate.get('reason')) and not candidate.get('mustProcess')
                and not candidate.get('important') and candidate.get('priority') not in ('critical','important'))
        counts['heldOutOfEdition' if held else decision] += 1
        fulltext_at = candidate.get("fullTextFetchedAt")
        if not fulltext_at and any(r.get("articleIdentityReviewed") for r in bound):
            # Preserve the parser's original classification/time. Only a bound
            # human identity review can upgrade readable text to article text.
            fulltext_at = candidate.get("readableTextFetchedAt")
        if fulltext_at:
            try:
                actual_fetched = _dt(fulltext_at)
                if actual_fetched > now or not any(r["fulltext"] and r["time"] == actual_fetched for r in bound):
                    raise ValueError("no matching full text")
            except (ValueError, TypeError):
                if not (daily_policy and decision=='rejected' and cid not in adopted_ids):
                    ledger_errors.append(label + ": fullTextFetchedAt lacks matching successful article audit")
                # Historical rejected candidates retain the raw archive. An
                # uncorroborated fetch cannot count as full text or prove an
                # adopted item, and the rejection still needs real evidence.
                fulltext_at = None
            if fulltext_at:
                counts["fullTextFetched"] += 1
        if decision == "pending":
            continue
        if not _detail(candidate.get("reason")):
            ledger_errors.append(label + ": concrete terminal reason required")
        evidence_records = bound if fulltext_at or decision == "selected" else source_observations
        ledger_errors.extend(_evidence_errors(candidate.get("evidence"), evidence_records, now, label))
        if decision == "selected":
            selected_urls.add(url)
            if not fulltext_at:
                ledger_errors.append(label + ": selected candidate needs actual full text")
            # Archive parsers may bind JSON-LD to the publisher's slashless
            # article URL while the actual same-source request has a final
            # slash. This is solely an alias within this archived article.
            ledger_errors.extend(_evidence_errors(candidate.get("publicationEvidence"), evidence_records, now,
                label + ".publicationEvidence", publisher_article_aliases=daily_archive))
        for origin_index, origin in enumerate(candidate.get("discoveryOrigins") or []):
            origin_label = f"{label}.discoveryOrigins[{origin_index}]"
            if not isinstance(origin, dict):
                ledger_errors.append(origin_label + ": real source observation required")
                continue
            origin_url = _url(origin.get("source_url"))
            origin_source = by_id.get(origin.get("sourceId"))
            origin_hash = origin.get("sourceHash")
            primary_hash = candidate.get("sourceHash")
            if (daily_policy and origin_url==url and origin_source==source
                    and origin.get('id')==cid and origin_hash==primary_hash):
                continue  # The primary observation was already checked above.
            if (not origin_source or not origin_url
                    or origin.get("family", origin_source.get("family")) != origin_source.get("family")
                    or not re.fullmatch(r"[0-9a-fA-F]{64}", str(origin_hash or "")) or origin_hash != primary_hash):
                ledger_errors.append(origin_label + ": source identity and same actual text hash required")
                continue
            origin_records = [r for r in records if r["source"]["id"] == origin_source["id"]
                              and origin_url in r["urls"] and r["row"].get("sourceHash") == origin_hash and r["fulltext"]]
            primary_records = [r for r in bound if r["row"].get("sourceHash") == primary_hash and r["fulltext"]]
            if not origin_records or not primary_records:
                ledger_errors.append(origin_label + ": matching successful original and primary article observations required")
                continue
            if origin_url != url:
                canonical = _url(candidate.get("canonicalURL"))
                declared_entries = {_url(e.get("url")) for s in by_id.values() for e in s.get("entrypoints", []) if isinstance(e, dict)}
                safe_canonical = (canonical and canonical == _url(origin.get("canonicalURL"))
                                  and canonical not in declared_entries
                                  and urlparse(canonical).path.rstrip("/") not in {"", "/ru", "/en", "/uz", "/kg", "/az"})
                origin_records = [r for r in origin_records if _url(r["row"].get("canonicalURL", r["row"].get("canonical_url"))) == canonical]
                primary_records = [r for r in primary_records if _url(r["row"].get("canonicalURL", r["row"].get("canonical_url"))) == canonical]
                if not safe_canonical or not origin_records or not primary_records:
                    ledger_errors.append(origin_label + ": aliases need the same actual non-listing canonical and text hash")
                    continue
            accounted_records.update(id(r) for r in origin_records)
    if counts["pending"]:
        ledger_errors.append("pending candidates still require source/selection decisions")
    if selected_urls != adopted_urls:
        ledger_errors.append("selected candidate URLs must exactly match adopted article URLs")
    for record in records:
        if record["fulltext"] and id(record) not in accounted_records:
            ledger_errors.append("successful full-text article missing from candidate ledger: " + record["row"]["url"])
    ledger_status = {"complete": not ledger_errors, **counts, "errors": ledger_errors}

    exception_errors = []
    exception = draft.get("quantityExceptionReview")
    exception_approved = False
    if exception_min <= count < target:
        if not isinstance(exception, dict) or exception.get("status") != "approved":
            exception_errors.append("a short edition requires independent quantity exception approval")
        else:
            reviewer = exception.get("reviewer")
            if not isinstance(reviewer, str) or not reviewer.strip() or reviewer.strip() == str(draft.get("writerRun", "")).strip():
                exception_errors.append("quantity exception reviewer must differ from writer")
            try:
                reviewed_at = _dt(exception.get("reviewedAt"))
                if reviewed_at > now or any(r["time"] > reviewed_at for r in records):
                    raise ValueError("review precedes current source observations or is in the future")
            except (ValueError, TypeError):
                exception_errors.append("actual exception review timestamp required")
            if not _detail(exception.get("reason")):
                exception_errors.append("specific independent shortfall review reason required")
            exception_errors.extend(_evidence_errors(exception.get("evidence"), records, now, "quantityExceptionReview"))
            if not short_edition:
                exception_errors.extend(_discovery_exception_errors(draft, exception, records, unavailable, now))
        exception_approved = not exception_errors
    ready = (coverage["complete"] and ledger_status["complete"]
             and (target <= count <= 20 or exception_min <= count < target and exception_approved))
    review = draft.get("review") if isinstance(draft.get("review"), dict) else {}
    independent = (review.get("independentReviewCompleted") is True
                   and bool(review.get("reviewer"))
                   and str(review.get("reviewer")).strip() != str(draft.get("writerRun", "")).strip())
    open_issues = any((isinstance(issue, str) and bool(issue.strip()))
                     or (isinstance(issue, dict) and issue.get("closed") is not True
                         and issue.get("status") not in {"closed", "resolved"})
                     for issue in list(draft.get("issues") or []) + list(review.get("issues") or []))
    return {
        "quantityPolicyVersion": POLICY_VERSION,
        "sourceCoverage": coverage,
        "candidateLedgerValidation": ledger_status,
        "quantityExceptionValidation": {"approved": exception_approved, "errors": exception_errors},
        "quantityStatus": "target_met" if ready and count >= target else "exception_approved" if ready else "needs_expansion",
        "quantityReady": ready,
        "qualityDeliveryComplete": ready and independent and not open_issues,
        "shortfallOpen": not ready,
        "quantitySummary": {
            "adopted": count, "targetMin": target, "targetMax": MAX_ARTICLES, "exceptionMin": exception_min,
            "reason": "Quantity and source/candidate evidence complete" if ready else
                      "Expand sources and close candidate decisions; free-text shortfall explanations do not complete delivery",
        },
    }
