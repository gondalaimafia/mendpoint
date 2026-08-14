function timeoutMs(): number {
  const configured = Number(process.env.MENDPOINT_NOTIFY_TIMEOUT_MS ?? 10_000);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : 10_000;
}

function targetUrl(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("notification_url_invalid");
  }
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("notification_url_invalid");
  }
  return target;
}

export async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<Readonly<{ ok: boolean; status: number }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("notification_timeout"), timeoutMs());
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("notification_timeout")),
      { once: true },
    );
  });
  try {
    const response = await Promise.race([
      fetch(targetUrl(url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      }),
      aborted,
    ]);
    return Object.freeze({ ok: response.ok, status: response.status });
  } finally {
    clearTimeout(timer);
  }
}
