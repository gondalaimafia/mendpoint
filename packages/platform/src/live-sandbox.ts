/**
 * Live-service sandbox — local HTTP mock upstream for Warden contract tests.
 * Spins a tiny Node HTTP server with fixture routes; curl-able from agent sandbox.
 */
import { createServer, type Server, request as httpRequest } from "node:http";
import { createSandbox, type SandboxHandle } from "./sandbox.js";

export type LiveRoute = {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type LiveCurlResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
};

export type LiveSandbox = {
  baseUrl: string;
  port: number;
  sandbox: SandboxHandle;
  routes: LiveRoute[];
  dispose: () => void;
  /** HTTP probe against the mock upstream (async) */
  curl: (
    path: string,
    opts?: { method?: string; body?: string },
  ) => Promise<LiveCurlResult>;
};

export async function startLiveSandbox(opts?: {
  routes?: LiveRoute[];
  prefix?: string;
}): Promise<LiveSandbox> {
  const routes: LiveRoute[] = opts?.routes ?? [
    {
      method: "GET",
      path: "/health",
      status: 200,
      body: { ok: true, service: "live-sandbox" },
    },
    {
      method: "GET",
      path: "/v1/charges",
      status: 200,
      body: { data: [{ id: "ch_1", amount: 100 }] },
    },
    {
      method: "POST",
      path: "/v1/charges",
      status: 201,
      body: { id: "ch_new", amount: 100 },
    },
  ];

  const server: Server = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url?.split("?")[0] ?? "/";
    const hit = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        (r.path === url || r.path === "*"),
    );
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", path: url }));
      return;
    }
    const headers = {
      "content-type": "application/json",
      ...(hit.headers ?? {}),
    };
    res.writeHead(hit.status ?? 200, headers);
    res.end(
      typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body ?? {}),
    );
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const sandbox = createSandbox({
    prefix: opts?.prefix ?? "live-sbx-",
    serviceBaseUrl: baseUrl,
    mocks: routes.map((r) => ({
      name: `${r.method ?? "GET"} ${r.path}`,
      baseUrl,
    })),
    files: {
      "live.json": JSON.stringify({ baseUrl, routes }, null, 2),
    },
  });

  return {
    baseUrl,
    port,
    sandbox,
    routes,
    dispose: () => {
      try {
        server.close();
      } catch {
        /* */
      }
      sandbox.dispose();
    },
    curl: (path, o) =>
      new Promise<LiveCurlResult>((resolve) => {
        const method = (o?.method ?? "GET").toUpperCase();
        const url = new URL(
          `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
        );
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: { "content-type": "application/json" },
            timeout: 5000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              const status = res.statusCode ?? 0;
              resolve({
                ok: status >= 200 && status < 300,
                status,
                stdout: `${status} ${body}`.slice(0, 8000),
                stderr: "",
              });
            });
          },
        );
        req.on("error", (e) => {
          resolve({
            ok: false,
            status: 0,
            stdout: "",
            stderr: String(e.message ?? e),
          });
        });
        req.on("timeout", () => {
          req.destroy();
          resolve({
            ok: false,
            status: 0,
            stdout: "",
            stderr: "timeout",
          });
        });
        if (o?.body) req.write(o.body);
        req.end();
      }),
  };
}
