import type { Metadata } from "next";
import { ChangesView } from "../../components/console/changes-view";

export const metadata: Metadata = { title: "Breaking changes" };

export default function ChangesPage() {
  return <ChangesView />;
}
