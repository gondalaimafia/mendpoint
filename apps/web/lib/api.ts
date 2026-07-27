const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function apiBase(): string {
  return API_URL;
}

const DEFAULT_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: init?.cache ?? "no-store",
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`API timeout after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(`${API_URL}${path}`, undefined, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(
    `${API_URL}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export type Provider = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  createdAt: string;
};

export type ApiChange = {
  id: string;
  providerId: string;
  risk: string;
  summary: string;
  createdAt: string;
};

export type MigrationPr = {
  id: string;
  changeId: string;
  consumerId: string;
  title: string;
  body: string;
  branchName: string;
  status: string;
  risk: string;
  patchUnified: string;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  createdAt: string;
};

export type Consumer = {
  id: string;
  name: string;
  githubOwner: string;
  githubRepo: string;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
};
