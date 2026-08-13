import process from "node:process";

const role = process.argv[2];
if (role !== "coordinator" && role !== "worker") throw new Error("transformer_production_role_invalid");

const { validateTransformerProductionProfile } = await import("../apps/worker/src/transformer-production-profile.ts");
const profile = validateTransformerProductionProfile(process.env, role);

if (role === "coordinator") {
  const [{ createDb }, { ensureTransformerWorkerCredential }] = await Promise.all([
    import("@mendpoint/db"),
    import("../apps/api/src/transformer-worker-bootstrap.ts"),
  ]);
  const db = createDb();
  try {
    ensureTransformerWorkerCredential(db, {
      tenantId: profile.tenantId,
      token: process.env.MENDPOINT_TRANSFORMER_COORDINATOR_TOKEN,
      createdAt: new Date().toISOString(),
    });
  } finally { db.raw.close(); }
  await import("../apps/api/src/server.ts");
} else {
  const { runTransformerServiceCli } = await import("../apps/worker/src/transformer-service-cli.ts");
  const running = await runTransformerServiceCli(process.env);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await running.close();
  };
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  await new Promise((resolve) => process.once("beforeExit", resolve));
}
