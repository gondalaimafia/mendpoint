const LOCAL_ORIGIN = "https://mendpoint.invalid";

export function safeLocalReturn(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/console";
  }
  try {
    const parsed = new URL(value, LOCAL_ORIGIN);
    if (
      parsed.origin !== LOCAL_ORIGIN ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith("/")
    ) {
      return "/console";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/console";
  }
}
