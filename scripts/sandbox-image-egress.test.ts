import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("sandbox image default-deny egress", () => {
  it("installs a fail-closed IPv4 and IPv6 policy before the node workload", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile.sandbox"), "utf8");
    const entrypoint = readFileSync(resolve(root, "scripts/start-sandbox-entrypoint.sh"), "utf8");
    const flyManifest = readFileSync(resolve(root, "fly.sandbox.toml"), "utf8");
    const builder = readFileSync(resolve(root, "scripts/build-sandbox-image.mjs"), "utf8");
    const workflow = readFileSync(
      resolve(root, ".github/workflows/sandbox-egress-acceptance.yml"),
      "utf8",
    );

    expect(dockerfile).toContain("iptables");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/mendpoint-sandbox-entrypoint"]');
    expect(dockerfile).not.toMatch(/^USER node$/mu);
    expect(entrypoint).toContain("iptables --wait -P OUTPUT DROP");
    expect(entrypoint).toContain("ip6tables --wait -P OUTPUT DROP");
    expect(entrypoint).toContain("iptables --wait -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited");
    expect(entrypoint).toContain("ip6tables --wait -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited");
    expect(entrypoint).not.toContain("|| true");
    expect(entrypoint.indexOf("-P OUTPUT DROP")).toBeLessThan(entrypoint.indexOf("exec /usr/sbin/runuser"));
    expect(flyManifest).toContain('app = "mendpoint-sandbox"');
    expect(flyManifest).toContain('dockerfile = "Dockerfile.sandbox"');
    expect(flyManifest).not.toContain("http_service");
    expect(builder).toContain('"scripts/start-sandbox-entrypoint.sh"');
    expect(workflow).toContain("environment: sandbox-production");
    expect(workflow).toContain("trap 'cleanup || true' EXIT");
    expect(workflow).toContain("trap - EXIT");
    expect(workflow).toContain("sandbox_machine_not_destroyed");
    expect(workflow).toContain("all(.[]; .id != $id)");
    expect(workflow).toContain("expected_digest=");
    expect(workflow).toContain(
      '.stdout == \"mendpoint-egress-blocked\\nmendpoint-exec-ok\\n\"',
    );
    expect(workflow).toContain("SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND");
    expect(workflow).not.toContain("fetch(process.argv[1])");
    expect(workflow).not.toContain(".exit_code // 0");
    expect(workflow).not.toContain('has(\"exit_code\") and (.exit_code == 0)');
    expect(workflow).toContain("iptables -S OUTPUT && echo mendpoint-exec-ok");
    expect(workflow).toContain("ip6tables -S OUTPUT && echo mendpoint-exec-ok");
    expect(workflow).toContain("$allowed_probe && echo mendpoint-exec-ok");
    expect(workflow).toContain("$forbidden_probe && echo mendpoint-exec-ok");
    expect(workflow).toContain('((has(\"exit_code\") | not) or (.exit_code == 0))');
    expect(workflow).toContain('( .stderr // \"\" ) == \"\"');
    expect(workflow.match(/mendpoint-exec-ok/g)?.length).toBeGreaterThanOrEqual(8);
    expect(workflow).toContain("MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64");
    expect(workflow).toContain("MENDPOINT_SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA");
    expect(workflow).not.toContain("continue-on-error");
  });
});
