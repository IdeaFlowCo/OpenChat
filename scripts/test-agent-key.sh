#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${OPENCHAT_BASE_URL:-http://127.0.0.1:41851}"
KEY="${OPENCHAT_AGENT_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "Set OPENCHAT_AGENT_KEY to a local oc_ agent key." >&2
  exit 2
fi

auth_header=("Authorization: Bearer $KEY")

me_json="$(curl -fsS -H "${auth_header[@]}" "$BASE_URL/api/auth/me")"
user_id="$(printf '%s' "$me_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); process.stdout.write(j.id || j.userId || "");})')"

if [[ -z "$user_id" ]]; then
  echo "Could not resolve owner user id from /api/auth/me" >&2
  exit 1
fi

conversation_json="$(
  curl -fsS \
    -H "${auth_header[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"participantIds\":[\"$user_id\"],\"type\":\"direct\"}" \
    "$BASE_URL/api/chat/conversations"
)"

conversation_id="$(printf '%s' "$conversation_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); process.stdout.write(j.id || "");})')"

if [[ -z "$conversation_id" ]]; then
  echo "POST /api/chat/conversations did not return a conversation id" >&2
  printf '%s\n' "$conversation_json" >&2
  exit 1
fi

curl -fsS -H "${auth_header[@]}" "$BASE_URL/api/chat/conversations/$conversation_id/messages" >/dev/null

echo "ok: agent key created/fetched self-DM conversation $conversation_id"
