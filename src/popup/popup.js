import { downloadBytes } from "../core/download.js";
import { transformScpiArchive } from "../core/transform.js";

const elements = {
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

elements.refreshButton.addEventListener("click", () => void refreshContext());
elements.activityButton.addEventListener("click", () => void refreshActivity());
elements.downloadButton.addEventListener("click", () => void handleDirectDownload());
elements.retryCapturedButton.addEventListener("click", () => void handleRetryCapturedUrl());
elements.zipInput.addEventListener("change", (event) => void handleManualZip(event));

await refreshContext();

async function refreshContext() {
  setStatus("Leyendo la pestaña activa...");
  currentTab = await getActiveTab();
  if (!currentTab?.id) {
    setStatus("No he podido identificar la pestaña activa.");
    return;
  }

  try {
    currentContext = await chrome.tabs.sendMessage(currentTab.id, { type: "GET_PAGE_CONTEXT" });
  } catch (error) {
    currentContext = null;
    setStatus(
      "La pestaña activa no parece ser un tenant compatible de SAP o la página aún no terminó de cargar."
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
      ? "Selecciona un artifact y lanza la descarga llm-ready."
      : "No he detectado artifacts visibles en la página. Puedes usar el ZIP manual."
  );
}

async function handleDirectDownload() {
  const artifact = getSelectedArtifact();
  if (!artifact || !currentTab?.id) {
    setStatus("No hay ningún artifact seleccionado.");
    return;
  }

  try {
    elements.downloadButton.disabled = true;
    setStatus(`Descargando ${artifact.name} ${artifact.version || ""} desde SAP...`);
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: "FETCH_ARTIFACT_ZIP",
      payload: {
        artifactId: artifact.id,
        version: artifact.version,
        packageId: currentContext?.packageId || ""
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "No se pudo descargar el artifact");
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
        "Fallo en descarga directa.",
        "",
        error instanceof Error ? error.message : String(error),
        "",
        recentCandidateActivity.length
          ? "He capturado tráfico reciente abajo. Haz la descarga nativa en SAP y prueba 'Retry captured URL'."
          : "Todavía no hay tráfico útil capturado. Haz la descarga nativa en SAP y luego pulsa 'Ver tráfico'."
      ].join("\n")
    );
  } finally {
    elements.downloadButton.disabled = !getSelectedArtifact();
  }
}

async function handleRetryCapturedUrl() {
  const latest = recentCandidateActivity[0];
  if (!latest || !currentTab?.id) {
    setStatus("No hay ninguna URL capturada para reintentar.");
    return;
  }

  try {
    setStatus(`Reintentando la última URL capturada...\n${latest.url}`);
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: "FETCH_ARTIFACT_BY_URL",
      payload: {
        url: latest.url,
        filename: guessFilenameFromUrl(latest.url)
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "No se pudo descargar usando la URL capturada");
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
    setStatus(`Convirtiendo ZIP local: ${file.name}`);
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
  setStatus("Analizando el export SCPI y generando el bundle...");
  const result = await transformScpiArchive(bytes.buffer, source);
  const filename = `${sanitizeFileName(result.artifactName)}-llm-ready.zip`;
  downloadBytes(result.outputZipBytes, filename);
  setStatus(`Bundle generado.\n\nArchivo: ${filename}\n\nREADME incluido: sí\nJSON de resumen: sí\nFuentes normalizadas: sí`);
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
      setStatus("Tráfico SAP actualizado. Revisa las URLs capturadas.");
    }
    if (!silent && !recentCandidateActivity.length) {
      setStatus("No hay tráfico SAP relevante aún. Haz la descarga nativa en SAP y vuelve a pulsar 'Ver tráfico'.");
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
      <span class="artifact-meta">${escapeHtml(artifact.description || "Sin descripción visible")}</span>
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
      <span class="activity-meta">Sin actividad capturada todavía.</span>
      <span class="activity-meta">Pulsa Download en SAP y luego vuelve a abrir este popup.</span>
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
    throw new Error("El ZIP descargado llegó vacío a la extensión.");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
