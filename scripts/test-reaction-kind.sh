#!/usr/bin/env bash
#
# Smoke test for reaction kinds (openchat-reaction-kind).
#
# Exercises the full agent-key path end-to-end against a running server:
#   1. an oc_ agent key can add a PLAIN reaction (JWT-only restriction lifted)
#   2. an oc_ agent key can add a 'filed' KIND reaction carrying an href
#   3. GET messages returns the kind reaction with {kind:'filed', href:...}
#      while plain reactions stay unchanged (backward compatible)
#   4. an invalid kind is rejected with HTTP 400
#
# Requires: a local server + a valid oc_ agent key. Mirrors scripts/test-agent-key.sh.
#   OPENCHAT_BASE_URL   (default http://127.0.0.1:41851)
#   OPENCHAT_AGENT_KEY  (an oc_ key for a seeded user)
set -euo pipefail

BASE_URL="${OPENCHAT_BASE_URL:-http://127.0.0.1:41851}"
KEY="${OPENCHAT_AGENT_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "Set OPENCHAT_AGENT_KEY to a local oc_ agent key." >&2
  exit 2
fi

auth_header=("Authorization: Bearer $KEY")

json_field() {
  # $1 = field name; reads JSON from stdin
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j["'"$1"'"] ?? ""));})'
}

me_json="$(curl -fsS -H "${auth_header[@]}" "$BASE_URL/api/auth/me")"
user_id="$(printf '%s' "$me_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.id||j.userId||"");})')"
[[ -n "$user_id" ]] || { echo "Could not resolve owner user id" >&2; exit 1; }

# Self-DM conversation to hold a message.
conversation_json="$(curl -fsS -H "${auth_header[@]}" -H "Content-Type: application/json" \
  -d "{\"participantIds\":[\"$user_id\"],\"type\":\"direct\"}" \
  "$BASE_URL/api/chat/conversations")"
conversation_id="$(printf '%s' "$conversation_json" | json_field id)"
[[ -n "$conversation_id" ]] || { echo "No conversation id" >&2; printf '%s\n' "$conversation_json" >&2; exit 1; }

# Post a message to react to.
message_json="$(curl -fsS -H "${auth_header[@]}" -H "Content-Type: application/json" \
  -d '{"content":"reaction-kind smoke test"}' \
  "$BASE_URL/api/chat/conversations/$conversation_id/messages")"
message_id="$(printf '%s' "$message_json" | json_field id)"
[[ -n "$message_id" ]] || { echo "No message id" >&2; printf '%s\n' "$message_json" >&2; exit 1; }

# 1. Plain reaction via agent key (JWT-only restriction lifted).
curl -fsS -H "${auth_header[@]}" -H "Content-Type: application/json" \
  -d '{"emoji":"👍"}' \
  "$BASE_URL/api/chat/messages/$message_id/reactions" >/dev/null
echo "ok: agent key added plain reaction"

# 2. Filed kind reaction with href.
HREF="https://wikihub.md/@bot/kb/filed-receipt-smoke"
curl -fsS -H "${auth_header[@]}" -H "Content-Type: application/json" \
  -d "{\"emoji\":\"🗂️\",\"kind\":\"filed\",\"href\":\"$HREF\"}" \
  "$BASE_URL/api/chat/messages/$message_id/reactions" >/dev/null
echo "ok: agent key added 'filed' kind reaction"

# 3. Read back and assert both reactions present with kind/href intact.
msgs_json="$(curl -fsS -H "${auth_header[@]}" "$BASE_URL/api/chat/conversations/$conversation_id/messages")"
printf '%s' "$msgs_json" | MID="$message_id" HREF="$HREF" node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const data=JSON.parse(s);
  const msgs=Array.isArray(data)?data:(data.messages||[]);
  const m=msgs.find(x=>x.id===process.env.MID);
  if(!m){console.error("message not found in list");process.exit(1);}
  const rs=m.reactions||[];
  const plain=rs.find(r=>r.emoji==="👍"&&!r.kind);
  const filed=rs.find(r=>r.kind==="filed");
  if(!plain){console.error("plain reaction missing/backward-compat broken");process.exit(1);}
  if(!filed){console.error("filed kind reaction missing");process.exit(1);}
  if(filed.href!==process.env.HREF){console.error("filed href mismatch: "+filed.href);process.exit(1);}
  console.log("ok: read back plain + filed reactions; filed.href="+filed.href);
});'

# 4. Invalid kind rejected with 400.
code="$(curl -s -o /dev/null -w '%{http_code}' -H "${auth_header[@]}" -H "Content-Type: application/json" \
  -d '{"emoji":"👍","kind":"bogus"}' \
  "$BASE_URL/api/chat/messages/$message_id/reactions")"
[[ "$code" == "400" ]] || { echo "expected 400 for invalid kind, got $code" >&2; exit 1; }
echo "ok: invalid kind rejected with 400"

echo "PASS: reaction kinds smoke test"
