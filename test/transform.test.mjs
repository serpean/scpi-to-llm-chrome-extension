import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { transformScpiArchive } from "../src/core/transform.js";

const exampleZip = path.resolve(
  process.cwd(),
  "example/D1_ASSMOD_S4HANA_COMMERCE.zip"
);

test("transformScpiArchive builds a single llm-ready text export from the example zip", async (t) => {
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
  assert.match(result.llmText, /# SCPI TO LLM/);
  assert.match(result.llmText, /===== SUMMARY =====/);
  assert.match(result.llmText, /===== FLOW JSON =====/);
  assert.match(
    result.llmText,
    /----- BEGIN FILE: source\/src\/main\/resources\/scenarioflows\/integrationflow\/D1_ASSMOD_S4HANA_COMMERCE\.iflw -----/
  );
  assert.match(result.llmText, /D1_ASSMOD_S4HANA_COMMERCE/);
});
