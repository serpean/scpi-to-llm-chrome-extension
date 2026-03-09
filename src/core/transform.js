import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import formatXml from "xml-formatter";

const XMLISH_EXTENSIONS = [
  ".iflw",
  ".xml",
  ".xsl",
  ".xsd",
  ".wsdl",
  ".edmx",
  ".mmap",
  ".propdef"
];
const TEXT_EXTENSIONS = [
  ...XMLISH_EXTENSIONS,
  ".mf",
  ".prop",
  ".groovy",
  ".js",
  ".json",
  ".txt",
  ".project"
];

const xmlParser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  parseAttributeValue: false,
  trimValues: false
});

export async function transformScpiArchive(arrayBuffer, source = {}) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && !isIgnored(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const textEntries = [];
  for (const entry of entries) {
    if (!isTextEntry(entry.name)) {
      continue;
    }

    const rawText = await entry.async("string");
    textEntries.push({
      path: entry.name,
      rawText,
      prettyText: prettifyText(entry.name, rawText)
    });
  }

  const artifactName = inferArtifactName(entries, textEntries, source);
  const manifestText = findText(textEntries, /^META-INF\/MANIFEST\.MF$/i);
  const metainfoText = findText(textEntries, /(^|\/)metainfo\.prop$/i);
  const parametersText = findText(textEntries, /parameters\.propdef$/i);
  const iflwEntry = textEntries.find((entry) => entry.path.endsWith(".iflw"));

  const manifest = parseManifest(manifestText);
  const metainfo = parseProperties(metainfoText);
  const parameters = parseParameterDefinitions(parametersText);
  const iflow = iflwEntry ? parseIflow(iflwEntry.prettyText) : emptyIflow();
  const inventory = buildInventory(entries);

  const summary = {
    artifactName,
    source,
    manifest,
    metainfo,
    parameters,
    iflow,
    inventory
  };

  const summaryMarkdown = buildSummaryMarkdown(summary, textEntries);
  const outputZip = await buildOutputZip({
    artifactName,
    summary,
    summaryMarkdown,
    textEntries
  });

  return {
    artifactName,
    summary,
    summaryMarkdown,
    outputZipBytes: outputZip
  };
}

function isIgnored(filePath) {
  return filePath.includes("__MACOSX") || filePath.endsWith(".DS_Store");
}

function isTextEntry(filePath) {
  return TEXT_EXTENSIONS.some((extension) =>
    filePath.toLowerCase().endsWith(extension)
  );
}

function findText(entries, pattern) {
  return entries.find((entry) => pattern.test(entry.path))?.rawText ?? "";
}

function inferArtifactName(entries, textEntries, source) {
  if (source.artifactId) {
    return source.artifactId;
  }

  const bundleName = parseManifest(findText(textEntries, /^META-INF\/MANIFEST\.MF$/i))
    .BundleName;
  if (bundleName) {
    return bundleName;
  }

  const iflwPath = textEntries.find((entry) => entry.path.endsWith(".iflw"))?.path;
  if (iflwPath) {
    return iflwPath.split("/").pop().replace(/\.iflw$/i, "");
  }

  const firstTopLevel = entries[0]?.name?.split("/")[0];
  return firstTopLevel || "scpi-artifact";
}

function prettifyText(filePath, text) {
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();
  if (XMLISH_EXTENSIONS.some((extension) => filePath.endsWith(extension))) {
    try {
      return formatXml(normalized, {
        collapseContent: true,
        indentation: "  ",
        lineSeparator: "\n"
      }).trimEnd();
    } catch {
      return normalized;
    }
  }

  return normalized;
}

function parseManifest(text) {
  if (!text.trim()) {
    return {};
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const unfolded = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith(" ") && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  const manifest = {};
  for (const line of unfolded) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    manifest[key.replace(/-/g, "")] = value;
  }

  return manifest;
}

function parseProperties(text) {
  if (!text.trim()) {
    return {};
  }

  const properties = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    properties[key] = value;
  }

  return properties;
}

