import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { AemImplementationMode, OpenQuestion } from "../schemas/question.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

function slug(value: string, index: number): string {
  return `question-${index + 1}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "detail"}`;
}

export function requiresAemImplementationMode(projectType: string): boolean {
  return projectType === "aem" || projectType === "mixed";
}

export function questionsForAemSpec(spec: AemComponentSpec): OpenQuestion[] {
  return questionsFromPrompts(spec.openQuestions);
}

export function questionsFromPrompts(prompts: string[]): OpenQuestion[] {
  return prompts.map((prompt, index) => {
    const normalized = prompt.toLowerCase();
    if (/variant|style variant|new component/.test(normalized)) {
      return {
        id: slug(prompt, index), prompt, kind: "single_choice" as const,
        options: [
          { value: "new_component", label: "Create a separate component" },
          { value: "variant", label: "Add a style/behavior variant" },
          { value: "extend", label: "Extend the existing component" },
        ], required: true,
      };
    }
    if (/icon/.test(normalized) && /(svg|font|image|implement|approach|source)/.test(normalized)) {
      return {
        id: slug(prompt, index), prompt, kind: "single_choice" as const,
        options: [
          { value: "svg", label: "Inline or local SVG" },
          { value: "icon_font", label: "Existing icon font" },
          { value: "image_asset", label: "Image asset" },
        ], required: true,
      };
    }
    if (/inherit|supertype/.test(normalized) && /(independent|inherit|extend)/.test(normalized)) {
      return {
        id: slug(prompt, index), prompt, kind: "single_choice" as const,
        options: [
          { value: "inherit", label: "Inherit from the existing component" },
          { value: "independent", label: "Keep it independent" },
        ], required: true,
      };
    }
    const hasDestinationChoices = /internal/i.test(prompt) && /external/i.test(prompt);
    const hasIconPositionChoices = /icon/.test(normalized) && /(position|left|right|top|bottom)/.test(normalized);
    const hasDialogChoices = /dialog/.test(normalized) && /(mirror|streamline|scope|configuration)/.test(normalized);
    const hasMobileChoices = /(mobile|breakpoint|responsive)/.test(normalized) && /(full.?width|pill|adapt|behavior|behaviour)/.test(normalized);
    const isBinary = !hasDestinationChoices && !hasIconPositionChoices && !hasDialogChoices && !hasMobileChoices && /^(should|does|do|is|are|can|will)\b/i.test(prompt.trim());
    const options = hasDestinationChoices
      ? [{ value: "internal", label: "Internal links only" }, { value: "external", label: "External links only" }, { value: "both", label: "Both" }]
      : hasIconPositionChoices
        ? [{ value: "right", label: "Right" }, { value: "left", label: "Left" }, { value: "configurable", label: "Author configurable" }]
        : hasDialogChoices
          ? [{ value: "mirror", label: "Mirror the base dialog" }, { value: "streamlined", label: "Use a streamlined dialog" }, { value: "custom", label: "Use custom fields" }]
          : hasMobileChoices
            ? [{ value: "full_width", label: "Full width on mobile" }, { value: "compact", label: "Keep a compact pill" }, { value: "same", label: "Keep desktop sizing" }]
            : isBinary ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "unspecified", label: "Not specified" }] : [];
    return {
      id: slug(prompt, index),
      prompt,
      kind: options.length > 0 ? "single_choice" as const : "text" as const,
      options,
      required: true,
    };
  });
}

export function questionsForBlockSpec(spec: BlockSpec): OpenQuestion[] {
  return spec.openQuestions.map((prompt, index) => ({ id: slug(prompt, index), prompt, kind: "text", options: [], required: true }));
}

export function formatAnswers(questions: OpenQuestion[], answers: Array<{ questionId: string; value: string }>): string {
  const labels = new Map(questions.map((question) => [question.id, question.prompt]));
  return answers.map((answer) => `- ${labels.get(answer.questionId) ?? answer.questionId}: ${answer.value}`).join("\n");
}

function pascalCase(value: string): string {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

function slingModelPaths(profile: RepoProfile, componentName: string): { model: string; files: string[] } {
  const coreModule = profile.modules.find((module) => module.kind === "backend" && module.path !== "all" && module.path !== "ui.apps.structure")?.path ?? "core";
  const javaPrefix = `${coreModule}/src/main/java/`;
  const existingJava = profile.aemArtifacts.find((artifact) => artifact.kind === "java" && artifact.path.startsWith(javaPrefix))?.path;
  const existingDirectory = existingJava ? existingJava.slice(0, existingJava.lastIndexOf("/")) : "";
  const existingModelsDirectory = existingDirectory.includes("/models")
    ? existingDirectory.slice(0, existingDirectory.indexOf("/models") + "/models".length)
    : existingDirectory ? `${existingDirectory}/models` : `${javaPrefix}com/adobe/aem/guides/wknd/core/models`;
  const packageName = existingModelsDirectory.startsWith(javaPrefix) ? existingModelsDirectory.slice(javaPrefix.length).replaceAll("/", ".") : "";
  const modelName = `${pascalCase(componentName)}Model`;
  const modelPath = `${existingModelsDirectory}/${modelName}.java`;
  const implementationPath = `${existingModelsDirectory}/impl/${modelName}Impl.java`;
  return { model: packageName ? `${packageName}.${modelName}` : modelName, files: [modelPath, implementationPath] };
}

export function applyAemImplementationMode(spec: AemComponentSpec, mode: AemImplementationMode, profile: RepoProfile): AemComponentSpec {
  if (mode === "properties") {
    return {
      ...spec,
      requiredModules: spec.requiredModules.filter((module) => !/^(core|backend)$/i.test(module)),
      implementation: { ...spec.implementation, slingModel: null, backend: [] },
    };
  }
  const model = slingModelPaths(profile, spec.name);
  const existingBackend = spec.implementation.backend;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      slingModel: spec.implementation.slingModel ?? model.model,
      backend: existingBackend.length > 0 ? existingBackend : model.files,
    },
  };
}
