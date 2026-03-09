(function () {
  const BRIDGE_ID = "scpi-to-llm-page-bridge";
  const pendingRequests = new Map();

  injectBridge();
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
      artifacts: dedupeArtifacts([
        ...scrapeArtifactRows(),
        ...scrapeArtifactHeader()
      ])
    };
  }

  function extractPackageId(pathname) {
    const match = pathname.match(/\/contentpackage\/([^/?]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function scrapeArtifactRows() {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    const artifacts = [];

    for (const row of rows) {
      const rawText = row.innerText || "";
      if (!rawText || !/Integration Flow/i.test(rawText)) {
        continue;
      }

      const lines = rawText
        .split("\n")
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], td'))
        .map((cell) => (cell.innerText || "").split("\n").map((line) => normalizeWhitespace(line)).filter(Boolean))
        .filter((cellLines) => cellLines.length > 0);
      const version = findVersion(cells, lines);
      const type = findType(cells, lines);
      const { name, description } = parseNameAndDescription(cells, lines);

      if (!name || /^Name$/i.test(name) || /^Artifacts/i.test(name)) {
        continue;
      }

      artifacts.push({
        id: name,
        name,
        version: version || "",
        description,
        type: type || "Integration Flow"
      });
    }

    return artifacts;
  }

  function scrapeArtifactHeader() {
    const heading = document.querySelector("h1");
    if (!heading) {
      return [];
    }

    const name = normalizeWhitespace(heading.textContent || "");
    const pageText = normalizeWhitespace(document.body.innerText || "");
    const versionMatch = pageText.match(/\bVersion[:\s]+(\d+\.\d+\.\d+)\b/i);
    if (!name) {
      return [];
    }

    return [
      {
        id: name,
        name,
        version: versionMatch ? versionMatch[1] : "",
        description: "",
        type: "Integration Flow"
      }
    ];
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

  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function findVersion(cells, lines) {
    const flat = [...cells.flat(), ...lines];
    return flat.find((line) => /^\d+\.\d+\.\d+$/.test(line) || /^Draft$/i.test(line)) || "";
  }

  function findType(cells, lines) {
    const flat = [...cells.flat(), ...lines];
    return flat.find((line) => /Integration Flow/i.test(line)) || "";
  }

  function parseNameAndDescription(cells, lines) {
    const nameCell = cells.find((cellLines) => cellLines.length > 0 && !cellLines.some((line) => /Integration Flow/i.test(line)));
    if (nameCell) {
      const [name, ...rest] = nameCell;
      return {
        name,
        description: rest.join(" ")
      };
    }

    const typeIndex = lines.findIndex((line) => /Integration Flow/i.test(line));
    return {
      name: typeIndex > 0 ? lines[typeIndex - 1] : lines[0] || "",
      description: typeIndex > 1 ? lines.slice(1, typeIndex - 1).join(" ") : lines[1] || ""
    };
  }
})();
