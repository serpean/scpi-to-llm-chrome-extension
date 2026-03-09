import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { transformScpiArchive } from "../src/core/transform.js";

const exampleZip = path.resolve(
  process.cwd(),
  "example/D1_ASSMOD_S4HANA_COMMERCE.zip"
);

test("transformScpiArchive builds an llm-ready bundle from the example zip", async (t) => {
  try {
    await access(exampleZip);
  } catch {
    t.skip("example zip not available in this workspace");
    return;
  }

  const buffer = await readFile(exampleZip);
  const result = await transformScpiArchive(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), {
    artifactId: "D1_ASSMOD_S4HANA_COMMERCE",
    version: "1.0.18"
  });

  assert.equal(result.artifactName, "D1_ASSMOD_S4HANA_COMMERCE");
  assert.match(result.summaryMarkdown, /## Process Steps/);
  assert.ok(result.summary.iflow.steps.length > 0);

  const outputZip = await JSZip.loadAsync(result.outputZipBytes);
  const readme = await outputZip.file("README.md").async("string");
  const summaryJson = JSON.parse(await outputZip.file("summary/flow.json").async("string"));

  assert.match(readme, /D1_ASSMOD_S4HANA_COMMERCE/);
  assert.equal(summaryJson.artifactName, "D1_ASSMOD_S4HANA_COMMERCE");
  assert.ok(outputZip.file("source/src/main/resources/scenarioflows/integrationflow/D1_ASSMOD_S4HANA_COMMERCE.iflw"));
});
