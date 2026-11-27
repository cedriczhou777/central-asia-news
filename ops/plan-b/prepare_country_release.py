"""Prepare and verify a signed country release around the existing image stager."""

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit

from assess_issue_delivery import COUNTRIES, unique_object
from build_work_package import build
from validate_work_package import digest, quantity_report
from verify_rendered_package import verify_rendered_package


def read_json(path, content=None):
    result = json.loads(path.read_bytes() if content is None else content, object_pairs_hook=unique_object)
    if not isinstance(result, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def signed_assets(articles):
    assets = {}
    for entry in articles:
        url = entry.get("image_url")
        if not url:
            continue
        key, size = entry.get("image_sha256"), entry.get("image_bytes")
        if (not isinstance(url, str) or urlsplit(url).scheme != "https"
                or not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key)
                or type(size) is not int or not 0 < size <= 10_000_000):
            raise ValueError("invalid signed image identity")
        identity = {"sha256": key, "bytes": size}
        if assets.setdefault(url, identity) != identity:
            raise ValueError("one signed image URL has two different byte identities")
    return assets


def image_location(root, entry):
    value = entry.get("path") or entry.get("local_path") or "images/" + entry["sha256"]
    if not isinstance(value, str) or "\\" in value or "\x00" in value:
        raise ValueError("invalid manifest image path")
    path = Path(value)
    if ".." in path.parts:
        raise ValueError("image path traversal is not allowed")
    if path.is_absolute():
        if path.is_relative_to(root):
            path = path.relative_to(root)
        elif path.parts[-2:] == ("images", entry["sha256"]):
            path = Path("images") / entry["sha256"]
        else:
            raise ValueError("absolute image path is outside manifest root")
    target = root
    for part in path.parts:
        target /= part
        if target.is_symlink():
            raise ValueError("image path symlinks are not allowed")
    return target


def collect_images(manifest_path, assets, directory):
    if assets and manifest_path is None:
        raise ValueError("signed images require a local image manifest")
    rows = read_json(manifest_path).get("images") if manifest_path else []
    if not isinstance(rows, list) or len(rows) > 200:
        raise ValueError("image manifest must contain at most 200 rows")
    by_url = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("url"), str) or row["url"] in by_url:
            raise ValueError("invalid or duplicate image manifest URL")
        by_url[row["url"]] = row
    result = []
    for url, identity in assets.items():
        row = by_url.get(url, {})
        if row.get("sha256") != identity["sha256"] or type(row.get("bytes")) is not int or row["bytes"] != identity["bytes"]:
            raise ValueError("manifest does not match the signed URL/SHA/length")
        source = image_location(manifest_path.parent.resolve(), row)
        target = directory / "images" / identity["sha256"]
        if source.exists():
            if not source.is_file() or source.stat().st_size != identity["bytes"]:
                raise ValueError("local reviewed image byte length does not match")
            data = source.read_bytes()
            if len(data) != identity["bytes"] or sha(data) != identity["sha256"]:
                raise ValueError("local reviewed image SHA-256 does not match")
            target.parent.mkdir(exist_ok=True)
            if not target.exists():
                target.write_bytes(data)
        # A missing local image is left unstaged. The existing stager can only
        # proceed by reading the exact SHA and length back from private storage.
        result.append({"url": url, **identity, "path": "images/" + identity["sha256"]})
    return {"images": result}


def run_gate(aggregate, issue, country, stage, mode):
    errors = verify_rendered_package(aggregate, issue, [country], stage, mode)
    if errors:
        if any('quantity/coverage/selection incomplete' in error for error in errors):
            review = quantity_report(aggregate, countries=[country]).get(country, {})
            for section in ('sourceCoverage', 'candidateLedgerValidation', 'quantityExceptionValidation'):
                failures = review.get(section, {}).get('errors', [])
                if failures:
                    failure = failures[0]
                    position = re.match(r'candidateLedger\[(\d+)\]', failure)
                    if position:
                        ledger = aggregate['drafts'][country].get('candidateLedger', [])
                        index = int(position[1])
                        if index < len(ledger):
                            row = ledger[index]
                            failure += f" ({row.get('sourceId', 'unknown')} {row.get('decision', 'unknown')})"
                    errors.append(section + ': ' + failure)
        raise ValueError(f"{stage} gate failed ({len(errors)}): " + " | ".join(errors[:5]))


