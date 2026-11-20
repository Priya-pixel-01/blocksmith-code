import type { OpenQuestion } from "../schemas/question.js";

export const GENERIC_DESTINATION_QUESTION_ID = "generic-component-destination";

export function genericDestinationQuestion(): OpenQuestion {
  return {
    id: GENERIC_DESTINATION_QUESTION_ID,
    prompt: "This repository does not match a supported AEM or EDS structure. Enter the repository-relative parent folder for a standalone HTML/CSS/JavaScript component (for example src/components). Blocksmith will create a new <component-name> folder inside it. Enter . to use the repository root. The files will not be wired into an unknown framework automatically.",
    kind: "text",
    options: [],
    required: true,
  };
}

export function normalizeGenericDestination(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Enter a repository-relative folder, not an absolute path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The destination folder cannot contain empty, '.' or '..' path segments.");
  }
  if (segments.some((segment) => segment === ".git" || segment === "node_modules")) {
    throw new Error("The destination folder cannot be inside .git or node_modules.");
  }
  return segments.join("/");
}
