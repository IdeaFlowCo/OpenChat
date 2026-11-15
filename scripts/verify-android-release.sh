#!/usr/bin/env bash
# Verify a published APK without credentials or installing it.
set -euo pipefail

if [ "${1:-}" = --help ]; then
  echo "Usage: $0 [release-tag [expected-bytes [version [version-code]]]]"
  echo 'Defaults: android-20261115, 103835096 bytes, version 1.0.20, code 4. Requires curl, unzip, aapt2/aapt, and sha256sum or shasum.'
  exit 0
fi
[ "$#" -le 4 ] || { echo 'Expected a release tag, byte count, version, and version code at most.' >&2; exit 1; }
tag=${1:-android-20261115}
expected_bytes=${2:-103835096}
expected_version=${3:-1.0.20}
expected_code=${4:-4}
expected_package=com.jacobcole.openchat
# Trusted release signer; rotation requires a reviewed pin change.
expected_signer=dc568c4ccbf4dde1ed7c411a01e3e40f519cc93a57a26a6e8b32708b61ce8cea
aapt_tool=${AAPT:-$(command -v aapt2 || command -v aapt || true)}
[[ "$tag" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid release tag.' >&2; exit 1; }
[[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || { echo 'Expected bytes must be a positive integer.' >&2; exit 1; }

[ -n "$aapt_tool" ] && [ -x "$aapt_tool" ] || { echo 'Missing aapt2/aapt (set AAPT to its executable path).' >&2; exit 1; }

for tool in curl unzip; do
  command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done
if command -v sha256sum >/dev/null; then
  sha_tool=sha256sum
elif command -v shasum >/dev/null; then
  sha_tool=shasum
else
  echo 'Missing sha256sum or shasum.' >&2; exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/openchat-android-verify.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
base="https://github.com/IdeaFlowCo/OpenChat/releases/download/$tag"
url="$base/OpenChat.apk"
apk="$work_dir/OpenChat.apk"

fail() { echo "Android release verification failed: $*" >&2; exit 1; }
# Follow redirects, but require HTTPS on every hop. Drafts and expired artifacts fail.
head_result=$(curl --fail --silent --show-error --location --head \
  --proto '=https' --proto-redir '=https' --max-redirs 10 --max-time 60 \
  --dump-header "$work_dir/headers" --output /dev/null \
  --write-out '%{http_code}|%{content_type}' "$url")
IFS='|' read -r head_status head_type <<< "$head_result"
[ "$head_status" = 200 ] || fail "HEAD returned HTTP $head_status"
[ "${head_type%%;*}" = application/vnd.android.package-archive ] || fail "HEAD content type: $head_type"
# Inspect only the final response's Content-Length, when the server provides one.
head_bytes=$(awk 'toupper($1) ~ /^HTTP\// {n=""} tolower($1)=="content-length:" {n=$2; sub(/\r$/, "", n)} END {print n}' "$work_dir/headers")
[ -z "$head_bytes" ] || [ "$head_bytes" = "$expected_bytes" ] || fail "HEAD size: $head_bytes"

get_result=$(curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --max-redirs 10 --max-time 180 \
  --output "$apk" --write-out '%{http_code}|%{content_type}' "$url")
IFS='|' read -r get_status get_type <<< "$get_result"
[ "$get_status" = 200 ] || fail "download returned HTTP $get_status"
[ "${get_type%%;*}" = application/vnd.android.package-archive ] || fail "download content type: $get_type"
actual_bytes=$(wc -c < "$apk" | tr -d '[:space:]')
[ "$actual_bytes" = "$expected_bytes" ] || fail "expected $expected_bytes bytes, got $actual_bytes"

sums_status=$(curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --max-redirs 10 --max-time 60 \
  --output "$work_dir/SHA256SUMS" --write-out '%{http_code}' "$base/SHA256SUMS")
[ "$sums_status" = 200 ] || fail "SHA256SUMS returned HTTP $sums_status"
expected_sha=$(awk '$2=="OpenChat.apk" || $2=="*OpenChat.apk" {print tolower($1)}' "$work_dir/SHA256SUMS")
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'SHA256SUMS must contain exactly one SHA-256 for OpenChat.apk'
if [ "$sha_tool" = sha256sum ]; then
  actual_sha=$(sha256sum "$apk" | awk '{print $1}')
else
  actual_sha=$(shasum -a 256 "$apk" | awk '{print $1}')
fi
[ "$actual_sha" = "$expected_sha" ] || fail 'SHA-256 does not match SHA256SUMS'

unzip -tq "$apk" >/dev/null || fail 'invalid or corrupt ZIP archive'
unzip -Z1 "$apk" > "$work_dir/entries"
grep -Fxq AndroidManifest.xml "$work_dir/entries" || fail 'missing AndroidManifest.xml'
grep -Fxq classes.dex "$work_dir/entries" || fail 'missing classes.dex'

"$aapt_tool" dump badging "$apk" > "$work_dir/badging"
package=$(sed -n "s/^package: name='\\([^']*\\)'.*/\\1/p" "$work_dir/badging")
version=$(sed -n "s/^package: .*versionName='\\([^']*\\)'.*/\\1/p" "$work_dir/badging")
code=$(sed -n "s/^package: .*versionCode='\\([^']*\\)'.*/\\1/p" "$work_dir/badging")
[ "$package" = "$expected_package" ] || fail "package: expected $expected_package, got $package"
[ "$version" = "$expected_version" ] || fail "version: expected $expected_version, got $version"
[ "$code" = "$expected_code" ] || fail "version code: expected $expected_code, got $code"

if command -v apksigner >/dev/null; then
  apksigner verify --verbose --print-certs "$apk" > "$work_dir/signature"
  # Classify certificate records broadly, then validate the complete grammar.
  # Other certificate attributes are allowed only in the known single-signer form.
  signer=$(awk '
    tolower($0) ~ /signer.*certificate/ {
      if ($0 ~ /^Signer #1 certificate DN: /) next
      if ($0 ~ /^Signer #1 certificate SHA-1 digest: [0-9A-Fa-f]+$/ && NF == 6 && length($6) == 40) next
      if ($0 ~ /^Signer #1 certificate MD5 digest: [0-9A-Fa-f]+$/ && NF == 6 && length($6) == 32) next
      count++
      if ($0 !~ /^Signer #1 certificate SHA-256 digest: [0-9A-Fa-f]+$/ || NF != 6 || length($6) != 64) bad = 1
      else digest = tolower($6)
    }
    END { if (bad || count != 1) exit 1; print digest }
  ' "$work_dir/signature") || fail 'Malformed, missing or multiple APK signer certificate records (pinned signer required)'
  [ "$signer" = "$expected_signer" ] || fail 'APK signer does not match the pinned release certificate'
  cat "$work_dir/signature"
  printf 'Signer certificate pin matched: %s\n' "$expected_signer"
else
  echo 'Signature not checked here (apksigner unavailable).'
fi
printf 'Verified: %s\nHTTP: 200\nBytes: %s\nSHA-256: %s\nAPK: AndroidManifest.xml and classes.dex present; ZIP integrity passed\n' "$url" "$actual_bytes" "$actual_sha"
printf 'Package: %s\nVersion: %s (%s)\n' "$package" "$version" "$code"
