"""Verify the unchanged editorial gate and bind a transport package to its signed review."""

import argparse
from contextlib import redirect_stdout
from datetime import date
import io
import json
from pathlib import Path
import tempfile

from build_work_package import build
from source_article_images import EFFECTIVE_ISSUE, origin_error
from validate_work_package import validate


def verify_rendered_package(aggregate, issue, countries, stage, mode, *, now=None):
    if date.fromisoformat(issue).isoformat() != issue or aggregate.get("issueDate") != issue:
        return ["issue mismatch"]
    errors = validate(
        aggregate, require_cloud_images=stage == "deliver", now=now,
        delivery_mode=mode, countries=countries,
    )
    if errors:
        return errors
    if issue >= EFFECTIVE_ISSUE:
        for code, review in aggregate["reviews"].items():
            for position, entry in enumerate(review["articles"], 1):
                error = origin_error(entry)
                if error:
                    errors.append(f"{code} story {position}: {error}")
        if errors:
            return errors

    package = aggregate["package"]
    scope = countries or list(package["countries"])
    # Use the existing builder rather than duplicating template rules. Generate
    # only a temporary comparison of the exact independently signed articles.
    with tempfile.TemporaryDirectory(prefix="daily-render-check-") as workdir:
        root = Path(workdir)
        summaries = {}
        for code in scope:
            articles = aggregate["reviews"][code]["articles"]
            (root / f"{code}.json").write_text(json.dumps(articles, ensure_ascii=False))
            summaries[code] = package["countries"][code]["summary"]
        (root / "summaries.json").write_text(json.dumps(summaries, ensure_ascii=False))
        with redirect_stdout(io.StringIO()):
            build(root, issue, package["version"], countries)
        expected = json.loads((root / "package.json").read_text())["countries"]

    for code in scope:
        country = package["countries"][code]
        for key, value in expected[code].items():
            if country.get(key) != value:
                errors.append(f"{code}: {key} differs from the reviewed rendering")
        if stage != "deliver":
            continue
        assets = {}
        for entry in aggregate["reviews"][code]["articles"]:
            url = entry.get("image_url")
            if not url:
                continue
            probe = entry["cloudImageProbe"]
            sha = entry.get("image_sha256")
            size = entry.get("image_bytes")
            if (not isinstance(sha, str) or len(sha) != 64
                    or any(ch not in "0123456789abcdef" for ch in sha)
                    or type(size) is not int or size < 1
                    or probe.get("private") is not True or probe.get("sha256") != sha
                    or type(probe.get("bytes")) is not int or probe["bytes"] != size):
                errors.append(f"{code}: private image receipt does not match approved image bytes")
                continue
            asset = {"sha256": sha, "bytes": size}
            if url in assets and assets[url] != asset:
                errors.append(f"{code}: conflicting reviewed bytes for an image URL")
            assets[url] = asset
        if country.get("imageAssets", {}) != assets:
            errors.append(f"{code}: package image index differs from privately verified bytes")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("aggregate", type=Path)
    parser.add_argument("--issue", required=True)
    parser.add_argument("--countries", help="Exact approved country scope, e.g. kz,uz")
    parser.add_argument("--stage", choices=("ingest", "deliver"), default="deliver")
    parser.add_argument("--delivery-mode", choices=("normal", "deadline_under_delivery"), default="normal")
    args = parser.parse_args()
    scope = args.countries.split(",") if args.countries is not None else None
    aggregate = json.loads(args.aggregate.read_text())
    try:
        errors = verify_rendered_package(aggregate, args.issue, scope, args.stage, args.delivery_mode)
    except (AssertionError, KeyError, TypeError, ValueError):
        errors = ["malformed approved package or unsupported reviewed rendering inputs"]
    print(json.dumps({
        "ok": not errors, "transportAllowed": not errors, "issueDate": args.issue,
        "stage": args.stage, "deliveryMode": args.delivery_mode,
        "selectedCountries": scope, "errorCount": len(errors), "errors": errors[:12],
    }, ensure_ascii=False))
    raise SystemExit(bool(errors))


if __name__ == "__main__":
    main()
