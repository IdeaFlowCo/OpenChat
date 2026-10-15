#!/usr/bin/env python3
"""Measure remaining traffic on the legacy host chat.globalbr.ai (OpenChat-9cz8).

chat.globalbr.ai is proxied by Cloudflare (zone globalbr.ai). The noos nginx
access log does not record the Host header, so Cloudflare's GraphQL analytics
are the reliable per-host source. This script prints, for a time window, the
old host's top paths, user agents (OpenChat/<build> = iOS build number) and
response statuses, and the machine clients that have not moved yet.

Usage:
  infra/old-host-traffic.py [hours=24]

Credentials (read-only analytics is enough), first match wins:
  CF_API_TOKEN env var (Bearer token with Zone Analytics:Read), or
  ~/.cloudflare/config.json with email + global_api_key (Jacob's machines).
Never prints credentials.
"""
import datetime
import json
import os
import sys
import urllib.request

HOST = "chat.globalbr.ai"
ZONE = "globalbr.ai"
API = "https://api.cloudflare.com/client/v4"


def auth_headers():
    token = os.environ.get("CF_API_TOKEN")
    if token:
        return {"Authorization": f"Bearer {token}"}
    cfg = json.load(open(os.path.expanduser("~/.cloudflare/config.json")))
    return {"X-Auth-Email": cfg["email"], "X-Auth-Key": cfg["global_api_key"]}


def call(url, headers, body=None):
    req = urllib.request.Request(url, headers={**headers, "Content-Type": "application/json"}, data=body)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24.0
    headers = auth_headers()
    zone_id = call(f"{API}/zones?name={ZONE}", headers)["result"][0]["id"]
    until = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    since = until - datetime.timedelta(hours=hours)
    flt = '{datetime_geq:$s,datetime_lt:$u,clientRequestHTTPHost:"%s"}' % HOST
    query = """query($z:String!,$s:Time!,$u:Time!){viewer{zones(filter:{zoneTag:$z}){
      status: httpRequestsAdaptiveGroups(limit:20,filter:%(f)s,orderBy:[count_DESC]){count dimensions{edgeResponseStatus}}
      paths: httpRequestsAdaptiveGroups(limit:30,filter:%(f)s,orderBy:[count_DESC]){count dimensions{clientRequestHTTPMethodName clientRequestPath edgeResponseStatus}}
      agents: httpRequestsAdaptiveGroups(limit:30,filter:%(f)s,orderBy:[count_DESC]){count dimensions{userAgent}}
      ips: httpRequestsAdaptiveGroups(limit:15,filter:%(f)s,orderBy:[count_DESC]){count dimensions{clientIP userAgent}}
    }}}""" % {"f": flt}
    variables = {"z": zone_id, "s": since.isoformat().replace("+00:00", "Z"), "u": until.isoformat().replace("+00:00", "Z")}
    res = call(f"{API}/graphql", headers, json.dumps({"query": query, "variables": variables}).encode())
    if res.get("errors"):
        sys.exit(f"Cloudflare GraphQL error: {res['errors'][0].get('message')}")
    zone = res["data"]["viewer"]["zones"][0]
    print(f"{HOST}: last {hours:g}h ({variables['s']} .. {variables['u']})")
    total = sum(g["count"] for g in zone["status"])
    print(f"\n== status (total {total})")
    for g in zone["status"]:
        print(f"{g['count']:>8}  {g['dimensions']['edgeResponseStatus']}")
    for key, label in (("paths", "top paths"), ("agents", "top user agents"), ("ips", "top client IPs")):
        print(f"\n== {label}")
        for g in zone[key]:
            d = g["dimensions"]
            print(f"{g['count']:>8}  " + "  ".join(str(v)[:110] for v in d.values()))


if __name__ == "__main__":
    main()
