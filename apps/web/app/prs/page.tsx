import type { Metadata } from "next";
import { ConsoleShell } from "../components/console/console-shell";
import { PrsView } from "../components/console/prs-view";
import { PULL_REQUESTS } from "../components/console/fixtures";

export const metadata: Metadata = { title: "Pull requests" };

export default function PullRequestsPage() {
  return (
    <ConsoleShell view="prs">
      <PrsView prs={PULL_REQUESTS} />
    </ConsoleShell>
  );
}
