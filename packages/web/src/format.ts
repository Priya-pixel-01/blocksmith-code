/** Formats a per-job/per-batch LLM cost in USD for display, e.g. $0.0034. Null means no usage data was reported. */
export function formatCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
