#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -f "$1" ]; then
  echo customer_backup_result_log_required >&2
  exit 1
fi

evidence="$1"
expected_release_revision="$2"
if [[ ! "$expected_release_revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo customer_backup_result_expected_release_revision_invalid >&2
  exit 1
fi
prefix="MENDPOINT_CUSTOMER_BACKUP_RESULT "
record_count="$(grep -c "^${prefix}" "$evidence" || true)"
if [ "$record_count" -ne 1 ]; then
  echo customer_backup_result_record_count_invalid >&2
  exit 1
fi

record="$(grep "^${prefix}" "$evidence")"
payload="${record#"$prefix"}"
if ! verified="$(jq -ce '
  type == "object" and
  .schemaVersion == 1 and
  .kind == "customer_backup_result" and
  .result == "success" and
  (.releaseRevision | type == "string" and test("^[a-f0-9]{40}$")) and
  (.backupId | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and
  (.manifestAuthentication | type == "string" and test("^[a-f0-9]{64}$")) and
  (.publication | type == "object") and
  .publication.kind == "s3" and
  .publication.backupId == .backupId and
  (.publication.bucket | type == "string" and length > 0) and
  (.publication.prefix | type == "string" and length > 0) and
  (.publication.endpointOrigin | type == "string" and startswith("https://")) and
  (.publication.commitDigest | type == "string" and test("^[a-f0-9]{64}$")) and
  (.publication.manifestSha256 | type == "string" and test("^[a-f0-9]{64}$"))
' <<< "$payload" 2>/dev/null)"; then
  echo customer_backup_result_invalid >&2
  exit 1
fi

record_release_revision="$(jq -er '.releaseRevision' <<< "$verified")"
if [ "$record_release_revision" != "$expected_release_revision" ]; then
  echo customer_backup_result_release_revision_mismatch >&2
  exit 1
fi

printf '%s\n' "$verified"
