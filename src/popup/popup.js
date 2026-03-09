import { downloadBytes } from "../core/download.js";
import { transformScpiArchive } from "../core/transform.js";

const DEBUG_FLAG_KEY = "scpi-to-llm:popup-debug";
const DEBUG_QUERY_PARAM = "debug";

const elements = {
  infoPanel: document.getElementById("infoPanel"),
  debugPanel: document.getElementById("debugPanel"),
  pageMeta: document.getElementById("pageMeta"),
  artifactList: document.getElementById("artifactList"),
  downloadButton: document.getElementById("downloadButton"),
  refreshButton: document.getElementById("refreshButton"),
  activityButton: document.getElementById("activityButton"),
  activityList: document.getElementById("activityList"),
  retryCapturedButton: document.getElementById("retryCapturedButton"),
  zipInput: document.getElementById("zipInput"),
  statusBox: document.getElementById("statusBox")
};

let currentTab = null;
let currentContext = null;
let selectedArtifactKey = "";
let recentCandidateActivity = [];

const debugEnabled = isDebugPopupEnabled();

applyPopupMode(debugEnabled);

if (debugEnabled) {
  elements.refreshButton.addEventListener("click", () => void refreshContext());
  elements.activityButton.addEventListener("click", () => void refreshActivity());
  elements.downloadButton.addEventListener("click", () => void handleDirectDownload());
  elements.retryCapturedButton.addEventListener("click", () => void handleRetryCapturedUrl());
  elements.zipInput.addEventListener("change", (event) => void handleManualZip(event));

  await refreshContext();
}

function applyPopupMode(enabled) {
  elements.infoPanel.hidden = enabled;
  elements.debugPanel.hidden = !enabled;
  document.body.classList.toggle("is-debug", enabled);
}

