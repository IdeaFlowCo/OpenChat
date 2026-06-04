#!/usr/bin/env python3
"""publish-to-testers.py — assign the newest build to F&F + submit for Apple beta review.

Runs as the post-build step inside scripts/local-build.sh after `eas build --local`
uploads the .ipa to App Store Connect. Polls until the new build is processed and
visible in ASC (the upload is async — usually 30-90 seconds), then:

  1. POST /v1/betaGroups/{FF_ID}/relationships/builds   → assign to Friends & Family
  2. POST /v1/betaAppReviewSubmissions                   → trigger Apple Beta App Review

If a previous build is still in review (HTTP 422 ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW),
the assignment to F&F still succeeds — the review submission queues for after the
currently-reviewing build is approved.

Requires PyJWT: `pip3 install pyjwt[crypto]` (already installed on M3).

Environment variables expected (same set as eas):
  EXPO_ASC_API_KEY_PATH   path to AuthKey_*.p8
  EXPO_ASC_KEY_ID         e.g. KWJX4896S5
  EXPO_ASC_ISSUER_ID      e.g. 69a6de95-2833-47e3-e053-5b8c7c11a4d1
"""
from __future__ import annotations
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import jwt

# Hard-coded for this app — saved in beads memory `testflight-asc-ids`.
ASC_APP_ID = "6774991932"
FRIENDS_AND_FAMILY_GROUP_ID = "1c9f0d41-faff-4be5-b8a6-8c5f821e4ad3"
POLL_TIMEOUT_SECONDS = 600  # 10 minutes — generous, ASC usually ~60s
POLL_INTERVAL_SECONDS = 12


def get_token() -> str:
    key_path = os.environ.get("EXPO_ASC_API_KEY_PATH")
    key_id = os.environ.get("EXPO_ASC_KEY_ID")
    issuer = os.environ.get("EXPO_ASC_ISSUER_ID")
    if not (key_path and key_id and issuer):
        sys.exit("ERROR: EXPO_ASC_API_KEY_PATH / EXPO_ASC_KEY_ID / EXPO_ASC_ISSUER_ID must be set")
    with open(key_path) as f:
        private_key = f.read()
    now = int(time.time())
    return jwt.encode(
        {"iss": issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
        private_key,
        algorithm="ES256",
        headers={"kid": key_id},
    )


def asc(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        f"https://api.appstoreconnect.apple.com{path}",
        method=method,
        headers={
            "Authorization": f"Bearer {get_token()}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        resp = urllib.request.urlopen(req)
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:1000]
        try:
            return e.code, json.loads(body_text)
        except Exception:
            return e.code, body_text


def read_current_version() -> str:
    """Parse the marketing version (e.g. '0.1.11') out of app.config.js — used
    only for display in log lines. ASC's filter[version] is the BUILD NUMBER
    (45, 46…) not the marketing version, so we don't use this for the query."""
    here = os.path.dirname(os.path.abspath(__file__))
    cfg_path = os.path.join(here, "..", "app.config.js")
    src = open(cfg_path).read()
    m = re.search(r"version:\s*'(\d+\.\d+\.\d+)'", src)
    if not m:
        return "?"
    return m.group(1)


def find_latest_build(min_uploaded_iso: str | None = None) -> dict | None:
    """Return the most-recently-uploaded VALID build, or None if no VALID one
    has been processed yet. If `min_uploaded_iso` is given, also require the
    build was uploaded at-or-after that ISO timestamp (so we don't pick up an
    old VALID build when waiting for a fresh upload to finish processing)."""
    status, body = asc(
        "GET",
        f"/v1/builds?filter[app]={ASC_APP_ID}&sort=-uploadedDate&limit=5",
    )
    if status != 200 or not isinstance(body, dict):
        return None
    for b in body.get("data", []):
        attrs = b.get("attributes", {})
        if attrs.get("processingState") != "VALID":
            continue
        if attrs.get("expired"):
            continue
        if min_uploaded_iso and (attrs.get("uploadedDate") or "") < min_uploaded_iso:
            continue
        return b
    return None


def main() -> int:
    version = read_current_version()
    # Get the script's start time as the "min uploaded" floor — any VALID
    # build that was uploaded after we started polling is the fresh one.
    # 90s of slack so we don't miss a build uploaded just before this script
    # kicked in (the eas-build → ASC upload happens just before this runs).
    floor_iso = (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 600)) + "Z"
    )
    # Get pre-existing newest VALID build for comparison — so we wait for a
    # NEW upload rather than immediately picking up the previous one.
    existing = find_latest_build()
    existing_id = existing["id"] if existing else None
    existing_uploaded = (existing or {}).get("attributes", {}).get("uploadedDate", "")
    print(f"── publish-to-testers: v{version} (newest existing build: "
          f"{existing.get('attributes',{}).get('version','?') if existing else 'none'} "
          f"uploaded {existing_uploaded[:19]}) ──")

    deadline = time.time() + POLL_TIMEOUT_SECONDS
    build = None
    while time.time() < deadline:
        candidate = find_latest_build(min_uploaded_iso=existing_uploaded or floor_iso)
        if candidate and candidate["id"] != existing_id:
            build = candidate
            break
        print("  no newer VALID build yet; sleeping…")
        time.sleep(POLL_INTERVAL_SECONDS)

    if not build:
        print(f"ERROR: no newer VALID build appeared after {POLL_TIMEOUT_SECONDS}s — skipping")
        return 1

    build_id = build["id"]
    build_number = build["attributes"].get("version", "?")
    print(f"  found build {build_number} (id {build_id[:10]})")

    # 1. Assign to Friends and Family
    status, body = asc(
        "POST",
        f"/v1/betaGroups/{FRIENDS_AND_FAMILY_GROUP_ID}/relationships/builds",
        {"data": [{"type": "builds", "id": build_id}]},
    )
    if status == 204:
        print("  ✓ assigned to Friends and Family")
    elif status == 409:
        print("  ✓ already assigned to Friends and Family")
    else:
        print(f"  ✗ assign failed: status={status} body={body}")

    # 2. Submit for Apple Beta App Review
    status, body = asc(
        "POST",
        "/v1/betaAppReviewSubmissions",
        {
            "data": {
                "type": "betaAppReviewSubmissions",
                "relationships": {"build": {"data": {"type": "builds", "id": build_id}}},
            }
        },
    )
    if status == 201:
        print("  ✓ submitted for Apple Beta App Review (24-48h typical turnaround)")
    elif (
        status == 422
        and isinstance(body, dict)
        and "ANOTHER_BUILD_IN_REVIEW" in json.dumps(body)
    ):
        print("  ↩ another build is currently in review — this build will queue after that one")
    elif status == 409:
        print("  ✓ already submitted for review")
    else:
        print(f"  ✗ review submission failed: status={status} body={body}")

    print("── done ──")
    return 0


if __name__ == "__main__":
    sys.exit(main())
