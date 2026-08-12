// Same false-positive trap as profile.ts: the target module @acme/user-service
// is present (updateSettings), but `getUser` is bound to @acme/admin-service, so
// the recipe abstains instead of renaming an unrelated binding.
import { getUser } from "@acme/admin-service";
import { updateSettings } from "@acme/user-service";

export async function applyAdminSettings(
  id: string,
  prefs: Record<string, unknown>,
): Promise<boolean> {
  const admin = getUser(id);
  if (!admin) return false;
  return updateSettings(admin, prefs);
}