function isDebugPopupEnabled() {
  const debugQueryValue = new URLSearchParams(window.location.search).get(DEBUG_QUERY_PARAM);
  if (debugQueryValue && /^(1|true|yes|on)$/i.test(debugQueryValue)) {
    return true;
  }

  try {
    return window.localStorage.getItem(DEBUG_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

async function refreshContext() {
  setStatus("Reading the active tab...");
  currentTab = await getActiveTab();
  if (!currentTab?.id) {
    setStatus("Could not identify the active tab.");
    return;
  }

  try {
    currentContext = await chrome.tabs.sendMessage(currentTab.id, { type: "GET_PAGE_CONTEXT" });
  } catch (error) {
    currentContext = null;
    setStatus(
      "The active tab does not appear to be a compatible SAP tenant, or the page has not finished loading yet."
    );
    renderArtifacts([]);
    return;
  }

  const packageSuffix = currentContext.packageId ? ` | package ${currentContext.packageId}` : "";
  elements.pageMeta.textContent = `${currentContext.host}${packageSuffix}`;
  renderArtifacts(currentContext.artifacts || []);
  await refreshActivity({ silent: true });
  setStatus(
    currentContext.artifacts?.length
      ? "Select an artifact and start the LLM-ready download."
      : "No visible artifacts were detected on the page. You can use the manual ZIP fallback."
  );
}

async function handleDirectDownload() {
  const artifact = getSelectedArtifact();
  if (!artifact || !currentTab?.id) {
    setStatus("No artifact is currently selected.");
    return;
  }

  try {
    elements.downloadButton.disabled = true;
    setStatus(`Downloading ${artifact.name} ${artifact.version || ""} from SAP...`);
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: "FETCH_ARTIFACT_ZIP",
      payload: {
        artifactId: artifact.id,
        version: artifact.version,
        packageId: currentContext?.packageId || ""
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Could not download the artifact");
    }

    await refreshActivity({ silent: true });
    await convertAndDownload(base64ToBytes(result.dataBase64), {
      artifactId: artifact.id,
      version: artifact.version,
      packageId: currentContext?.packageId || "",
      tenantHost: currentContext?.host || "",
      downloadUrl: result.finalUrl || ""
    });
  } catch (error) {
    await refreshActivity({ silent: true });
    setStatus(
      [
        "Direct download failed.",
        "",
        error instanceof Error ? error.message : String(error),
        "",
        recentCandidateActivity.length
          ? "Recent traffic was captured below. Run the native SAP download and try 'Retry captured URL'."
          : "No useful traffic has been captured yet. Run the native SAP download and then click 'View traffic'."
      ].join("\n")
    );
  } finally {
    elements.downloadButton.disabled = !getSelectedArtifact();
  }
}

async function handleRetryCapturedUrl() {
  const latest = recentCandidateActivity[0];
  if (!latest || !currentTab?.id) {
    setStatus("There is no captured URL available to retry.");
    return;
  }

  try {
    setStatus(`Retrying the latest captured URL...\n${latest.url}`);
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: "FETCH_ARTIFACT_BY_URL",
      payload: {
        url: latest.url,
        filename: guessFilenameFromUrl(latest.url)
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Could not download using the captured URL");
    }

    await convertAndDownload(base64ToBytes(result.dataBase64), {
      artifactId: getSelectedArtifact()?.id || "captured-artifact",
      version: getSelectedArtifact()?.version || "",
      packageId: currentContext?.packageId || "",
      tenantHost: currentContext?.host || "",
      downloadUrl: latest.url
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function handleManualZip(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    setStatus(`Converting local ZIP: ${file.name}`);
    const buffer = await file.arrayBuffer();
    await convertAndDownload(new Uint8Array(buffer), {
      artifactId: file.name.replace(/\.zip$/i, "")
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    event.target.value = "";
  }
}

async function convertAndDownload(bytes, source) {
  setStatus("Analyzing the SCPI export and generating the bundle...");
  const result = await transformScpiArchive(bytes.buffer, source);
  const filename = `${sanitizeFileName(result.artifactName)}-llm-ready.txt`;
  const downloadId = await downloadBytes(
    new TextEncoder().encode(result.llmText),
    filename,
    "text/plain;charset=utf-8"
  );
  setStatus(
    `Export generated.\n\nFile: ${filename}\n\nFormat: single text file\nSummary included: yes\nSummary JSON: yes\nConcatenated sources: yes${
      downloadId ? `\nDownload ID: ${downloadId}` : ""
    }`
  );
}

async function refreshActivity({ silent = false } = {}) {
  if (!currentTab?.id) {
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { type: "GET_RECENT_ACTIVITY" });
    recentCandidateActivity = extractCandidateActivity(response?.activity || []);
    renderActivity(recentCandidateActivity);
    if (!silent && recentCandidateActivity.length) {
      setStatus("SAP traffic updated. Review the captured URLs.");
    }
    if (!silent && !recentCandidateActivity.length) {
      setStatus("No relevant SAP traffic yet. Run the native SAP download and then click 'View traffic' again.");
    }
  } catch (error) {
    recentCandidateActivity = [];
    renderActivity([]);
    if (!silent) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }
}

function renderArtifacts(artifacts) {
  elements.artifactList.innerHTML = "";
  if (!artifacts.length) {
    elements.downloadButton.disabled = true;
    selectedArtifactKey = "";
    return;
  }

  if (!selectedArtifactKey) {
    selectedArtifactKey = toArtifactKey(artifacts[0]);
  }

  for (const artifact of artifacts) {
    const key = toArtifactKey(artifact);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `artifact-card${selectedArtifactKey === key ? " active" : ""}`;
    card.addEventListener("click", () => {
      selectedArtifactKey = key;
      renderArtifacts(artifacts);
    });
    card.innerHTML = `
      <span class="artifact-name">${escapeHtml(artifact.name)}</span>
      <span class="artifact-meta">${escapeHtml(artifact.version || "Version not detected")} · ${escapeHtml(
        artifact.type || "Artifact"
      )}</span>
      <span class="artifact-meta">${escapeHtml(artifact.description || "No visible description")}</span>
    `;
    elements.artifactList.appendChild(card);
  }

  elements.downloadButton.disabled = !getSelectedArtifact();
}

function renderActivity(items) {
  elements.activityList.innerHTML = "";
  elements.retryCapturedButton.disabled = items.length === 0;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "activity-card";
    empty.innerHTML = `
      <span class="activity-meta">No activity has been captured yet.</span>
      <span class="activity-meta">Click Download in SAP and then reopen this popup.</span>
    `;
    elements.activityList.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 8)) {
    const card = document.createElement("div");
    card.className = "activity-card";
    card.innerHTML = `
      <span class="activity-meta">${escapeHtml(item.source)} · ${escapeHtml(item.method)} · ${escapeHtml(
        item.status ? String(item.status) : "no-status"
      )}</span>
      <span class="activity-url">${escapeHtml(item.url)}</span>
      <span class="activity-meta">${escapeHtml(item.timestamp)}</span>
    `;
    elements.activityList.appendChild(card);
  }
}

function getSelectedArtifact() {
  return currentContext?.artifacts?.find((artifact) => toArtifactKey(artifact) === selectedArtifactKey);
}

function toArtifactKey(artifact) {
  return `${artifact.id}::${artifact.version || ""}`;
}

function setStatus(text) {
  elements.statusBox.textContent = text;
}

function sanitizeFileName(name) {
  return name.replace(/[^\w.-]+/g, "_");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function extractCandidateActivity(activity) {
  return activity.filter((entry) =>
    /(IntegrationDesigntimeArtifacts|workspace\.svc|download|export|artifact|\$value|\.zip\b)/i.test(
      entry.url || ""
    )
  );
}

function guessFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").pop();
    return filename && filename.includes(".") ? filename : "captured-artifact.zip";
  } catch {
    return "captured-artifact.zip";
  }
}

function base64ToBytes(base64) {
  if (!base64) {
    throw new Error("The downloaded ZIP arrived empty in the extension.");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
