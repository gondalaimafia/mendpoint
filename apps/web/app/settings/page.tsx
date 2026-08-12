import type { Metadata } from "next";
import { ConsoleShell } from "../components/console/console-shell";
import { SettingsView } from "../components/console/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <ConsoleShell view="settings">
      <SettingsView />
    </ConsoleShell>
  );
}