function parseParameterDefinitions(text) {
  if (!text.trim()) {
    return [];
  }

  try {
    const parsed = xmlParser.parse(text);
    return asArray(parsed.parameters?.parameter).map((parameter) => ({
      name: textValue(parameter.name),
      type: textValue(parameter.type),
      required: textValue(parameter.isRequired) === "true",
      description: textValue(parameter.description),
      defaultValue: textValue(parameter.defaultValue),
      constraint: textValue(parameter.constraint)
    }));
  } catch {
    return [];
  }
}

function parseIflow(text) {
  const parsed = xmlParser.parse(text);
  const definitions = parsed["bpmn2:definitions"] || {};
  const collaboration = firstItem(definitions["bpmn2:collaboration"]);
  const process = firstItem(definitions["bpmn2:process"]);
  const participants = asArray(collaboration?.["bpmn2:participant"]).map((participant) => ({
    id: participant["@_id"],
    name: participant["@_name"] || "",
    type:
      readProperties(participant["bpmn2:extensionElements"])["ifl:type"] ||
      participant["@_ifl:type"] ||
      ""
  }));
  const messageFlows = asArray(collaboration?.["bpmn2:messageFlow"]).map((flow) => ({
    id: flow["@_id"],
    name: flow["@_name"] || "",
    sourceRef: flow["@_sourceRef"],
    targetRef: flow["@_targetRef"],
    properties: readProperties(flow["bpmn2:extensionElements"])
  }));
  const sequenceFlows = asArray(process?.["bpmn2:sequenceFlow"]).map((flow) => ({
    id: flow["@_id"],
    name: flow["@_name"] || "",
    sourceRef: flow["@_sourceRef"],
    targetRef: flow["@_targetRef"],
    condition: textValue(flow["bpmn2:conditionExpression"]),
    properties: readProperties(flow["bpmn2:extensionElements"])
  }));
  const nodes = collectNodes(process);
  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const sequenceBySource = groupBy(sequenceFlows, (flow) => flow.sourceRef);

  const inboundFlows = messageFlows
    .filter((flow) => nodesById[flow.targetRef]?.kind === "startEvent")
    .map((flow) => connectMessageFlow(flow, nodesById, participants));
  const outboundFlows = messageFlows
    .filter((flow) => nodesById[flow.sourceRef])
    .map((flow) => connectMessageFlow(flow, nodesById, participants));
  const orderedSteps = buildOrderedSteps(nodes, sequenceBySource, nodesById);

  return {
    properties: readProperties(collaboration?.["bpmn2:extensionElements"]),
    participants,
    messageFlows,
    inboundFlows,
    outboundFlows,
    sequenceFlows,
    steps: orderedSteps
  };
}

function emptyIflow() {
  return {
    properties: {},
    participants: [],
    messageFlows: [],
    inboundFlows: [],
    outboundFlows: [],
    sequenceFlows: [],
    steps: []
  };
}

function collectNodes(process) {
  if (!process) {
    return [];
  }

  const descriptors = [
    ["bpmn2:startEvent", "startEvent"],
    ["bpmn2:endEvent", "endEvent"],
    ["bpmn2:callActivity", "callActivity"],
    ["bpmn2:serviceTask", "serviceTask"],
    ["bpmn2:exclusiveGateway", "exclusiveGateway"],
    ["bpmn2:parallelGateway", "parallelGateway"]
  ];

  return descriptors.flatMap(([key, kind]) =>
    asArray(process[key]).map((node) => ({
      id: node["@_id"],
      name: node["@_name"] || friendlyKind(kind),
      kind,
      incoming: asArray(node["bpmn2:incoming"]).map(textValue),
      outgoing: asArray(node["bpmn2:outgoing"]).map(textValue),
      properties: readProperties(node["bpmn2:extensionElements"])
    }))
  );
}

function connectMessageFlow(flow, nodesById, participants) {
  const sourceNode = nodesById[flow.sourceRef];
  const targetNode = nodesById[flow.targetRef];
  const sourceParticipant = participants.find((participant) => participant.id === flow.sourceRef);
  const targetParticipant = participants.find((participant) => participant.id === flow.targetRef);

  return {
    id: flow.id,
    name: flow.name,
    source: sourceNode?.name || sourceParticipant?.name || flow.sourceRef,
    target: targetNode?.name || targetParticipant?.name || flow.targetRef,
    protocol:
      flow.properties.MessageProtocol ||
      flow.properties.TransportProtocol ||
      flow.properties.ComponentType ||
      "",
    address: flow.properties.address || "",
    operation: flow.properties.operation || "",
    authenticationMethod: flow.properties.authenticationMethod || "",
    resourcePath: flow.properties.resourcePath || "",
    adapterType: flow.properties.ComponentType || "",
    properties: flow.properties
  };
}

