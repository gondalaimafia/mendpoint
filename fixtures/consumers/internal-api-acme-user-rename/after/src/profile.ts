import { fetchUser } from "@acme/user-service";
import { formatDisplayName } from "@acme/format";

export async function loadProfile(id: string): Promise<{ id: string; name: string }> {
  const user = await fetchUser(id);
  return { id, name: formatDisplayName(user) };
}
