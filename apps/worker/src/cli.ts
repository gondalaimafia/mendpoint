import { runChangePipeline } from "@mendpoint/pipeline";
import {
  createDb,
  listProviders,
  listVersionsForProvider,
  listFeedPolls,
  findMonorepoRoot,
  claimNextJob,
  completeJob,
  failJob,
  listJobs,
  insertAgentRun,
} from "@mendpoint/db";
import { pollAllFeeds, listCatalogFeeds, probeKnownSdks } from "@mendpoint/catalog";
import { nowIso } from "@mendpoint/shared";
import { runApiBugAgent } from "@mendpoint/agent";

async function demo() {
  const report = await runChangePipeline({ providerSlug: "acme-payments" });
  console.log(JSON.stringify(report, null, 2));
}

async function watch(intervalMs = 30_000) {
  console.log(`Watching for providers with ≥2 versions every ${intervalMs}ms (Ctrl+C to stop)`);
  const db = createDb();
  const seen = new Set<string>();
  for (;;) {
    for (const p of listProviders(db)) {
      const versions = listVersionsForProvider(db, p.id);
      if (versions.length < 2) continue;
      const key = `${p.slug}:${versions.map((v) => v.version_label).join(">")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`Running pipeline for ${p.slug}...`);
      try {
        const report = await runChangePipeline({ providerSlug: p.slug, db });
        console.log(
          `  change ${report.changeId} risk=${report.risk} consumers=${report.consumers.length}`,
        );
      } catch (e) {
        console.error(e);
      }
    }
    await processJobsOnce(db);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function pollFeeds(opts: {
  loop: boolean;
  intervalMs: number;
  localOnly: boolean;
  runPipeline: boolean;
  slugs?: string[];
}) {
  const db = createDb();
  const root = findMonorepoRoot();
  console.log(
    `Feed poll ${opts.loop ? "loop" : "once"} localOnly=${opts.localOnly} pipeline=${opts.runPipeline} root=${root}`,
  );
  console.log(
    `Catalog feeds: ${listCatalogFeeds()
      .map((f) => f.slug)
      .join(", ")}`,
  );

  const run = async () => {
    const results = await pollAllFeeds({
      db,
      monorepoRoot: root,
      localOnly: opts.localOnly,
      runPipeline: opts.runPipeline,
      slugs: opts.slugs,
      pipeline: async (slug, d) => {
        const report = await runChangePipeline({ providerSlug: slug, db: d });
        return { changeId: report.changeId };
      },
    });
    for (const r of results) {
      const extra = r.error ? ` err=${r.error}` : "";
      console.log(
        `  ${r.slug}: ${r.status}${r.versionLabel ? ` v=${r.versionLabel}` : ""}${r.changeId ? ` change=${r.changeId}` : ""}${extra}`,
      );
    }
    // SDK signals alongside OpenAPI
    const signals = await probeKnownSdks({ localOnly: opts.localOnly });
    console.log(
      `  sdk-signals: ${signals.map((s) => `${s.packageName}@${s.latestVersion ?? "?"}`).join(", ")}`,
    );
    return results;
  };

  if (!opts.loop) {
    await run();
    return;
  }

  for (;;) {
    try {
      await run();
      await processJobsOnce(db);
    } catch (e) {
      console.error(e);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

async function processJobsOnce(db = createDb()) {
  let n = 0;
  for (;;) {
    const job = claimNextJob(db, ["pipeline.fanout", "agent.run"]);
    if (!job) break;
    n++;
    try {
      if (job.type === "agent.run") {
        const payload = JSON.parse(job.payload_json) as {
          goal: string;
          repoPath: string;
          verifyCommand?: string;
          errorLog?: string;
          maxSteps?: number;
          dryRun?: boolean;
          useLlm?: boolean;
          allowNetwork?: boolean;
          sessionId?: string;
        };
        console.log(`Job ${job.id} agent.run ${payload.repoPath}`);
        const started = nowIso();
        const result = await runApiBugAgent({
          goal: payload.goal,
          repoRoot: payload.repoPath,
          verifyCommand: payload.verifyCommand,
          errorLog: payload.errorLog,
          maxSteps: payload.maxSteps ?? 20,
          dryRun: payload.dryRun,
          useLlm: payload.useLlm ?? process.env.LLM_AGENT === "1",
          allowNetwork: payload.allowNetwork ?? false,
          sessionId: payload.sessionId,
        });
        insertAgentRun(db, {
          id: result.sessionId,
          goal: payload.goal,
          repoPath: payload.repoPath,
          status: result.ok ? "ok" : "failed",
          ok: result.ok,
          steps: result.steps.length,
          filesChanged: result.filesChanged,
          reportMd: result.reportMarkdown,
          resultJson: JSON.stringify({
            stoppedReason: result.stoppedReason,
            jobId: job.id,
          }),
          createdAt: started,
          finishedAt: nowIso(),
        });
        completeJob(
          db,
          job.id,
          {
            sessionId: result.sessionId,
            ok: result.ok,
            steps: result.steps.length,
            filesChanged: result.filesChanged,
            stoppedReason: result.stoppedReason,
          },
          nowIso(),
        );
        console.log(
          `  agent ${result.ok ? "ok" : "failed"} session=${result.sessionId} steps=${result.steps.length}`,
        );
        continue;
      }

      const payload = JSON.parse(job.payload_json) as {
        providerSlug: string;
        severity?: "required" | "recommended" | "optional";
        notificationsOnly?: boolean;
      };
      console.log(`Job ${job.id} pipeline.fanout ${payload.providerSlug}`);
      const report = await runChangePipeline({
        providerSlug: payload.providerSlug,
        db,
        severity: payload.severity,
        notificationsOnly: payload.notificationsOnly,
      });
      completeJob(db, job.id, { changeId: report.changeId }, nowIso());
      console.log(`  done change=${report.changeId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failJob(db, job.id, msg, nowIso());
      console.error(`  failed: ${msg}`);
    }
  }
  if (!n) console.log("No pending jobs");
  return n;
}

function parseArgs(argv: string[]) {
  const flags = new Set(argv);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    localOnly: flags.has("--local") || process.env.POLL_LOCAL_ONLY === "1",
    noPipeline: flags.has("--no-pipeline"),
    intervalMs: Number(get("--interval") ?? process.env.POLL_INTERVAL_MS ?? 60_000),
    slugs: get("--slug") ? [get("--slug")!] : undefined,
  };
}

