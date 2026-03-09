(function () {
  const ACTIVITY_LIMIT = 60;
  const DEBUG_LIMIT = 12;

  patchNetworkActivity();

  window.addEventListener("message", async (event) => {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== "scpi-to-llm-content") {
      return;
    }

    if (message.type === "GET_RECENT_ACTIVITY") {
      window.postMessage(
        {
          source: "scpi-to-llm-page",
          type: "GET_RECENT_ACTIVITY_RESULT",
          requestId: message.requestId,
          activity: getRecentActivity()
        },
        window.location.origin
      );
      return;
    }

    if (message.type === "FETCH_ARTIFACT") {
      const { requestId, payload } = message;
      try {
        const { buffer, finalUrl, attemptedUrls } = await fetchArtifact(payload);
        const base64 = arrayBufferToBase64(buffer);
        window.postMessage(
          {
            source: "scpi-to-llm-page",
            type: "FETCH_ARTIFACT_RESULT",
            requestId,
            filename: `${payload.artifactId}-${payload.version || "latest"}.zip`,
            dataBase64: base64,
            finalUrl,
            attemptedUrls
          },
          window.location.origin
        );
      } catch (error) {
        window.postMessage(
          {
            source: "scpi-to-llm-page",
            type: "FETCH_ARTIFACT_ERROR",
            requestId,
            error: buildDetailedError(error),
            activity: getRecentActivity()
          },
          window.location.origin
        );
      }
      return;
    }

    if (message.type === "FETCH_URL") {
      const { requestId, payload } = message;
      try {
        const response = await fetch(payload.url, {
          credentials: "include",
          headers: {
            Accept: "application/octet-stream,application/zip,*/*"
          }
        });
        if (!response.ok) {
          throw new Error(`Captured URL returned ${response.status} ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        window.postMessage(
          {
            source: "scpi-to-llm-page",
            type: "FETCH_ARTIFACT_RESULT",
            requestId,
            filename: payload.filename || "captured-artifact.zip",
            dataBase64: base64,
            finalUrl: payload.url,
            attemptedUrls: [payload.url]
          },
          window.location.origin
        );
      } catch (error) {
        window.postMessage(
          {
            source: "scpi-to-llm-page",
            type: "FETCH_ARTIFACT_ERROR",
            requestId,
            error: buildDetailedError(error),
            activity: getRecentActivity()
          },
          window.location.origin
        );
      }
    }
  });

  function buildArtifactUrl(payload) {
    const artifactId = encodeODataString(payload.artifactId);
    const version = encodeODataString(payload.version || "active");
    return [
      `${window.location.origin}/api/v1/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='${version}')/$value`,
      payload.packageId
        ? `${window.location.origin}/api/v1/IntegrationPackages('${encodeODataString(
            payload.packageId
          )}')/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='${version}')/$value`
        : "",
      `${window.location.origin}/itspaces/api/1.0/workspace.svc/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='${version}')/$value`
    ].filter(Boolean);
  }

  function encodeODataString(value) {
    return String(value).replace(/'/g, "''");
  }

  async function fetchArtifact(payload) {
    const attemptedUrls = [];

    const automatedDownloadUrl = await resolveArtifactDownloadUrlFromUi(payload, attemptedUrls);
    if (automatedDownloadUrl) {
      const response = await fetchBinary(automatedDownloadUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return { buffer, finalUrl: automatedDownloadUrl, attemptedUrls };
      }
      attemptedUrls.push(`${automatedDownloadUrl} -> ${response.status}`);
    }

    const resolvedDownloadUrl = await resolveArtifactDownloadUrl(payload, attemptedUrls);
    if (resolvedDownloadUrl) {
      const response = await fetchBinary(resolvedDownloadUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return { buffer, finalUrl: resolvedDownloadUrl, attemptedUrls };
      }
      attemptedUrls.push(`${resolvedDownloadUrl} -> ${response.status}`);
    }

    const urls = buildArtifactUrl(payload);
    for (const url of urls) {
      attemptedUrls.push(url);
      const response = await fetchBinary(url);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return { buffer, finalUrl: url, attemptedUrls };
      }
    }

    throw new Error(`No candidate endpoint worked.\n${attemptedUrls.join("\n")}`);
  }

  async function resolveArtifactDownloadUrlFromUi(payload, attemptedUrls) {
    if (!payload.artifactId) {
      return "";
    }

    const row = findArtifactRow(payload);
    if (!row) {
      attemptedUrls.push("ui: artifact row not found");
      return "";
    }

    const actionButton = findRowActionButton(row);
    if (!actionButton) {
      attemptedUrls.push("ui: action button not found");
      return "";
    }

    try {
      const nextWindowOpen = waitForNextWindowOpen({ suppress: true, timeoutMs: 15000 });

      clickElement(actionButton);
      attemptedUrls.push("ui: action button clicked");

      const menuItem = await waitForVisibleElement(
        () => findVisibleTextElement("Download", { includeMenuItems: true }),
        6000
      );
      clickElement(menuItem);
      attemptedUrls.push("ui: menu download clicked");

      await sleep(250);
      const dialogButton = findDialogDownloadButton();
      if (dialogButton) {
        clickElement(dialogButton);
        attemptedUrls.push("ui: dialog download clicked");
      }

      const interceptedUrl = await nextWindowOpen;
      if (interceptedUrl) {
        attemptedUrls.push(`ui: intercepted ${interceptedUrl}`);
        return interceptedUrl;
      }
    } catch (error) {
      attemptedUrls.push(
        `ui: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return "";
  }

  async function resolveArtifactDownloadUrl(payload, attemptedUrls) {
    const activity = getRecentActivity();
    const recentWindowOpenUrl = findRecentWindowOpenDownloadUrl(activity);
    if (recentWindowOpenUrl) {
      attemptedUrls.push(`captured:${recentWindowOpenUrl}`);
      return recentWindowOpenUrl;
    }

    const metadataUrl = `${window.location.origin}/api/1.0/contentpackage/${encodeURIComponent(
      payload.packageId
    )}/artifacts?$metadata=true&storage=workspace`;
    attemptedUrls.push(metadataUrl);
    const metadataResponse = await fetchText(metadataUrl);
    pushDebug({
      label: "metadata",
      url: metadataUrl,
      status: metadataResponse.status,
      text: metadataResponse.text
    });
    if (!metadataResponse.ok) {
      return "";
    }

    const metadataDirectUrl = findDownloadUrl(metadataResponse.text, payload);
    if (metadataDirectUrl) {
      return metadataDirectUrl;
    }

    const packageResourceIds = new Set(findPackageResourceIds(metadataResponse.text, activity));
    for (const packageResourceId of packageResourceIds) {
      const resourceInfoUrl = `${window.location.origin}/api/1.0/contentpackage/${packageResourceId}/artifacts?$resourceinfo=true`;
      attemptedUrls.push(resourceInfoUrl);
      const resourceInfoResponse = await fetchText(resourceInfoUrl);
      pushDebug({
        label: "resourceinfo",
        url: resourceInfoUrl,
        status: resourceInfoResponse.status,
        text: resourceInfoResponse.text
      });
      if (!resourceInfoResponse.ok) {
        continue;
      }

      const directUrl = findDownloadUrl(resourceInfoResponse.text, payload);
      if (directUrl) {
        return directUrl;
      }
    }

    const fallbackUrl = findDownloadUrl(metadataResponse.text, payload);
    return fallbackUrl || "";
  }

  async function fetchBinary(url) {
    return fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/octet-stream,application/zip,*/*"
      }
    });
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json,text/plain,application/xml,text/xml,*/*"
      }
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }

  function patchNetworkActivity() {
    if (window.__scpiToLlmPatched) {
      return;
    }
    window.__scpiToLlmPatched = true;
    window.__scpiToLlmRecentActivity = [];
    window.__scpiToLlmDebug = [];
    window.__scpiToLlmWindowOpenResolvers = [];

    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      const method = (init && init.method) || "GET";
      const url = typeof input === "string" ? input : input?.url || "";
      try {
        const response = await originalFetch.apply(this, arguments);
        pushActivity({
          source: "fetch",
          method,
          url: toAbsoluteUrl(url),
          status: response.status,
          ok: response.ok
        });
        return response;
      } catch (error) {
        pushActivity({
          source: "fetch",
          method,
          url: toAbsoluteUrl(url),
          status: 0,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__scpiToLlmMethod = method;
      this.__scpiToLlmUrl = toAbsoluteUrl(url);
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend() {
      const onLoadEnd = () => {
        pushActivity({
          source: "xhr",
          method: this.__scpiToLlmMethod || "GET",
          url: this.__scpiToLlmUrl || "",
          status: Number(this.status) || 0,
          ok: this.status >= 200 && this.status < 300
        });
        this.removeEventListener("loadend", onLoadEnd);
      };

      this.addEventListener("loadend", onLoadEnd);
      return originalSend.apply(this, arguments);
    };

    const originalWindowOpen = window.open;
    window.open = function patchedWindowOpen(url) {
      const absoluteUrl = toAbsoluteUrl(url);
      pushActivity({
        source: "window.open",
        method: "OPEN",
        url: absoluteUrl,
        status: 0,
        ok: true
      });

      const pending = (window.__scpiToLlmWindowOpenResolvers || []).shift();
      if (pending) {
        pending.resolve(absoluteUrl);
        if (pending.suppress) {
          return makeWindowStub();
        }
      }

      return originalWindowOpen.apply(this, arguments);
    };

    document.addEventListener(
      "click",
      (event) => {
        const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!anchor) {
          return;
        }

        pushActivity({
          source: "anchor",
          method: "CLICK",
          url: toAbsoluteUrl(anchor.href),
          status: 0,
          ok: true
        });
      },
      true
    );
  }

  function pushActivity(entry) {
    const normalized = {
      timestamp: new Date().toISOString(),
      source: entry.source || "unknown",
      method: entry.method || "GET",
      url: entry.url || "",
      status: Number.isFinite(entry.status) ? entry.status : 0,
      ok: Boolean(entry.ok),
      error: entry.error || ""
    };

    const current = window.__scpiToLlmRecentActivity || [];
    current.unshift(normalized);
    window.__scpiToLlmRecentActivity = current.slice(0, ACTIVITY_LIMIT);
  }

  function getRecentActivity() {
    return (window.__scpiToLlmRecentActivity || []).slice(0, ACTIVITY_LIMIT);
  }

  function waitForNextWindowOpen({ suppress = false, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const resolvers = window.__scpiToLlmWindowOpenResolvers || [];
      const entry = {
        suppress,
        resolve(url) {
          clearTimeout(timeoutId);
          resolve(url);
        }
      };
      const timeoutId = setTimeout(() => {
        const nextResolvers = (window.__scpiToLlmWindowOpenResolvers || []).filter(
          (item) => item !== entry
        );
        window.__scpiToLlmWindowOpenResolvers = nextResolvers;
        reject(new Error("ui: timeout waiting for SAP download window.open"));
      }, timeoutMs);
      resolvers.push(entry);
      window.__scpiToLlmWindowOpenResolvers = resolvers;
    });
  }

  function pushDebug(entry) {
    const current = window.__scpiToLlmDebug || [];
    current.unshift({
      timestamp: new Date().toISOString(),
      label: entry.label,
      url: entry.url,
      status: entry.status,
      snippet: String(entry.text || "").slice(0, 1200)
    });
    window.__scpiToLlmDebug = current.slice(0, DEBUG_LIMIT);
  }

  function findRecentWindowOpenDownloadUrl(activity) {
    const urls = activity
      .filter((entry) => entry.source === "window.open")
      .map((entry) => ({
        url: entry.url,
        timestamp: Date.parse(entry.timestamp || "")
      }))
      .filter((entry) => /\/api\/1\.0\/workspace\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/entities\/[0-9a-f]{32}/i.test(entry.url))
      .filter((entry) => Number.isFinite(entry.timestamp))
      .filter((entry) => Date.now() - entry.timestamp < 5 * 60 * 1000);

    return urls[0]?.url || "";
  }

  function findPackageResourceIds(text, activity) {
    const ids = new Set();

    for (const entry of activity) {
      const match = entry.url.match(/\/api\/1\.0\/contentpackage\/([0-9a-f]{32})\/artifacts\?\$resourceinfo=true/i);
      if (match) {
        ids.add(match[1]);
      }
    }

    for (const match of text.matchAll(/\/contentpackage\/([0-9a-f]{32})\/artifacts/gi)) {
      ids.add(match[1]);
    }

    for (const match of text.matchAll(/"(?:packageResourceId|contentPackageId|workspacePackageId)"\s*:\s*"([0-9a-f]{32})"/gi)) {
      ids.add(match[1]);
    }

    return Array.from(ids);
  }

  function findDownloadUrl(text, payload) {
    const fromJson = findDownloadUrlInJson(text, payload);
    if (fromJson) {
      return fromJson;
    }

    return findDownloadUrlInText(text, payload);
  }

  function findDownloadUrlInJson(text, payload) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "";
    }

    const matches = [];
    walkJson(parsed, [], (value, path) => {
      if (!value || typeof value !== "object") {
        return;
      }
      const flat = flattenObjectStrings(value).join(" ");
      const nameMatch = payload.artifactId
        ? flat.toLowerCase().includes(String(payload.artifactId).toLowerCase())
        : true;
      const versionMatch = payload.version
        ? flat.toLowerCase().includes(String(payload.version).toLowerCase())
        : true;
      if (!nameMatch || !versionMatch) {
        return;
      }

      const directUrl = extractWorkspaceUrlFromStrings(flattenObjectStrings(value));
      if (directUrl) {
        matches.push(directUrl);
        return;
      }

      const ids = extractWorkspaceIds(value);
      if (ids.workspaceId && ids.artifactId && ids.entityId) {
        matches.push(
          ensureAttachmentQuery(
            `${window.location.origin}/api/1.0/workspace/${ids.workspaceId}/artifacts/${ids.artifactId}/entities/${ids.entityId}`
          )
        );
      }
    });

    return matches[0] || "";
  }

  function findDownloadUrlInText(text, payload) {
    const escapedName = escapeRegExp(payload.artifactId || "");
    const escapedVersion = escapeRegExp(payload.version || "");
    const urlMatches = Array.from(
      text.matchAll(
        /https?:\/\/[^"'\\\s<]*\/api\/1\.0\/workspace\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/entities\/[0-9a-f]{32}[^"'\\\s<]*/gi
      )
    ).map((match) => ({ url: match[0], index: match.index || 0 }));

    if (urlMatches.length === 1) {
      return ensureAttachmentQuery(urlMatches[0].url);
    }

    if (!urlMatches.length) {
      const pathMatches = Array.from(
        text.matchAll(
          /\/api\/1\.0\/workspace\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/entities\/[0-9a-f]{32}[^"'\\\s<]*/gi
        )
      ).map((match) => ({ url: `${window.location.origin}${match[0]}`, index: match.index || 0 }));
      if (pathMatches.length === 1) {
        return ensureAttachmentQuery(pathMatches[0].url);
      }
      if (pathMatches.length > 1) {
        const best = chooseClosestUrl(pathMatches, text, escapedName, escapedVersion);
        return best ? ensureAttachmentQuery(best) : "";
      }
      return "";
    }

    const best = chooseClosestUrl(urlMatches, text, escapedName, escapedVersion);
    return best ? ensureAttachmentQuery(best) : "";
  }

  function chooseClosestUrl(matches, text, escapedName, escapedVersion) {
    const nameIndex = escapedName ? text.search(new RegExp(escapedName, "i")) : -1;
    const versionIndex = escapedVersion ? text.search(new RegExp(escapedVersion, "i")) : -1;
    const targetIndex = nameIndex !== -1 ? nameIndex : versionIndex;
    if (targetIndex === -1) {
      return matches[0]?.url || "";
    }

    const sorted = [...matches].sort(
      (left, right) => Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex)
    );
    return sorted[0]?.url || "";
  }

  function ensureAttachmentQuery(url) {
    const normalized = new URL(url, window.location.origin);
    if (!normalized.searchParams.has("attachment")) {
      normalized.searchParams.set("attachment", "true");
    }
    if (!normalized.searchParams.has("downloadOption")) {
      normalized.searchParams.set("downloadOption", "EXCL_CONF");
    }
    return normalized.toString();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function walkJson(value, path, visit) {
    visit(value, path);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkJson(item, path.concat(index), visit));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    Object.entries(value).forEach(([key, child]) => walkJson(child, path.concat(key), visit));
  }

  function flattenObjectStrings(value) {
    const strings = [];
    walkJson(value, [], (node) => {
      if (typeof node === "string") {
        strings.push(node);
      }
    });
    return strings;
  }

  function extractWorkspaceUrlFromStrings(strings) {
    for (const item of strings) {
      const match = String(item).match(
        /(?:https?:\/\/[^"'\\\s<]*)?\/api\/1\.0\/workspace\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/entities\/[0-9a-f]{32}[^"'\\\s<]*/i
      );
      if (match) {
        const raw = match[0].startsWith("http") ? match[0] : `${window.location.origin}${match[0]}`;
        return ensureAttachmentQuery(raw);
      }
    }
    return "";
  }

  function extractWorkspaceIds(value) {
    const result = {
      workspaceId: "",
      artifactId: "",
      entityId: ""
    };

    walkJson(value, [], (node, path) => {
      if (node == null) {
        return;
      }
      const key = String(path[path.length - 1] || "").toLowerCase();
      const text = String(node);
      if (!/^[0-9a-f]{32}$/i.test(text)) {
        return;
      }

      if (!result.workspaceId && /(workspace|package).*id/.test(key)) {
        result.workspaceId = text;
      }
      if (!result.artifactId && /artifact.*id/.test(key)) {
        result.artifactId = text;
      }
      if (!result.entityId && /entit.*id/.test(key)) {
        result.entityId = text;
      }
    });

    return result;
  }

  function buildDetailedError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(String(url), window.location.origin).toString();
    } catch {
      return String(url || "");
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function findArtifactRow(payload) {
    const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
    const desiredName = normalizeForMatch(payload.artifactId);
    const desiredVersion = normalizeForMatch(payload.version || "");

    const candidates = rows.filter((row) => {
      const text = normalizeForMatch(row.innerText || "");
      if (!text || !text.includes(desiredName)) {
        return false;
      }
      if (desiredVersion && !text.includes(desiredVersion)) {
        return false;
      }
      return /integration flow/i.test(row.innerText || "");
    });

    return candidates[0] || null;
  }

  function findRowActionButton(row) {
    const controls = Array.from(row.querySelectorAll('button, [role="button"]')).filter(isVisible);
    if (!controls.length) {
      return null;
    }

    const scored = controls.map((element) => ({
      element,
      score: scoreActionButton(element)
    }));
    scored.sort((left, right) => right.score - left.score);
    return scored[0]?.element || null;
  }

  function scoreActionButton(element) {
    const text = normalizeForMatch(
      [
        element.innerText,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.id,
        element.className
      ]
        .filter(Boolean)
        .join(" ")
    );

    let score = 0;
    if (/\.\.\.|more|action|menu|overflow/.test(text)) {
      score += 8;
    }
    if (element.getAttribute("aria-haspopup")) {
      score += 4;
    }
    if (/download|open|navigate|details|chevron|arrow/.test(text)) {
      score -= 3;
    }

    const rect = element.getBoundingClientRect();
    score += rect.x / 1000;
    return score;
  }

  function findVisibleTextElement(text, { includeMenuItems = false } = {}) {
    const selector = includeMenuItems
      ? 'button, [role="button"], [role="menuitem"], li, div, span'
      : 'button, [role="button"]';
    const target = normalizeForMatch(text);
    const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
    return (
      elements.find((element) => normalizeForMatch(element.innerText || "") === target) ||
      elements.find((element) => normalizeForMatch(element.innerText || "").includes(target)) ||
      null
    );
  }

  function findDialogDownloadButton() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);
    for (const dialog of dialogs) {
      const text = normalizeForMatch(dialog.innerText || "");
      if (!/download/.test(text)) {
        continue;
      }
      const button = Array.from(dialog.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .find((element) => normalizeForMatch(element.innerText || "") === "download");
      if (button) {
        return button;
      }
    }
    return null;
  }

  async function waitForVisibleElement(getElement, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = getElement();
      if (element) {
        return element;
      }
      await sleep(100);
    }
    throw new Error("ui: expected SAP control did not appear");
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
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

  function normalizeForMatch(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function makeWindowStub() {
    return {
      closed: false,
      close() {},
      focus() {},
      postMessage() {}
    };
  }
})();
