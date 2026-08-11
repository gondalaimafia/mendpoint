import * as googleapis from "googleapis";

// Namespace import is outside the recipe's default-import surface. Analysis must
// report this file as out-of-scope and abstain rather than producing a wrong
// edit.
export function drive(auth) {
  return googleapis.google.drive({ version: "v3", auth });
}
