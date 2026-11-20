import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractAemRepository } from "./aem-extract.js";
import { computeAEMFilePlan } from "../aem-planner.js";
import { validateAEMImplementationPlan } from "../aem-validation.js";
import type { AemPlan } from "../../schemas/aem-plan.js";
import type { RepoProfile } from "../../schemas/repo-profile.js";
import type { AemComponentSpec } from "../../schemas/aem-spec.js";

test("classify Maven source modules correctly and route frontend assets into a local clientlib", () => {
  const root = mkdtempSync(join(tmpdir(), "aem-module-kinds-"));
  const write = (path: string, content = "") => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    for (const module of ["core", "ui.apps", "ui.content", "services", "misc"]) write(`${module}/pom.xml`, "<project/>");
    write("core/src/main/java/example/Hero.java");
    // Previously generated webpack assets must not reclassify the Java module.
    write("core/src/main/webpack/components/hero/hero.scss");
    write("ui.apps/src/main/content/jcr_root/apps/site/components/banner/banner.html");
    write("ui.apps/src/main/webpack/components/banner/banner.css");
    write("ui.content/src/main/content/jcr_root/content/site/.content.xml");
    write("services/src/main/java/example/Service.java");
    write("misc/src/main/resources/settings.xml");
    const extraction = extractAemRepository(root);
    assert.deepEqual(Object.fromEntries(extraction.modules.map((module) => [module.path, module.kind])), {
      core: "backend", misc: "other", services: "backend", "ui.apps": "application", "ui.content": "content",
    });
    const spec: AemComponentSpec = {
      projectType: "aem", name: "hero", purpose: "Hero", requirements: [], requiredModules: [], requiredFiles: [], dependencies: [],
      reuseDecision: { decision: "create", targetComponent: null, rationale: "New component", confidence: 1, evidence: [], gaps: [] },
      implementation: { htl: [], dialog: [], resourceType: "site/components/hero", slingModel: null, frontend: ["hero.scss", "hero.js"], backend: [], conventions: [] },
      acceptanceCriteria: [], openQuestions: [],
    };
    const plan = computeAEMFilePlan({ modules: extraction.modules, aemComponents: extraction.components } as RepoProfile, spec);
    const clientlib = "ui.apps/src/main/content/jcr_root/apps/site/components/hero/clientlib";
    for (const file of ["css/hero.css", "js/hero.js", ".content.xml", "css.txt", "js.txt"]) assert.ok(plan.filesToCreate.includes(`${clientlib}/${file}`), file);
    assert.ok(plan.filesToCreate.every((path) => !path.startsWith("core/") && !path.endsWith(".scss")));

    // Model output can incorrectly list frontend assets under HTL.
    // They must retain their asset role rather than being flattened into the component root.
    const misplacedSpec: AemComponentSpec = {
      ...spec,
      implementation: {
        ...spec.implementation,
        htl: ["clientlib.css", "clientlib.js"],
        frontend: [],
      },
    };
    const profile = { modules: extraction.modules, aemComponents: extraction.components } as RepoProfile;
    const misplacedPlan = computeAEMFilePlan(profile, misplacedSpec);
    for (const file of ["css/clientlib.css", "js/clientlib.js", ".content.xml", "css.txt", "js.txt"]) {
      assert.ok(misplacedPlan.filesToCreate.includes(`${clientlib}/${file}`), file);
    }
    assert.ok(misplacedPlan.filesToCreate.includes(`${clientlib.slice(0, -"/clientlib".length)}/hero.html`));
    assert.ok(!misplacedPlan.filesToCreate.includes(`${clientlib}.css`));
    assert.deepEqual(validateAEMImplementationPlan(profile, misplacedSpec, { filePlan: misplacedPlan } as AemPlan), { isValid: true, errors: [] });

    write("ui.frontend/pom.xml", "<project/>");
    write("assets/pom.xml", "<project/>");
    write("assets/src/main/webpack/components/hero/hero.scss");
    const modules = extractAemRepository(root).modules;
    assert.equal(modules.find((module) => module.path === "ui.frontend")?.kind, "frontend");
    assert.equal(modules.find((module) => module.path === "assets")?.kind, "frontend");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
