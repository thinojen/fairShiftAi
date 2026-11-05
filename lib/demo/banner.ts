/** "Isolated sandbox environment" banner text — set only in the Codespaces demo (DEMO_ENV_LABEL). */
export function demoBannerLabel(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.DEMO_ENV_LABEL?.trim();
  return v ? v.slice(0, 120) : null;
}
