import type { Metadata } from "next";
import { TransformerWorkspace } from "./workspace";

export const metadata: Metadata = {
  title: "Transformer experimental workspace",
  description: "Human reviewed migration campaign planning and outcome evidence.",
};

export default function TransformerPage() {
  return <TransformerWorkspace />;
}
