// The classic false-positive trap: `getUser` is called here, and the target
// module @acme/user-service is imported in this file, but the `getUser` binding
// comes from a DIFFERENT module (@acme/admin-service). Renaming it would corrupt
// an unrelated symbol, so analysis must report this file as out-of-scope and the
// recipe must abstain rather than rename.
import { getUser } from "@acme/admin-service";
import { formatDisplayName } from "@acme/user-service";

export async function loadAdminProfile(id: string): Promise<string> {
  const admin = await getUser(id);
  return formatDisplayName(admin);
}
