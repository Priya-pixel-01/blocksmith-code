import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AemArtifact, AemComponent, AemModule, RepositoryRelationship } from "../../schemas/aem-profile.js";

export const AEM_PROFILE_VERSION = "3";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "target" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

function moduleKind(name: string, files: string[]): AemModule["kind"] {
  const value = name.toLowerCase();
  if (value === "core") return "backend";
  if (value.includes("apps")) return "application";
  if (value.includes("content")) return "content";
  if (value.includes("dispatcher")) return "dispatcher";
  if (value.includes("test")) return "test";
  if (value.includes("frontend") || files.some((file) => /(^|[\\/])src[\\/]main[\\/]webpack[\\/]/.test(file))) return "frontend";
  if (files.some((file) => file.endsWith(".java"))) return "backend";
  return "other";
}

function discoverModules(root: string): AemModule[] {
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
  return candidates.flatMap((name) => {
    const moduleRoot = join(root, name);
    const files = filesUnder(moduleRoot);
    const buildFiles = files.filter((file) => /(^|[\\/])(pom\.xml|package\.json)$/.test(file)).map((file) => relative(root, file).replaceAll("\\", "/"));
    if (buildFiles.length === 0) return [];
    const sourceRoots = files.filter((file) => /(^|[\\/])src[\\/]main[\\/]/.test(file)).map((file) => relative(root, file).replaceAll("\\", "/"));
    const testRoots = files.filter((file) => /(^|[\\/])src[\\/]test[\\/]/.test(file)).map((file) => relative(root, file).replaceAll("\\", "/"));
    const dependencies = files.filter((file) => file.endsWith("pom.xml")).flatMap((file) => [...readText(file).matchAll(/<artifactId>\s*([^<]+)\s*<\/artifactId>/g)].map((match) => match[1] ?? "")).filter((dependency) => dependency !== name);
    return [{ id: name, path: name, kind: moduleKind(name, files), buildFiles, sourceRoots, testRoots, dependencies: [...new Set(dependencies)].sort() }];
  });
}

function artifactKind(path: string): AemArtifact["kind"] {
  if (path.endsWith(".html")) return "htl";
  if (path.includes("_cq_dialog")) return "dialog";
  if (path.endsWith(".content.xml")) return "content-definition";
  if (path.includes("clientlib") || path.includes("clientlibs")) return "clientlib";
  if (path.endsWith(".java")) return "java";
  if (path.includes("/config/") || path.includes("\\config\\")) return "osgi-config";
  return "other";
}

function componentForPath(root: string, path: string): { id: string; name: string; path: string; resourceType: string | null } | null {
  const normalized = relative(root, path).replaceAll("\\", "/");
  if (/(?:^|\/)src\/main\/webpack\/components\//.test(normalized)) return null;
  const marker = normalized.indexOf("/components/");
  if (marker < 0) return null;
  const componentPath = normalized.slice(0, marker + "/components/".length) + normalized.slice(marker + "/components/".length).split("/")[0];
  const name = componentPath.split("/").at(-1);
  if (!name) return null;
  const metadata = filesUnder(join(root, componentPath)).find((file) => file.endsWith(".content.xml"));
  const declaredResourceType = metadata ? readText(metadata).match(/sling:resourceType\s*=\s*["']([^"']+)/)?.[1] ?? null : null;
  const appPath = normalized.match(/(?:^|\/)apps\/([^/]+)\/components\/(.+)$/);
  const appName = appPath?.[1];
  const componentName = appPath?.[2]?.split("/")[0];
  const resourceType = declaredResourceType ?? (appName && componentName ? `${appName}/components/${componentName}` : null);
  return { id: componentPath, name, path: componentPath, resourceType };
}

export interface AemExtraction {
  modules: AemModule[];
  artifacts: AemArtifact[];
  components: AemComponent[];
  relationships: RepositoryRelationship[];
}

export function extractAemRepository(root: string): AemExtraction {
  const modules = discoverModules(root);
  const allFiles = filesUnder(root);
  const artifacts = allFiles
    .filter((file) => /\.html$|\.content\.xml$|\.java$|clientlib|[\\/]config[\\/]/.test(file))
    .map((file) => ({ kind: artifactKind(file), path: relative(root, file).replaceAll("\\", "/"), componentId: componentForPath(root, file)?.id ?? null }));
  const componentMap = new Map<string, AemComponent>();
  for (const file of allFiles) {
    const component = componentForPath(root, file);
    if (!component) continue;
    const componentArtifacts = artifacts.filter((artifact) => artifact.componentId === component.id).map((artifact) => artifact.path);
    const componentFiles = filesUnder(join(root, component.path));
    const relativeComponentFiles = componentFiles.map((file) => relative(root, file).replaceAll("\\", "/"));
    const dialogPaths = relativeComponentFiles.filter((file) => file.includes("_cq_dialog") || file.includes("_cq_design_dialog"));
    const htlPaths = relativeComponentFiles.filter((file) => file.endsWith(".html"));
    const clientlibPaths = relativeComponentFiles.filter((file) => file.includes("clientlib") || file.includes("clientlibs"));
    const configurationPaths = relativeComponentFiles.filter((file) => /(^|\/)(config|osgi-config)(\/|)/.test(file));
    const normalizedName = component.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const frontendAssets = allFiles
      .filter((candidate) => /(?:^|[\\/])components[\\/][^\\/]+[\\/].+\.(js|css|scss)$/i.test(candidate) && candidate.toLowerCase().includes(component.name.toLowerCase()))
      .map((candidate) => relative(root, candidate).replaceAll("\\", "/"))
      .sort();
    const backendTypes = allFiles
      .filter((candidate) => {
        if (!candidate.endsWith(".java") || !/(?:^|[\\/])src[\\/]main[\\/]java[\\/]/.test(candidate)) return false;
        const typeName = candidate.split(/[\\/]/).at(-1)!.replace(/\.java$/i, "").replace(/impl$/i, "").replace(/model$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
        return typeName === normalizedName;
      })
      .map((candidate) => relative(root, candidate).replaceAll("\\", "/"))
      .sort();
    const tests = allFiles.filter((candidate) => /(^|[\\/])src[\\/]test[\\/]/.test(candidate) && candidate.toLowerCase().includes(component.name.toLowerCase())).map((candidate) => relative(root, candidate).replaceAll("\\", "/"));
    const variants = relativeComponentFiles.filter((file) => /(^|\/)(v\d+|[a-z0-9-]+-variant)(\/|)/i.test(file)).map((file) => file.split("/").at(-2)).filter((value): value is string => Boolean(value));
    componentMap.set(component.id, { id: component.id, name: component.name, path: component.path, resourceType: component.resourceType, dialogPaths, htlPaths, clientlibPaths, configurationPaths, artifacts: componentArtifacts, frontendAssets, backendTypes, variants: [...new Set(variants)].sort(), dependencies: [], tests });
  }
  const components = [...componentMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const relationships: RepositoryRelationship[] = [];
  for (const artifact of artifacts) {
    if (!artifact.componentId) continue;
    relationships.push({ type: `component-has-${artifact.kind}`, source: artifact.componentId, target: artifact.path, status: "present", evidence: [artifact.path], confidence: 1, detectorVersion: AEM_PROFILE_VERSION, profileVersion: AEM_PROFILE_VERSION, notes: null });
  }
  return { modules, artifacts, components, relationships };
}