def pack_release(root, draft, review, issue, country, version, mode, manifest, summary):
    entries = review.get("articles")
    if not isinstance(entries, list) or not entries or not all(isinstance(row, dict) for row in entries):
        raise ValueError("signed review requires nonempty article objects")
    assets = signed_assets(entries)
    categories = list(dict.fromkeys(e["category"] for e in entries))[:5]
    summary = summary or f"本期收录{len(entries)}条资讯，涵盖{'、'.join(categories)}等领域。"
    write_json(root / f"{country}.json", entries)
    write_json(root / "summaries.json", {country: summary})
    with redirect_stdout(io.StringIO()):
        build(root, issue, version, [country])
    package = read_json(root / "package.json")
    aggregate = {"issueDate": issue, "drafts": {country: draft}, "reviews": {country: review}, "package": package}
    run_gate(aggregate, issue, country, "ingest", mode)
    write_json(root / "aggregate_ingest.json", aggregate)
    stage_manifest = collect_images(manifest, assets, root)
    write_json(root / "staging_manifest.json", stage_manifest)
    files = {name: sha((root / name).read_bytes()) for name in ("aggregate_ingest.json", "package.json", "staging_manifest.json")}
    state = {
        "issueDate": issue, "country": country, "version": version, "deliveryMode": mode,
        "articles": len(entries), "uniqueImages": len(assets), "files": files,
    }
    write_json(root / "prepared.json", state)
    return state


def prepare(out, draft, review, issue, country, version, mode, manifest, summary=None):
    if out.exists() or out.is_symlink():
        raise ValueError("release directory already exists; reuse its existing stage receipt or choose a fresh version")
    out.parent.mkdir(parents=True, exist_ok=True)
    working = Path(tempfile.mkdtemp(prefix=".country-release-", dir=out.parent))
    try:
        state = pack_release(working, draft, review, issue, country, version, mode, manifest, summary)
        os.rename(working, out)
    finally:
        if working.exists():
            shutil.rmtree(working)
    return {"ok": True, "stage": "prepared_for_private_images", **state}


def stage_origin(contract_path):
    if contract_path.stat().st_mode & 0o077:
        raise ValueError("private contract must be owner-only")
    base = read_json(contract_path).get("base_url", "").rstrip("/")
    parsed = urlsplit(base)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise ValueError("private contract requires an HTTPS service origin")
    return sha(base.encode())


def verify_image_receipt(receipt, origin, version, country, assets):
    checkpoint = receipt.get("checkpoint", {})
    if (receipt.get("ok") is not True or receipt.get("createdDrafts") is not False
            or receipt.get("failures") != [] or checkpoint.get("context") != {
                "originHash": origin, "version": version, "countries": [country]
            }):
        raise ValueError("private image receipt has a failure or belongs to a different origin, issue version or country")
    if assets and receipt.get("readiness", {}).get("ready") is not True:
        raise ValueError("private image storage did not report ready")
    rows = receipt.get("images")
    if not isinstance(rows, list) or len(rows) != len(assets):
        raise ValueError("private image receipt does not contain exactly the reviewed images")
    unresolved = dict(assets)
    for row in rows:
        url = row["url"]
        if (row.get("ready") is not True or row.get("private") is not True
                or type(row.get("bytes")) is not int or unresolved.pop(url, None) != {
                    "sha256": row.get("sha256"), "bytes": row["bytes"]
                }):
            raise ValueError("private image receipt does not match signed URL/SHA/length")


