export function batchTitleFromIntent(
  blockSpec: unknown,
  _decision?: unknown,
): string {
  const spec = blockSpec as { intent?: unknown; purpose?: unknown } | null;
  const source = [spec?.intent, spec?.purpose].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!source) return "Untitled batch";

  const firstSentence = source.trim().split(/[.!?](?:\s|$)/, 1)[0]!.trim();
  const subject = firstSentence
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/\s+(component|block)\s+(displaying|showing|for|to)\b.*$/i, "")
    .replace(/\s+(displaying|showing|that|which|to)\b.*$/i, "")
    .trim();

  const words = subject.split(/\s+/).filter(Boolean);
  const title = words
    .map((word) => (/^\d/.test(word) || /^[A-Z\d-]+$/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");

  return title ? `${title}` : "Untitled batch";
}