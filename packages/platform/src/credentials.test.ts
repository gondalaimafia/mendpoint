import { describe, expect, it, vi } from "vitest";
import {
  CredentialAccessError,
  CredentialBroker,
  EnvSecretProvider,
  MemorySecretProvider,
  type CredentialAccessAuditEvent,
  type CredentialDescriptor,
  type MemorySecretReference,
} from "./credentials.js";

const now = new Date("2026-08-01T12:00:00.000Z");

function descriptor(
  overrides: Partial<CredentialDescriptor> = {},
): CredentialDescriptor {
  return {
    credentialId: "credential-1",
    secret: { provider: "memory", id: "github-token", version: "2" },
    audiences: ["github-api"],
    expiresAt: "2026-08-02T12:00:00.000Z",
    rotation: {
      generation: 2,
      issuedAt: "2026-07-01T12:00:00.000Z",
      rotatedAt: "2026-07-15T12:00:00.000Z",
      rotateAfter: "2026-07-31T12:00:00.000Z",
      supersedesCredentialId: "credential-0",
    },
    ...overrides,
  };
}

function request(audience = "github-api") {
  return {
    actorId: "service:worker-1",
    audience,
    purpose: "open migration pull request",
    requestId: "request-1",
    at: now,
  };
}

async function expectAccessError(
  promise: Promise<unknown>,
  code: CredentialAccessError["code"],
) {
  await expect(promise).rejects.toMatchObject({
    name: "CredentialAccessError",
    code,
  });
}

describe("credential lifecycle", () => {
  it("resolves environment references for the intended audience and audits metadata only", async () => {
    const events: CredentialAccessAuditEvent[] = [];
    const secretValue = "environment-secret-value";
    const broker = new CredentialBroker({
      providers: [new EnvSecretProvider({ MENDPOINT_TEST_TOKEN: secretValue })],
      audit: (event) => {
        events.push(event);
      },
      now: () => now,
    });
    const credential = descriptor({
      secret: {
        provider: "env",
        id: "MENDPOINT_TEST_TOKEN",
        version: "2026-08",
      },
    });

    const resolved = await broker.access(credential, request());

    expect(resolved.secret.reveal()).toBe(secretValue);
    expect(String(resolved.secret)).toBe("[REDACTED]");
    expect(JSON.stringify(resolved)).not.toContain(secretValue);
    expect(resolved.rotation).toEqual({
      generation: 2,
      due: true,
      rotateAfter: "2026-07-31T12:00:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      credentialId: "credential-1",
      actorId: "service:worker-1",
      audience: "github-api",
      outcome: "granted",
      reason: "granted",
      rotation: { generation: 2, due: true },
    });
    expect(JSON.stringify(events)).not.toContain(secretValue);
  });

  it("uses a volatile memory provider without exposing its stored values", async () => {
    const reference: MemorySecretReference = {
      provider: "memory",
      id: "token",
    };
    const provider = new MemorySecretProvider();
    provider.put(reference, "memory-secret-value");
    const audit = vi.fn();
    const broker = new CredentialBroker({
      providers: [provider],
      audit,
      now: () => now,
    });

    const resolved = await broker.access(
      descriptor({ secret: reference }),
      request(),
    );
    expect(resolved.secret.reveal()).toBe("memory-secret-value");
    expect(JSON.stringify(resolved.secret)).toBe('"[REDACTED]"');
    expect(audit).toHaveBeenCalledOnce();

    provider.remove(reference);
    await expectAccessError(
      broker.access(descriptor({ secret: reference }), request()),
      "secret_not_found",
    );
  });

  it("denies the wrong audience before reading secret material", async () => {
    const provider = new MemorySecretProvider({ "github-token": "secret" });
    const read = vi.spyOn(provider, "read");
    const events: CredentialAccessAuditEvent[] = [];
    const broker = new CredentialBroker({
      providers: [provider],
      audit: (event) => {
        events.push(event);
      },
      now: () => now,
    });

    await expectAccessError(
      broker.access(descriptor(), request("billing-api")),
      "audience_denied",
    );
    expect(read).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      outcome: "denied",
      reason: "audience_denied",
    });
  });

  it("fails closed for expired, revoked, and invalid lifecycle metadata", async () => {
    const events: CredentialAccessAuditEvent[] = [];
    const broker = new CredentialBroker({
      providers: [new MemorySecretProvider({ "github-token": "secret" })],
      audit: (event) => {
        events.push(event);
      },
      now: () => now,
    });

    await expectAccessError(
      broker.access(
        descriptor({ expiresAt: "2026-08-01T12:00:00.000Z" }),
        request(),
      ),
      "expired",
    );
    await expectAccessError(
      broker.access(
        descriptor({
          revocation: {
            revokedAt: "2026-07-20T12:00:00.000Z",
            reason: "operator revoked",
          },
        }),
        request(),
      ),
      "revoked",
    );
    await expectAccessError(
      broker.access(
        descriptor({ rotation: { generation: 0, issuedAt: "not-a-date" } }),
        request(),
      ),
      "invalid_metadata",
    );
    expect(events.map((event) => event.reason)).toEqual([
      "expired",
      "revoked",
      "invalid_metadata",
    ]);
  });

  it("does not return secret material when the access audit fails", async () => {
    const broker = new CredentialBroker({
      providers: [new MemorySecretProvider({ "github-token": "secret" })],
      audit: () => {
        throw new Error("audit unavailable");
      },
      now: () => now,
    });

    await expectAccessError(broker.access(descriptor(), request()), "audit_failed");
  });

  it("sanitizes provider failures and audits the denial", async () => {
    const events: CredentialAccessAuditEvent[] = [];
    const broker = new CredentialBroker({
      providers: [
        {
          provider: "memory",
          read: async () => {
            throw new Error("provider error containing secret-value");
          },
        },
      ],
      audit: (event) => {
        events.push(event);
      },
      now: () => now,
    });

    const access = broker.access(descriptor(), request());
    await expectAccessError(access, "provider_error");
    await expect(access).rejects.not.toThrow(/secret-value/);
    expect(events.at(-1)?.reason).toBe("provider_error");
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });
});
