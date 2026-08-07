import { validateApiEnv } from "@mendpoint/ops";

const report = validateApiEnv(process.env);
if (!report.ok) {
  console.error(JSON.stringify({
    error: "runtime_environment_invalid",
    errors: report.errors,
  }));
  process.exit(1);
}
