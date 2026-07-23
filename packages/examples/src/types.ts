import type { DiffOp } from "@mendpoint/shared";

export type ExampleOp = {
  op: DiffOp | string;
  path?: string;
  method?: string;
  field?: string;
  fromField?: string;
  toField?: string;
  breaking?: boolean;
  detail?: string;
};

export type ChangeEvent = {
  id: string;
  vendor: string;
  surface: string;
  sdkSurface?: string;
  type: "breaking" | "non_breaking" | "new_capability";
  recommended?: boolean;
  adoption?: boolean;
  title: string;
  description: string;
  migration: string;
  docsUrl?: string;
  ops: ExampleOp[];
  searchTokens: string[];
  egraphRules?: string[];
};

export type ExampleManifest = {
  id: string;
  dir: string;
  title: string;
  vendor: string;
  changeType: string;
  consumerPath: string;
  changeEvent: ChangeEvent;
};
