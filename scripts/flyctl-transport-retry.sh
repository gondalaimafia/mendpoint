# shellcheck shell=bash
# Bounded, transport-only retry for flyctl / Fly Machines API calls.
#
# Why this exists: the scheduled sandbox egress renewal
# (.github/workflows/sandbox-egress-renewal.yml -> sandbox-egress-acceptance.yml)
# runs a chain of flyctl calls against the Machines API. A single transient
# transport blip on one of them -- run 36060414788 hit
#   Error: could not get machine <id>: failed to get VM <id>: Get "...": read tcp
#   ...->137.66.34.115:443: read: connection reset by peer
# on `flyctl machine status` -- fails the whole renewal with no retry. The
# receipt lives <24h and renewals run every 6h, so two blips in a row leave
# workers crash-looping (alert #708). PR #714 added retries for the protected-app
# ssh install; the read/create/destroy calls in the probe and rotation steps were
# not covered. This is that coverage.
#
# HARD RULE -- this is a containment probe, so retries are dangerous if misused:
#   * Only NON-verdict calls are ever routed through here (reads, the probe
#     machine create, the probe machine destroy, cleanup). A verdict-bearing
#     `flyctl machine exec` probe and every jq assertion on its output are NEVER
#     retried: the verdict of a probe that actually ran is final. Retrying must
#     never turn an observed egress success (default-deny violated), a wrong
#     probe exit status, or a failed assertion into a pass.
#   * Only a TRANSPORT-level failure is retried: connection reset, TLS handshake
#     timeout, i/o timeout, EOF, or a 5xx from the API. The class is read from
#     flyctl's FINAL `Error:` line ONLY, never the whole log -- the
#     forbidden-egress probe workload literally prints rejection text, and a
#     build/exec log can contain "connection reset" without the API call having
#     failed. The last `Error:` line is read from a file with no `printf | grep`
#     pipe, so there is no SIGPIPE under `pipefail` (the rotation-028 pattern;
#     see ci.yml "Build and push customer production image").
#   * The `failed to get VM <id>` prefix is DELIBERATELY not a signal. fly-go
#     wraps every `flaps.Get` error in it -- including `machine not found` and
#     `unauthorized` -- and `machine destroy` calls Get first, so matching it
#     would retry real not-found and revoked-token errors as transport blips.
#     The #708 line (`... failed to get VM X: Get "...": read tcp ...: read:
#     connection reset by peer`) still classifies through `read tcp` and
#     `connection reset`, so nothing is lost.
#   * A non-transport failure (auth, not found, invalid config, a real assertion)
#     is returned immediately with flyctl's own exit status -- no retry.
#
# Bound: at most 3 attempts, short linear backoff. FLY_RETRY_BACKOFF_SECONDS
# overrides the per-attempt delay (default 5s; set to 0 in tests) and NEVER
# changes the retry decision, so shipped behaviour is identical with or without a
# real sleep.

# The transport-signal alternation, matched case-insensitively against a single
# `Error:` line. Kept as one string so the probe and rotation steps classify
# identically. `\bEOF\b` avoids matching substrings inside longer tokens.
FLY_TRANSPORT_SIGNAL='connection reset|TLS handshake timeout|i/o timeout|\bEOF\b|read tcp|5[0-9][0-9] (Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error)'

# Echo the LAST line beginning with "Error:" from the file named by $1. Reading
# from the file (not a pipe) keeps the classification off flyctl's whole log and
# takes no SIGPIPE under `pipefail` on a large log.
fly_transport_error_line() {
  local file="$1" line last=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      Error:*) last="$line" ;;
    esac
  done <"$file"
  printf '%s' "$last"
}

# Return 0 iff the FINAL `Error:` line found across the given files (checked in
# order, first non-empty wins) is a transport-class failure. Verdict text is
# never inspected because verdict-bearing calls are never passed here.
fly_is_transport_failure() {
  local file error_line=""
  for file in "$@"; do
    error_line="$(fly_transport_error_line "$file")"
    if [ -n "$error_line" ]; then
      break
    fi
  done
  grep -qiE "$FLY_TRANSPORT_SIGNAL" <<<"$error_line"
}

# fly_retry LABEL -- <cmd...>
# Runs a NON-verdict command, retrying ONLY transport-class failures up to 3
# attempts. The command's stdout is left in the global FLY_RETRY_STDOUT (clean,
# with stderr kept separate so captured JSON is never corrupted by flyctl's
# progress output); stderr is streamed to the caller's stderr. Returns 0 on
# success, otherwise flyctl's own final exit status.
fly_retry() {
  local label="$1"
  shift
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  local max=3 attempt=1 status
  local backoff="${FLY_RETRY_BACKOFF_SECONDS:-5}"
  local out_file err_file
  out_file="$(mktemp)"
  err_file="$(mktemp)"
  FLY_RETRY_STDOUT=""
  while :; do
    set +e
    "$@" >"$out_file" 2>"$err_file"
    status=$?
    set -e
    cat "$err_file" >&2
    if [ "$status" -eq 0 ]; then
      FLY_RETRY_STDOUT="$(cat "$out_file")"
      rm -f "$out_file" "$err_file"
      return 0
    fi
    if ! fly_is_transport_failure "$err_file" "$out_file"; then
      echo "fly_retry ${label}: non-transport flyctl error (exit ${status}); not retrying." >&2
      FLY_RETRY_STDOUT="$(cat "$out_file")"
      rm -f "$out_file" "$err_file"
      return "$status"
    fi
    if [ "$attempt" -ge "$max" ]; then
      echo "fly_retry ${label}: transport error persisted after ${max} attempts; failing loudly." >&2
      FLY_RETRY_STDOUT="$(cat "$out_file")"
      rm -f "$out_file" "$err_file"
      return "$status"
    fi
    echo "fly_retry ${label}: transient transport blip on attempt ${attempt} of ${max} (exit ${status}); retrying after a short backoff." >&2
    sleep "$((attempt * backoff))"
    attempt=$((attempt + 1))
  done
}
