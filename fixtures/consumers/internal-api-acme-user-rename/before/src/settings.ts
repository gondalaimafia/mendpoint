import { getUser, updateSettings } from "@acme/user-service";

export async function applySettings(
  id: string,
  prefs: Record<string, unknown>,
): Promise<boolean> {
  const user = getUser(id);
  if (!user) return false;
  return updateSettings(user, prefs);
}
