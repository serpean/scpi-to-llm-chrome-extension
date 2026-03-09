export async function downloadBytes(bytes, filename, mimeType = "application/zip") {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    if (globalThis.chrome?.downloads?.download) {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false
      });
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return downloadId;
    }
  } catch {
    // Fall back to a regular anchor if the downloads API rejects the object URL.
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
  return null;
}
