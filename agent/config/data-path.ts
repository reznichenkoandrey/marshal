import path from "node:path";

/**
 * Resolves agent state (operator data, browser profiles, auth) against
 * MARSHAL_DATA_DIR — userData in a packaged build, where cwd is "/" — or the
 * repo cwd in dev (#206, #233). Absolute paths pass through unchanged, so a
 * relative path from `.env` lands in the same root as the defaults.
 */
export function resolveDataPath(target: string): string {
  return path.resolve(process.env.MARSHAL_DATA_DIR || process.cwd(), target);
}
