#!/usr/bin/env bash
#
# Does this instance actually work?
#
# Runs against any Open Artifact server, local or live, and exercises the path
# that matters: sign in, publish, view, share, comment, resolve, delete. If this
# passes against a fresh install, the install is good.
#
# It needs one thing a browser would give you and a script cannot: a sign-in
# code, which arrives by email. Give it a way to read one, or let it read the
# server's log when no mail server is configured.
#
#   ./smoke.sh https://artifacts.example.com
#   ./smoke.sh http://127.0.0.1:8080 --code-from-log open-artifact
#
# Exits 0 when everything worked, non-zero on the first thing that did not.

set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
CODE_SOURCE=""
CONTAINER=""
EMAIL="smoke-$(date +%s)@example.invalid"

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --code-from-log) CODE_SOURCE="log"; CONTAINER="${2:-open-artifact}"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mfail\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Every call goes through here so the session cookie is kept and the status is
# always checked. A smoke test that ignores a status code proves nothing.
call() {
  local method="$1" path="$2" expected="$3" body="${4:-}"
  local args=(-sS -o /tmp/smoke-body -w '%{http_code}' -X "$method"
              -b "$JAR" -c "$JAR" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")

  local status
  status="$(curl "${args[@]}" "$BASE_URL$path")" || fail "$method $path could not be reached"
  [ "$status" = "$expected" ] || fail "$method $path answered $status, expected $expected: $(head -c 200 /tmp/smoke-body)"
  cat /tmp/smoke-body
}

# Pulls a value out of a JSON response without needing jq installed.
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

step "Reaching $BASE_URL"
call GET /healthz 200 >/dev/null
pass "the server is up and its database is reachable"

call GET /api/docs 200 >/dev/null
pass "the API describes itself at /api/docs"

step "Signing in as $EMAIL"
call POST /api/auth/code 200 "{\"email\":\"$EMAIL\"}" >/dev/null
pass "a sign-in code was requested"

if [ "$CODE_SOURCE" = "log" ]; then
  sleep 1
  CODE="$(docker logs --tail 200 "$CONTAINER" 2>&1 | grep -oE '[0-9]{3} [0-9]{3}' | tail -1 | tr -d ' ')"
  [ -n "$CODE" ] || fail "no code found in the logs of container '$CONTAINER'"
  pass "read the code out of the server log"
else
  printf '\n  This instance sends real email. Check the inbox for %s\n' "$EMAIL"
  printf '  and type the six digit code: '
  read -r CODE
fi

call POST /api/auth/verify-code 200 "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" >/dev/null
pass "signed in, session cookie held"

ME="$(call GET /api/auth/me 200)"
[ "$(echo "$ME" | field email)" = "$EMAIL" ] || fail "signed in as the wrong person"
pass "the server agrees who we are"

step "Publishing"
ARTIFACT="$(call POST /api/artifacts 201 '{"type":"markdown","content":"# Smoke test\n\nThis line is what the comment attaches to."}')"
ID="$(echo "$ARTIFACT" | field id)"
SLUG="$(echo "$ARTIFACT" | field slug)"
[ -n "$ID" ] && [ -n "$SLUG" ] || fail "publishing returned no id or slug"
pass "published $ID"

CONTENT="$(call GET "/a/$SLUG/content" 200)"
echo "$CONTENT" | grep -q "Smoke test" || fail "the artifact does not serve its own content"
pass "the artifact renders at its URL"

step "Checking the sandbox is on"
HEADERS="$(curl -sS -D - -o /dev/null -b "$JAR" "$BASE_URL/a/$SLUG/content")"
echo "$HEADERS" | grep -qi "sandbox allow-scripts" || fail "content is served without the sandbox directive"
echo "$HEADERS" | grep -qi "connect-src 'none'" || fail "content is served without connect-src none"
pass "artifact content is sandboxed and cannot call out"

step "Sharing"
call POST "/api/artifacts/$ID/sharing/people" 201 '{"email":"colleague@example.invalid"}' >/dev/null
pass "shared with a person"

call PUT "/api/artifacts/$ID/sharing/public" 200 '{"isPublic":true}' >/dev/null
ANON="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/a/$SLUG/content")"
[ "$ANON" = "200" ] || fail "a public artifact is not readable without signing in (got $ANON)"
pass "public means public"

call PUT "/api/artifacts/$ID/sharing/public" 200 '{"isPublic":false}' >/dev/null
ANON="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/a/$SLUG/content")"
[ "$ANON" = "404" ] || fail "a private artifact is still readable without signing in (got $ANON)"
pass "private means private again"

step "Commenting"
THREAD="$(call POST "/api/artifacts/$ID/comments" 201 '{"body":"Is this right?","position":{"snippet":"This line is what the comment attaches to."}}')"
THREAD_ID="$(echo "$THREAD" | field id)"
[ -n "$THREAD_ID" ] || fail "commenting returned no thread"
pass "commented on a passage"

call POST "/api/comments/threads/$THREAD_ID/replies" 201 '{"body":"Yes, checked."}' >/dev/null
pass "replied on the thread"

call PUT "/api/comments/threads/$THREAD_ID/status" 200 '{"status":"resolved"}' >/dev/null
OPEN="$(call GET "/api/artifacts/$ID/comments?status=open" 200)"
echo "$OPEN" | grep -q "Is this right" && fail "a resolved thread still shows as open"
pass "resolved, and no longer listed as open"

step "Republishing, and whether the comment kept its place"
call PUT "/api/artifacts/$ID" 200 '{"content":"# Smoke test\n\nA new opening paragraph.\n\nThis line is what the comment attaches to.","baseVersion":1}' >/dev/null
THREADS="$(call GET "/api/artifacts/$ID/comments" 200)"
echo "$THREADS" | grep -q '"anchorLost":true' && fail "the comment lost its place when it should not have"
pass "the comment survived the document changing around it"

step "Deleting"
call DELETE "/api/artifacts/$ID?confirm=true" 204 >/dev/null
GONE="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE_URL/a/$SLUG/content")"
[ "$GONE" = "404" ] || fail "the artifact is still there after being deleted (got $GONE)"
pass "deleted, and nothing is served at its URL"

printf '\n\033[32mEverything works.\033[0m %s is a good instance.\n\n' "$BASE_URL"
