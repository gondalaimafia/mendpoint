export function apiClient(key: string) {
  return {
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    } as Record<string, string>,
  };
}
