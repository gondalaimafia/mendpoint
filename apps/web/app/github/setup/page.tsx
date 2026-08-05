import type { Metadata } from "next";
import { GitHubSetupClient } from "./setup-client";

export const metadata: Metadata = {
  title: "GitHub setup | Mendpoint",
  referrer: "no-referrer",
};

export default function GitHubSetupPage() {
  return <GitHubSetupClient />;
}