function buildOrderedSteps(nodes, sequenceBySource, nodesById) {
  const startNodes = nodes.filter((node) => node.kind === "startEvent");
  const visited = new Set();
  const ordered = [];
  const queue = [...startNodes];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || visited.has(node.id)) {
      continue;
    }

    visited.add(node.id);
    ordered.push({
      ...node,
      transitions: (sequenceBySource[node.id] || []).map((flow) => ({
        id: flow.id,
        name: flow.name,
        condition: flow.condition,
        targetId: flow.targetRef,
        targetName: nodesById[flow.targetRef]?.name || flow.targetRef
      }))
    });

    for (const flow of sequenceBySource[node.id] || []) {
      if (nodesById[flow.targetRef] && !visited.has(flow.targetRef)) {
        queue.push(nodesById[flow.targetRef]);
      }
    }
  }

  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }

    ordered.push({
      ...node,
      transitions: (sequenceBySource[node.id] || []).map((flow) => ({
        id: flow.id,
        name: flow.name,
        condition: flow.condition,
        targetId: flow.targetRef,
        targetName: nodesById[flow.targetRef]?.name || flow.targetRef
      }))
    });
  }

  return ordered;
}

function buildInventory(entries) {
  const counters = {
    scripts: 0,
    mappings: 0,
    schemas: 0,
    edm: 0,
    flows: 0,
    other: 0
  };

  for (const entry of entries) {
    if (/\/script\//i.test(entry.name)) {
      counters.scripts += 1;
      continue;
    }
    if (/\/mapping\//i.test(entry.name)) {
      counters.mappings += 1;
      continue;
    }
    if (/\/(xsd|wsdl)\//i.test(entry.name)) {
      counters.schemas += 1;
      continue;
    }
    if (/\/edmx\//i.test(entry.name)) {
      counters.edm += 1;
      continue;
    }
    if (/\.iflw$/i.test(entry.name)) {
      counters.flows += 1;
      continue;
    }
    counters.other += 1;
  }

  return counters;
}

