import { downloadBytes } from "../core/download.js";
import { transformScpiArchive } from "../core/transform.js";

(function () {
  const DEBUG = false;
  const BRIDGE_ID = "scpi-to-llm-page-bridge";
  const STYLE_ID = "scpi-to-llm-inline-style";
  const STATUS_ID = "scpi-to-llm-status";
  const pendingRequests = new Map();
  let activeArtifactContext = null;
  let popupInjectionTimer = null;
  let lastRowActionButton = null;

  injectBridge();
  injectStyles();
  ensureStatusChip();
  attachInteractionTracking();
  observeDomChanges();

  window.addEventListener("message", handlePageMessage);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  function injectBridge() {
    if (document.getElementById(BRIDGE_ID)) {
      return;
    }

    const script = document.createElement("script");
    script.id = BRIDGE_ID;
    script.src = chrome.runtime.getURL("content/page-bridge.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .scpi-to-llm-menu-item {
        position: relative;
      }

      #${STATUS_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        max-width: 360px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(31, 36, 48, 0.94);
        color: #f4f7fb;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22);
        font-family: "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.4;
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity 160ms ease, transform 160ms ease;
        white-space: pre-wrap;
      }

      #${STATUS_ID}.visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${STATUS_ID}[data-tone="error"] {
        background: rgba(122, 24, 24, 0.96);
      }

      #${STATUS_ID}[data-tone="success"] {
        background: rgba(14, 92, 73, 0.96);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureStatusChip() {
    if (document.getElementById(STATUS_ID)) {
      return;
    }

    const status = document.createElement("div");
    status.id = STATUS_ID;
    document.documentElement.appendChild(status);
  }

  function handlePageMessage(event) {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== "scpi-to-llm-page") {
      return;
    }

    const deferred = pendingRequests.get(message.requestId);
    if (!deferred) {
      return;
    }

    pendingRequests.delete(message.requestId);
    if (message.type === "FETCH_ARTIFACT_RESULT") {
      deferred.resolve({
        ok: true,
        dataBase64: message.dataBase64 || "",
        filename: message.filename,
        finalUrl: message.finalUrl,
        attemptedUrls: message.attemptedUrls || []
      });
      return;
    }

    if (message.type === "GET_RECENT_ACTIVITY_RESULT") {
      deferred.resolve({
        ok: true,
        activity: message.activity || []
      });
      return;
    }

    deferred.reject(new Error(message.error || "Unknown page bridge error"));
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "GET_PAGE_CONTEXT") {
      sendResponse(scrapePageContext());
      return false;
    }

    if (message.type === "FETCH_ARTIFACT_ZIP") {
      fetchArtifactZip(message.payload)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "GET_RECENT_ACTIVITY") {
      getRecentActivity()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "FETCH_ARTIFACT_BY_URL") {
      fetchArtifactByUrl(message.payload)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  }

  function fetchArtifactZip(payload) {
    return bridgeRequest("FETCH_ARTIFACT", payload);
  }

  function fetchArtifactByUrl(payload) {
    return bridgeRequest("FETCH_URL", payload);
  }

  function getRecentActivity() {
    return bridgeRequest("GET_RECENT_ACTIVITY", {});
  }

  function bridgeRequest(type, payload) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      window.postMessage(
        {
          source: "scpi-to-llm-content",
          type,
          requestId,
          payload
        },
        window.location.origin
      );

      setTimeout(() => {
        if (!pendingRequests.has(requestId)) {
          return;
        }
        pendingRequests.delete(requestId);
        reject(new Error("Timeout while talking to the SAP page bridge"));
      }, 60000);
    });
  }

  function scrapePageContext() {
    return {
      url: window.location.href,
      host: window.location.origin,
      packageId: extractPackageId(window.location.pathname),
      artifacts: dedupeArtifacts(scrapeArtifactRows())
    };
  }

  function observeDomChanges() {
    const observer = new MutationObserver(() => {
      queueMicrotask(() => {
        injectMenuActionIntoOpenPopup();
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function attachInteractionTracking() {
    document.addEventListener(
      "click",
      (event) => {
        const context = resolveArtifactContextFromActionClick(event.target);
        if (context) {
          debugLog("actions click captured", {
            artifact: context.artifact,
            buttonTitle: context.button?.getAttribute("title") || "",
            rowText: truncate(normalizeWhitespace(context.row?.innerText || ""), 220)
          });
          activeArtifactContext = context;
          lastRowActionButton = context.button || null;
          schedulePopupInjection();
        }
      },
      true
    );
  }

  function schedulePopupInjection() {
    const startedAt = Date.now();
    debugLog("schedule popup injection", {
      artifact: activeArtifactContext?.artifact?.name || "",
      version: activeArtifactContext?.artifact?.version || ""
    });
    clearInterval(popupInjectionTimer);
    popupInjectionTimer = setInterval(() => {
      const injected = injectMenuActionIntoOpenPopup();
      debugLog("popup injection tick", { injected, elapsedMs: Date.now() - startedAt });
      if (injected || Date.now() - startedAt > 2500) {
        clearInterval(popupInjectionTimer);
        popupInjectionTimer = null;
        debugLog("popup injection stop", { injected, elapsedMs: Date.now() - startedAt });
      }
    }, 100);

    setTimeout(() => {
      const injected = injectMenuActionIntoOpenPopup();
      debugLog("popup injection immediate", { injected });
    }, 0);
  }

  async function handleInlineExport(trigger, artifact) {
    const packageId = extractPackageId(window.location.pathname);
    const originalLabel = readNodeLabel(trigger);
    setNodeLabel(trigger, "To LLM...");
    setNodeBusy(trigger, true);
    showStatus(`Exporting ${artifact.name}...`);

    try {
      const result = await fetchArtifactZip({
        artifactId: artifact.id,
        version: artifact.version,
        packageId
      });

      if (!result?.ok) {
        throw new Error(result?.error || "Could not download the artifact");
      }

      const bytes = base64ToBytes(result.dataBase64);
      const transformed = await transformScpiArchive(bytes.buffer, {
        artifactId: artifact.id,
        version: artifact.version,
        packageId,
        tenantHost: window.location.origin,
        downloadUrl: result.finalUrl || ""
      });

      const filename = `${sanitizeFileName(transformed.artifactName)}-llm-ready.txt`;
      const downloadId = await downloadBytes(
        new TextEncoder().encode(transformed.llmText),
        filename,
        "text/plain;charset=utf-8"
      );

      setNodeLabel(trigger, "Done");
      showStatus(
        `Export generated: ${filename}${downloadId ? `\nDownload ID: ${downloadId}` : ""}`,
        "success"
      );
      setTimeout(() => {
        setNodeLabel(trigger, originalLabel);
      }, 1600);
    } catch (error) {
      setNodeLabel(trigger, "Error");
      showStatus(
        `Export failed for ${artifact.name}\n${
          error instanceof Error ? error.message : String(error)
        }`,
        "error"
      );
      setTimeout(() => {
        setNodeLabel(trigger, originalLabel);
      }, 2200);
    } finally {
      setTimeout(() => {
        setNodeBusy(trigger, false);
      }, 250);
    }
  }

  function findArtifactRows() {
    const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
    return rows.filter((row) => parseArtifactFromRow(row));
  }

  function parseArtifactFromRow(row) {
    const rawText = row.innerText || "";
    if (!rawText || !/Integration\s*Flow/i.test(rawText)) {
      return null;
    }

    const lines = rawText
      .split("\n")
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    const cells = Array.from(row.querySelectorAll('[role="gridcell"], td'))
      .map((cell) =>
        (cell.innerText || "")
          .split("\n")
          .map((line) => normalizeWhitespace(line))
          .filter(Boolean)
      )
      .filter((cellLines) => cellLines.length > 0);

    const version = findVersion(cells, lines);
    const type = findType(cells, lines);
    const { name, description } = parseNameAndDescription(cells, lines);

    if (!name || /^Name$/i.test(name) || /^Artifacts/i.test(name)) {
      return null;
    }

    return {
      id: name,
      name,
      version: version || "",
      description,
      type: type || "Integration Flow"
    };
  }

  function resolveArtifactContextFromActionClick(target) {
    const element = target instanceof Element ? target : null;
    if (!element) {
      return null;
    }

    const button = element.closest('button, [role="button"]');
    if (!button) {
      return null;
    }

    if (!isLikelyRowActionButton(button)) {
      return null;
    }

    const row = button.closest('[role="row"], tr');
    const artifact = row ? parseArtifactFromRow(row) : null;
    if (!artifact) {
      return null;
    }

    return { artifact, row, button };
  }

  function injectMenuActionIntoOpenPopup() {
    const artifactContext = getBestArtifactContext();
    if (!artifactContext?.artifact) {
      debugLog("inject skipped: no artifact context");
      return false;
    }

    const popup = findOpenActionPopup();
    if (!popup) {
      debugLog("inject skipped: popup not found");
      return false;
    }

    if (popup.querySelector(".scpi-to-llm-menu-item")) {
      debugLog("inject skipped: menu item already present");
      return false;
    }

    const downloadItem = findDownloadButton(popup);
    if (!downloadItem) {
      debugLog("inject skipped: download button not found", {
        popupButtons: Array.from(popup.querySelectorAll("button")).map((button) =>
          normalizeWhitespace(button.innerText || button.getAttribute("title") || "")
        )
      });
      return false;
    }

    const menuItem = cloneActionSheetButton(downloadItem, "To LLM");
    const hiddenText = cloneActionSheetHiddenText(downloadItem, menuItem, popup);
    menuItem.classList.add("scpi-to-llm-menu-item");
    menuItem.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void handleInlineExport(menuItem, artifactContext.artifact);
    });

    const anchor = getActionSheetInsertionAnchor(downloadItem);
    anchor.insertAdjacentElement("afterend", menuItem);
    menuItem.insertAdjacentElement("afterend", hiddenText);
    debugLog("menu item inserted", {
      artifact: artifactContext.artifact.name,
      popupHtml: truncate(popup.innerHTML, 800),
      buttonTexts: Array.from(popup.querySelectorAll("button")).map((button) =>
        normalizeWhitespace(button.innerText || button.getAttribute("title") || "")
      )
    });
    return true;
  }

  function findOpenActionPopup() {
    const actionSheets = Array.from(document.querySelectorAll(".sapMActionSheet"))
      .filter(isVisible)
      .filter((element) => {
        const text = normalizeWhitespace(element.innerText || "");
        return /download/i.test(text) && /copy/i.test(text);
      });

    if (actionSheets.length > 0) {
      debugLog("action sheet found", {
        count: actionSheets.length,
        texts: actionSheets.map((element) => truncate(normalizeWhitespace(element.innerText || ""), 200))
      });
      return actionSheets[0];
    }

    const popovers = Array.from(document.querySelectorAll(".sapMPopoverCont, .sapMPopoverWrapper"))
      .filter(isVisible)
      .filter((element) => {
        const text = normalizeWhitespace(element.innerText || "");
        return /download/i.test(text) && /copy/i.test(text);
      });

    if (popovers.length > 0) {
      debugLog("popover fallback found", {
        count: popovers.length,
        texts: popovers.map((element) => truncate(normalizeWhitespace(element.innerText || ""), 200))
      });
    }
    return popovers[0] || null;
  }

  function findDownloadButton(container) {
    const buttons = Array.from(
      container.querySelectorAll("button.sapMActionSheetButton, button")
    ).filter(isVisible);

    const result =
      buttons.find(
        (button) => normalizeWhitespace(button.innerText || "").toLowerCase() === "download"
      ) || null;

    debugLog("find download button", {
      found: Boolean(result),
      buttons: buttons.map((button) =>
        normalizeWhitespace(button.innerText || button.getAttribute("title") || "")
      )
    });

    return result;
  }

  function cloneActionSheetButton(source, label) {
    const clone = source.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-selected");
    clone.removeAttribute("aria-describedby");
    clone.removeAttribute("data-sap-ui");
    clone.dataset.scpiToLlm = "true";
    stripIds(clone);
    setNodeLabel(clone, label);
    setNodeBusy(clone, false);
    return clone;
  }

  function cloneActionSheetHiddenText(sourceButton, buttonClone, popup) {
    const sourceHiddenText = getActionSheetHiddenTextNode(sourceButton);
    const clone = sourceHiddenText
      ? sourceHiddenText.cloneNode(true)
      : document.createElement("span");

    clone.className = sourceHiddenText?.className || "sapUiInvisibleText";
    clone.textContent = buildHiddenItemText(popup, buttonClone);
    stripIds(clone);
    return clone;
  }

  function getActionSheetHiddenTextNode(button) {
    const sibling = button.nextElementSibling;
    if (
      sibling &&
      sibling instanceof HTMLElement &&
      sibling.classList.contains("sapUiInvisibleText") &&
      /Item \d+ of \d+/i.test(sibling.textContent || "")
    ) {
      return sibling;
    }
    return null;
  }

  function getActionSheetInsertionAnchor(downloadButton) {
    return getActionSheetHiddenTextNode(downloadButton) || downloadButton;
  }

  function buildHiddenItemText(popup, buttonClone) {
    const existingHiddenTexts = Array.from(
      popup.querySelectorAll(".sapUiInvisibleText")
    ).filter((node) => /Item \d+ of \d+/i.test(node.textContent || ""));
    const existingButtons = popup.querySelectorAll("button.sapMActionSheetButton, button").length;
    const itemNumber = existingHiddenTexts.length + 1;
    const total = existingButtons + 1;
    return `Item ${itemNumber} of ${total}`;
  }

  function stripIds(root) {
    if (!(root instanceof Element)) {
      return;
    }
    root.removeAttribute("id");
    root.removeAttribute("aria-describedby");
    root.removeAttribute("aria-labelledby");
    root.removeAttribute("data-sap-ui");
    for (const child of root.querySelectorAll("[id]")) {
      child.removeAttribute("id");
    }
    for (const child of root.querySelectorAll("[aria-describedby], [aria-labelledby], [data-sap-ui]")) {
      child.removeAttribute("aria-describedby");
      child.removeAttribute("aria-labelledby");
      child.removeAttribute("data-sap-ui");
    }
  }

  function readNodeLabel(node) {
    if (!(node instanceof Element)) {
      return "To LLM";
    }
    return normalizeWhitespace(node.innerText || "") || "To LLM";
  }

  function setNodeLabel(node, label) {
    if (!(node instanceof Element)) {
      return;
    }

    const preferred = node.querySelector(".sapMBtnContent bdi, .sapMBtnContent, bdi");
    if (preferred) {
      preferred.textContent = label;
      return;
    }

    const leaf = Array.from(node.querySelectorAll("*"))
      .filter((element) => element.children.length === 0)
      .find((element) => normalizeWhitespace(element.textContent || "").length > 0);

    if (leaf) {
      leaf.textContent = label;
    } else {
      node.textContent = label;
    }
  }

  function setNodeBusy(node, busy) {
    if (!(node instanceof HTMLElement)) {
      return;
    }
    node.style.pointerEvents = busy ? "none" : "";
    node.style.opacity = busy ? "0.7" : "";
  }

  function extractPackageId(pathname) {
    const match = pathname.match(/\/contentpackage\/([^/?]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function dedupeArtifacts(artifacts) {
    const seen = new Map();
    for (const artifact of artifacts) {
      const key = `${artifact.id}::${artifact.version || ""}`;
      if (!seen.has(key)) {
        seen.set(key, artifact);
      }
    }
    return Array.from(seen.values());
  }

  function scrapeArtifactRows() {
    return findArtifactRows()
      .map((row) => parseArtifactFromRow(row))
      .filter(Boolean);
  }

  function showStatus(text, tone = "") {
    const chip = document.getElementById(STATUS_ID);
    if (!chip) {
      return;
    }

    chip.textContent = text;
    chip.dataset.tone = tone;
    chip.classList.add("visible");
    clearTimeout(chip.__scpiToLlmTimeout);
    chip.__scpiToLlmTimeout = setTimeout(() => {
      chip.classList.remove("visible");
    }, 4200);
  }

  function findVersion(cells, lines) {
    const flat = [...cells.flat(), ...lines];
    return flat.find((line) => /^\d+\.\d+\.\d+$/.test(line) || /^Draft$/i.test(line)) || "";
  }

  function findType(cells, lines) {
    const flat = [...cells.flat(), ...lines];
    return flat.find((line) => /Integration\s*Flow/i.test(line)) || "";
  }

  function parseNameAndDescription(cells, lines) {
    const nameCell = cells.find(
      (cellLines) =>
        cellLines.length > 0 && !cellLines.some((line) => /Integration\s*Flow/i.test(line))
    );
    if (nameCell) {
      const [name, ...rest] = nameCell;
      return {
        name,
        description: rest.join(" ")
      };
    }

    const typeIndex = lines.findIndex((line) => /Integration\s*Flow/i.test(line));
    return {
      name: typeIndex > 0 ? lines[typeIndex - 1] : lines[0] || "",
      description: typeIndex > 1 ? lines.slice(1, typeIndex - 1).join(" ") : lines[1] || ""
    };
  }

  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function sanitizeFileName(name) {
    return name.replace(/[^\w.-]+/g, "_");
  }

  function getBestArtifactContext() {
    if (activeArtifactContext?.artifact) {
      debugLog("using active artifact context", activeArtifactContext.artifact);
      return activeArtifactContext;
    }

    if (lastRowActionButton) {
      const row = lastRowActionButton.closest('[role="row"], tr');
      const artifact = row ? parseArtifactFromRow(row) : null;
      if (artifact) {
        debugLog("using last row action button context", artifact);
        return { artifact, row, button: lastRowActionButton };
      }
    }

    debugLog("no artifact context available");
    return null;
  }

  function isLikelyRowActionButton(button) {
    const text = normalizeWhitespace(
      [
        button.innerText,
        button.getAttribute("title"),
        button.getAttribute("aria-label"),
        button.className
      ]
        .filter(Boolean)
        .join(" ")
    ).toLowerCase();

    if (/actions/.test(text)) {
      debugLog("row action button matched by title", { text });
      return true;
    }

    const matched =
      /sapmbtntransparent|sapmbtniconfirst/.test(text) &&
      normalizeWhitespace(button.innerText || "") === "";
    if (matched) {
      debugLog("row action button matched by class fallback", { text });
    }
    return matched;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
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

  function debugLog(message, payload) {
    void message;
    void payload;
    void DEBUG;
  }

  function truncate(value, maxLength) {
    const text = String(value || "");
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...`;
  }
})();
