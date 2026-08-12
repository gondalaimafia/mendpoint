import type { Metadata } from "next";
import { ConsoleShell } from "../components/console/console-shell";
import { ChangesView } from "../components/console/changes-view";

export const metadata: Metadata = { title: "Breaking changes" };

export default function ChangesPage() {
  return (
    <ConsoleShell view="changes">
      <ChangesView />
    </ConsoleShell>
  );
}