async function buildOutputZip({ artifactName, summary, summaryMarkdown, textEntries }) {
  const zip = new JSZip();
  zip.file("README.md", summaryMarkdown);
  zip.file("summary/flow.json", JSON.stringify(summary, null, 2));

  for (const entry of textEntries) {
    zip.file(pathForOutput(entry.path), entry.prettyText + "\n");
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function pathForOutput(filePath) {
  return `source/${filePath}`;
}

function buildSummaryMarkdown(summary, textEntries) {
  const lines = [];
  const version =
    summary.source.version ||
    summary.manifest.BundleVersion ||
    summary.manifest.BundleVersion ||
    "";

  lines.push(`# ${summary.artifactName}`);
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Artifact: ${summary.artifactName}`);
  if (version) {
    lines.push(`- Version: ${version}`);
  }
  if (summary.metainfo.description) {
    lines.push(`- Description: ${summary.metainfo.description}`);
  }
  if (summary.metainfo.source || summary.metainfo.target) {
    lines.push(
      `- Source -> Target: ${summary.metainfo.source || "?"} -> ${
        summary.metainfo.target || "?"
      }`
    );
  }
  if (summary.source.packageId) {
    lines.push(`- Package: ${summary.source.packageId}`);
  }
  lines.push("");

  lines.push("## Externalized Parameters");
  lines.push("");
  if (summary.parameters.length === 0) {
    lines.push("- None detected");
  } else {
    for (const parameter of summary.parameters) {
      lines.push(
        `- ${parameter.name || "(unnamed)"} | ${parameter.type || "unknown"} | required: ${
          parameter.required ? "yes" : "no"
        }`
      );
    }
  }
  lines.push("");

  lines.push("## Inbound Adapters");
  lines.push("");
  if (summary.iflow.inboundFlows.length === 0) {
    lines.push("- None detected");
  } else {
    for (const adapter of summary.iflow.inboundFlows) {
      lines.push(
        `- ${adapter.name || adapter.source} | protocol: ${
          adapter.protocol || "unknown"
        } | source: ${adapter.source}`
      );
    }
  }
  lines.push("");

  lines.push("## Outbound Adapters");
  lines.push("");
  if (summary.iflow.outboundFlows.length === 0) {
    lines.push("- None detected");
  } else {
    for (const adapter of summary.iflow.outboundFlows) {
      const details = [
        adapter.protocol && `protocol: ${adapter.protocol}`,
        adapter.operation && `operation: ${adapter.operation}`,
        adapter.authenticationMethod &&
          `auth: ${adapter.authenticationMethod}`,
        adapter.address && `address: ${adapter.address}`,
        adapter.resourcePath && `resource: ${adapter.resourcePath}`
      ].filter(Boolean);
      lines.push(
        `- ${adapter.name || adapter.target} | target: ${adapter.target}${
          details.length > 0 ? ` | ${details.join(" | ")}` : ""
        }`
      );
    }
  }
  lines.push("");

  lines.push("## Process Steps");
  lines.push("");
  if (summary.iflow.steps.length === 0) {
    lines.push("- No BPMN steps detected");
  } else {
    for (const [index, step] of summary.iflow.steps.entries()) {
      lines.push(`${index + 1}. ${step.name} [${friendlyKind(step.kind)}]`);
      const descriptors = summarizeStep(step);
      if (descriptors.length > 0) {
        lines.push(`   - ${descriptors.join(" | ")}`);
      }
      if (step.transitions.length === 0) {
        lines.push("   - Next: none");
      } else {
        for (const transition of step.transitions) {
          const label =
            transition.name ||
            transition.condition ||
            (step.kind.includes("Gateway") ? "route" : "next");
          lines.push(`   - ${label} -> ${transition.targetName}`);
        }
      }
    }
  }
  lines.push("");

  lines.push("## Resource Inventory");
  lines.push("");
  lines.push(`- Scripts: ${summary.inventory.scripts}`);
  lines.push(`- Mappings: ${summary.inventory.mappings}`);
  lines.push(`- Schemas: ${summary.inventory.schemas}`);
  lines.push(`- EDMX: ${summary.inventory.edm}`);
  lines.push(`- IFlow files: ${summary.inventory.flows}`);
  lines.push(`- Other files: ${summary.inventory.other}`);
  lines.push("");

  lines.push("## Included Source Files");
  lines.push("");
  for (const entry of textEntries) {
    lines.push(`- ${pathForOutput(entry.path)}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

function summarizeStep(step) {
  const properties = step.properties || {};
  const descriptors = [];

  if (properties.activityType) {
    descriptors.push(`activity: ${properties.activityType}`);
  }
  if (properties.subActivityType) {
    descriptors.push(`subtype: ${properties.subActivityType}`);
  }
  if (properties.script) {
    descriptors.push(`script: ${properties.script}`);
  }
  if (properties.mappingname) {
    descriptors.push(`mapping: ${properties.mappingname}`);
  }
  if (properties.mappinguri) {
    descriptors.push(`mappingUri: ${properties.mappinguri}`);
  }

  const enrichedHeaders = Object.keys(properties).filter((key) => key.startsWith("HEADER_"));
  if (enrichedHeaders.length > 0) {
    descriptors.push(`headers: ${enrichedHeaders.length}`);
  }

  return descriptors;
}

function readProperties(extensionElements) {
  const properties = {};
  const propertyNodes = asArray(extensionElements?.["ifl:property"]);
  for (const property of propertyNodes) {
    const key = textValue(property.key);
    if (!key) {
      continue;
    }
    properties[key] = textValue(property.value);
  }

  return properties;
}

function textValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && "#text" in value) {
    return textValue(value["#text"]);
  }

  return "";
}

function groupBy(items, getKey) {
  const result = {};
  for (const item of items) {
    const key = getKey(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstItem(value) {
  return asArray(value)[0];
}

function friendlyKind(kind) {
  return {
    startEvent: "start event",
    endEvent: "end event",
    callActivity: "call activity",
    serviceTask: "service task",
    exclusiveGateway: "exclusive gateway",
    parallelGateway: "parallel gateway"
  }[kind] || kind;
}