def seal(out, receipt_path, staged_path, contract_path):
    state = read_json(out / "prepared.json")
    issue, country, version, mode = (state[k] for k in ("issueDate", "country", "version", "deliveryMode"))
    expected = ("aggregate_ingest.json", "package.json", "staging_manifest.json")
    if (set(state.get("files", {})) != set(expected) or any(
            sha((out / name).read_bytes()) != state["files"][name] for name in expected)):
        raise ValueError("prepared release checkpoint does not match its input files")
    if (receipt_path.resolve() == staged_path.resolve() or any(
            p.resolve() in {receipt_path.resolve(), staged_path.resolve()}
            for p in (out / name for name in (*expected, "prepared.json", "aggregate_deliver.json", "ready_to_ingest.json")))):
        raise ValueError("staged package and receipt must be separate from the prepared and final outputs")
    aggregate = read_json(out / "aggregate_ingest.json")
    expected_package = aggregate["package"]
    if expected_package.get("version") != version or expected_package.get("readyCountries") != [country]:
        raise ValueError("prepared package changed issue version or country scope")
    review = aggregate["reviews"][country]
    entries = review["articles"]
    signed_sha = digest(entries)
    if signed_sha != review["finalBodyHash"]:
        raise ValueError("review signature does not match the frozen article set")
    assets = signed_assets(entries)
    receipt_bytes = receipt_path.read_bytes()
    receipt = read_json(receipt_path, receipt_bytes)
    origin = stage_origin(contract_path)
    verify_image_receipt(receipt, origin, version, country, assets)
    staged_bytes = staged_path.read_bytes()
    staged = read_json(staged_path, staged_bytes)
    expected_package["countries"][country]["imageAssets"] = assets
    if staged != expected_package:
        raise ValueError("staging modified package fields other than the approved image assets")
    receipt_sha = sha(receipt_bytes)
    sealed_at = datetime.now(timezone.utc).isoformat()
    for row in entries:
        if row.get("image_url"):
            row["cloudImageProbe"] = {
                "accessible": True, "private": True, **assets[row["image_url"]],
                "evidenceRecordedAt": sealed_at, "stageReceiptSha256": receipt_sha,
            }
    if digest(entries) != signed_sha:
        raise ValueError("image staging modified signed editorial fields")
    run_gate(aggregate, issue, country, "deliver", mode)
    result = {
        "ok": True, "stage": "ready_for_existing_ingest", "issueDate": issue, "country": country,
        "version": version, "deliveryMode": mode, "articles": len(entries), "uniqueImages": len(assets),
        "stageReceiptSha256": receipt_sha, "stagedPackageFileSha256": sha(staged_bytes),
        "signedFinalBodyHash": signed_sha,
    }
    # Publish the readiness marker last. The supplied staged package stays byte-for-byte intact.
    with tempfile.TemporaryDirectory(prefix=".country-seal-", dir=out) as temp:
        for filename, content in (("aggregate_deliver.json", aggregate), ("ready_to_ingest.json", result)):
            target = Path(temp) / filename
            write_json(target, content)
            os.replace(target, out / filename)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--draft", type=Path, required=True)
    prep.add_argument("--review", type=Path, required=True)
    prep.add_argument("--image-manifest", type=Path)
    prep.add_argument("--issue", required=True)
    prep.add_argument("--country", required=True, choices=COUNTRIES)
    prep.add_argument("--version", required=True)
    prep.add_argument("--out", type=Path, required=True)
    prep.add_argument("--summary")
    prep.add_argument("--delivery-mode", choices=("normal", "deadline_under_delivery"), default="normal")
    finalize = commands.add_parser("seal")
    finalize.add_argument("--out", type=Path, required=True)
    finalize.add_argument("--receipt", type=Path, required=True)
    finalize.add_argument("--staged-package", type=Path, required=True)
    finalize.add_argument("--contract", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            result = prepare(args.out, read_json(args.draft), read_json(args.review), args.issue, args.country,
                             args.version, args.delivery_mode, args.image_manifest, args.summary)
        else:
            result = seal(args.out, args.receipt, args.staged_package, args.contract)
    except (AssertionError, AttributeError, KeyError, OSError, TypeError, ValueError) as error:
        # A schema failure must not print input keys, signed text or private config.
        reason = str(error)[:650] if type(error) is ValueError and not isinstance(error, json.JSONDecodeError) else "invalid or unreadable release input"
        print(json.dumps({"ok": False, "stage": args.action, "error": reason}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
