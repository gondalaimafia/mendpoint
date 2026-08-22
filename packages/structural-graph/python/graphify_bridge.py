"""Private, bounded stdin/stdout bridge for the pinned Graphify evaluator."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib.metadata
import json
import os
import resource
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


PROTOCOL_VERSION = "mendpoint.graphify-process.v1"
PACKAGE_NAME = "graphifyy"
PACKAGE_VERSION = "0.9.46"
REQUEST_KEYS = {
    "protocolVersion",
    "snapshotId",
    "revision",
    "manifestDigest",
    "sources",
    "limits",
}
SOURCE_KEYS = {"path", "contentDigest", "byteLength", "mode", "kind", "bytesBase64"}
LIMIT_KEYS = {
    "maxFiles",
    "maxInputBytes",
    "maxNodes",
    "maxEdges",
    "maxOutputBytes",
    "maxMemoryBytes",
    "timeoutMs",
    "terminationTimeoutMs",
}
MIN_MEMORY_BYTES = 64 * 1024 * 1024


def fail(message: str) -> None:
    raise ValueError(message)


def exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} has an invalid shape")
    return value


def bounded_int(value: Any, label: str, maximum: int, minimum: int = 1) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        fail(f"{label} is invalid")
    return value


def safe_relative_path(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or not value or len(value) > 4096 or "\\" in value or "\x00" in value:
        fail("source path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("source path escapes the private root")
    return path


def network_namespace() -> str:
    namespace = Path("/proc/self/ns/net")
    if sys.platform != "linux" or not namespace.exists():
        fail("a Linux network namespace is required")
    return os.readlink(namespace)


def deny_network(event: str, _args: tuple[Any, ...]) -> None:
    if event.startswith("socket."):
        raise PermissionError("network access is denied")


def peak_rss_bytes() -> int:
    # Linux reports ru_maxrss in KiB. The bridge refuses non-Linux execution.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def main() -> None:
    parent_network_namespace = os.environ.get("MENDPOINT_GRAPHIFY_PARENT_NETWORK_NAMESPACE", "")
    child_network_namespace = network_namespace()
    if not parent_network_namespace or child_network_namespace == parent_network_namespace:
        fail("Graphify process is not inside a distinct network namespace")

    raw_request = sys.stdin.buffer.read(768 * 1024 * 1024 + 1)
    if len(raw_request) > 768 * 1024 * 1024:
        fail("request exceeds the bridge ceiling")
    request = exact_object(json.loads(raw_request), REQUEST_KEYS, "request")
    if request["protocolVersion"] != PROTOCOL_VERSION:
        fail("protocol version is invalid")
    limits = request["limits"]
    if not isinstance(limits, dict) or not set(limits).issubset(LIMIT_KEYS) or set(limits) < (LIMIT_KEYS - {"terminationTimeoutMs"}):
        fail("limits have an invalid shape")
    max_files = bounded_int(limits["maxFiles"], "maxFiles", 100_000)
    max_input_bytes = bounded_int(limits["maxInputBytes"], "maxInputBytes", 512 * 1024 * 1024)
    max_memory_bytes = bounded_int(limits["maxMemoryBytes"], "maxMemoryBytes", 16 * 1024 * 1024 * 1024)
    max_nodes = bounded_int(limits["maxNodes"], "maxNodes", 10_000_000)
    max_edges = bounded_int(limits["maxEdges"], "maxEdges", 50_000_000)
    max_output_bytes = bounded_int(limits["maxOutputBytes"], "maxOutputBytes", 2 * 1024 * 1024 * 1024)
    bounded_int(limits["timeoutMs"], "timeoutMs", 24 * 60 * 60 * 1000)
    if "terminationTimeoutMs" in limits:
        bounded_int(limits["terminationTimeoutMs"], "terminationTimeoutMs", 60_000)
    if max_memory_bytes < MIN_MEMORY_BYTES:
        fail("maxMemoryBytes cannot admit the pinned runtime")
    sources = request["sources"]
    if not isinstance(sources, list) or not sources or len(sources) > max_files:
        fail("source inventory is invalid")

    # Apply the hard address-space ceiling before loading Graphify or grammars.
    resource.setrlimit(resource.RLIMIT_AS, (max_memory_bytes, max_memory_bytes))
    sys.addaudithook(deny_network)

    source_root = Path(tempfile.mkdtemp(prefix="mendpoint-graphify-source-"))
    cache_root = Path(tempfile.mkdtemp(prefix="mendpoint-graphify-cache-"))
    observed_files: list[dict[str, Any]] = []
    materialized_paths: list[Path] = []
    seen: set[str] = set()
    total_bytes = 0
    try:
        for raw_source in sources:
            source = exact_object(raw_source, SOURCE_KEYS, "source")
            relative = safe_relative_path(source["path"])
            normalized = relative.as_posix()
            if normalized in seen:
                fail("source path is duplicated")
            seen.add(normalized)
            if source["mode"] not in {"100644", "100755"} or source["kind"] != "file":
                fail("source file authority is invalid")
            payload = base64.b64decode(source["bytesBase64"], validate=True)
            byte_length = bounded_int(source["byteLength"], "source byteLength", max_input_bytes, minimum=0)
            content_digest = source["contentDigest"]
            actual_digest = "sha256:" + hashlib.sha256(payload).hexdigest()
            if len(payload) != byte_length or actual_digest != content_digest:
                fail("source bytes do not match their manifest authority")
            total_bytes += len(payload)
            if total_bytes > max_input_bytes:
                fail("source bytes exceed maxInputBytes")
            destination = source_root.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
            destination.chmod(0o500 if source["mode"] == "100755" else 0o400)
            materialized_paths.append(destination)
            observed_files.append({
                "path": normalized,
                "contentDigest": actual_digest,
                "byteLength": len(payload),
                "mode": source["mode"],
                "kind": source["kind"],
            })

        if importlib.metadata.version(PACKAGE_NAME) != PACKAGE_VERSION:
            fail("installed Graphify package version is not pinned")
        from graphify.extract import _DISPATCH, extract

        unsupported = sorted(
            source["path"]
            for source in observed_files
            if Path(source["path"]).suffix not in _DISPATCH
            and Path(source["path"]).suffix.lower() not in _DISPATCH
        )
        if unsupported:
            graphify_result: dict[str, Any] = {"nodes": [], "edges": [], "failed_sources": []}
        else:
            # Graphify progress output is diagnostics, never part of the JSON protocol.
            # The Node supervisor separately bounds stderr and kills noisy children.
            with contextlib.redirect_stdout(sys.stderr):
                graphify_result = extract(
                    materialized_paths,
                    cache_root=cache_root,
                    root=source_root,
                    parallel=False,
                    max_workers=1,
                )
        output = {
            "nodes": graphify_result.get("nodes", []),
            "edges": graphify_result.get("edges", []),
            "failed_sources": graphify_result.get("failed_sources", []),
            "unsupported_languages": unsupported,
            "warnings": [],
        }
        if len(output["nodes"]) > max_nodes or len(output["edges"]) > max_edges:
            fail("Graphify output exceeds its graph ceiling")
        if len(json.dumps(output, separators=(",", ":")).encode("utf-8")) > max_output_bytes:
            fail("Graphify output exceeds its byte ceiling")
        response = {
            "protocolVersion": PROTOCOL_VERSION,
            "packageVersion": PACKAGE_VERSION,
            "resourceCeilingEnforced": True,
            "networkDenied": True,
            "observedFiles": observed_files,
            "peakMemoryBytes": peak_rss_bytes(),
            "output": output,
        }
        sys.stdout.write(json.dumps(response, separators=(",", ":"), sort_keys=True))
    finally:
        shutil.rmtree(source_root, ignore_errors=True)
        shutil.rmtree(cache_root, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"graphify_bridge_failed:{type(error).__name__}\n")
        raise SystemExit(1)
