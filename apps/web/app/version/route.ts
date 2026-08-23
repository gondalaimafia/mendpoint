export const dynamic = "force-dynamic";

/**
 * Public release-revision probe. Reports the immutable git revision the running
 * web process booted with (MENDPOINT_RELEASE_REVISION, stamped onto the app by
 * the deploy). The CI deploy reads this over HTTP to assert that main's head is
 * what is actually serving. When the revision is unset the field is null, never
 * a fabricated value, so "unknown" can never be mistaken for "matches".
 */
export async function GET(): Promise<Response> {
  const revision = process.env.MENDPOINT_RELEASE_REVISION?.trim() || null;
  return Response.json(
    { service: "mendpoint", revision },
    { headers: { "Cache-Control": "no-store" } },
  );
}
