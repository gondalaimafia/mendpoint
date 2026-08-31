import { createDb } from "@mendpoint/db";
import { bootstrapScimAuthorities } from "../apps/api/src/scim-bootstrap.js";

const db = createDb();
try {
  bootstrapScimAuthorities(db, process.env);
  console.log("Mendpoint SCIM authority bootstrap validated.");
} finally {
  db.raw.close();
}
