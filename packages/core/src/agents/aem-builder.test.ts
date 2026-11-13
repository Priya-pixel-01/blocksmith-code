import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGeneratedAemContracts } from "./aem-builder.js";

const dialogPath = "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-cta/_cq_dialog/.content.xml";
const htlPath = "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-cta/subscribe-cta.html";
const plan = { componentName: "subscribe-cta", filePlan: { filesToCreate: [], filesToModify: [] }, componentSpec: { implementation: { slingModel: null } } } as never;
const modelPath = "core/src/main/java/com/adobe/aem/guides/wknd/core/models/SubscribeCtaModel.java";
const modelImplPath = "core/src/main/java/com/adobe/aem/guides/wknd/core/models/impl/SubscribeCtaModelImpl.java";
const modelFqn = "com.adobe.aem.guides.wknd.core.models.SubscribeCtaModel";
const modelPlan = {
  componentName: "subscribe-cta",
  componentSpec: { implementation: { slingModel: modelFqn, resourceType: "wknd/components/subscribe-cta" } },
  filePlan: { filesToCreate: [modelPath, modelImplPath], filesToModify: [] },
} as never;

function writeFiles(root: string, htl: string): void {
  for (const [path, content] of [
    [dialogPath, '<jcr:root><link name="./link" /></jcr:root>'],
    [htlPath, htl],
  ]) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
}

test("validateGeneratedAemContracts rejects a dialog link field that HTL does not consume", () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-builder-"));
  try {
    writeFiles(root, "<button>${properties.text}</button>");
    assert.throws(
      () => validateGeneratedAemContracts(root, plan, [dialogPath, htlPath]),
      /declares a .\/link dialog field but no generated HTL consumes properties\.link/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateGeneratedAemContracts accepts HTL that consumes a dialog link field", () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-builder-"));
  try {
    writeFiles(root, '<a href="${properties.link}">${properties.text}</a>');
    assert.doesNotThrow(() => validateGeneratedAemContracts(root, plan, [dialogPath, htlPath]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateGeneratedAemContracts accepts a complete WKND-style Sling Model bound from HTL", () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-model-"));
  const modelSource = `package com.adobe.aem.guides.wknd.core.models;\npublic interface SubscribeCtaModel { String getLink(); }`;
  const implementationSource = `package com.adobe.aem.guides.wknd.core.models.impl;\n@Model(adaptables = SlingHttpServletRequest.class, adapters = SubscribeCtaModel.class, resourceType = "wknd/components/subscribe-cta")\npublic class SubscribeCtaModelImpl implements SubscribeCtaModel { public String getLink() { return "/subscribe"; } }`;
  try {
    writeFiles(root, `<a data-sly-use.model="${modelFqn}" href="\${model.link}">Subscribe</a>`);
    for (const [path, content] of [[modelPath, modelSource], [modelImplPath, implementationSource]]) {
      const file = join(root, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content);
    }
    assert.doesNotThrow(() => validateGeneratedAemContracts(root, modelPlan, [dialogPath, htlPath, modelPath, modelImplPath]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateGeneratedAemContracts rejects a Sling Model that HTL does not bind", () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-model-"));
  try {
    writeFiles(root, '<a href="${properties.link}">Subscribe</a>');
    for (const [path, content] of [
      [modelPath, "package com.adobe.aem.guides.wknd.core.models; public interface SubscribeCtaModel {}"],
      [modelImplPath, 'package com.adobe.aem.guides.wknd.core.models.impl; @Model(resourceType = "wknd/components/subscribe-cta") public class SubscribeCtaModelImpl implements SubscribeCtaModel {}'],
    ]) {
      const file = join(root, path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content);
    }
    assert.throws(
      () => validateGeneratedAemContracts(root, modelPlan, [dialogPath, htlPath, modelPath, modelImplPath]),
      /generated HTL does not bind that model/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});