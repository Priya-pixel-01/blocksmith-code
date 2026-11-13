import { Fragment } from "react";

/**
 * Renders the small subset of inline markdown agent-written text actually uses (**bold**,
 * `code`) as real React elements — no HTML parsing/injection, just a safe token split. Not a
 * general markdown renderer; block-level formatting (lists, headings) isn't needed here since
 * the Plan schema's prose fields are always a paragraph or two.
 */
export function MarkdownLite({ text }: { text: string }) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);

  return (
    <>
      {tokens.map((token, i) => {
        if (token.startsWith("**") && token.endsWith("**")) {
          return <strong key={i}>{token.slice(2, -2)}</strong>;
        }
        if (token.startsWith("`") && token.endsWith("`")) {
          return (
            <code key={i} style={{ background: "var(--color-bg)", padding: "1px 5px", borderRadius: "4px", fontSize: "0.92em" }}>
              {token.slice(1, -1)}
            </code>
          );
        }
        return <Fragment key={i}>{token}</Fragment>;
      })}
    </>
  );
}