const cmd = process.argv[2] ?? "demo";
const rest = process.argv.slice(3);
const args = parseArgs(rest);

if (cmd === "demo") {
  demo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "watch") {
  watch(args.intervalMs).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "poll-once" || cmd === "poll") {
  pollFeeds({
    loop: cmd === "poll",
    intervalMs: args.intervalMs,
    localOnly: args.localOnly || cmd === "poll-once",
    runPipeline: !args.noPipeline,
    slugs: args.slugs,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "feeds") {
  const db = createDb();
  console.log(JSON.stringify({ catalog: listCatalogFeeds(), recent: listFeedPolls(db, 20) }, null, 2));
} else if (cmd === "jobs" || cmd === "process-jobs") {
  processJobsOnce()
    .then((n) => {
      if (cmd === "jobs") {
        console.log(JSON.stringify(listJobs(createDb(), 20), null, 2));
      }
      console.log(`processed=${n}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
} else if (cmd === "sdk-signals") {
  probeKnownSdks({ localOnly: args.localOnly }).then((s) => {
    console.log(JSON.stringify(s, null, 2));
  });
} else {
  console.log(`Usage: worker [demo|watch|poll-once|poll|feeds|jobs|process-jobs|sdk-signals]
  poll-once [--local] [--no-pipeline] [--slug acme-payments]
  poll [--local] [--interval 60000]
  process-jobs   # drain pipeline.fanout + agent.run queue
  sdk-signals [--local]`);
  process.exit(1);
}
