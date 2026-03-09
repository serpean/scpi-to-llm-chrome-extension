# SCPI to LLM

Chrome extension for downloading a SAP Cloud Integration artifact and converting it into a bundle that is easier to consume with an LLM.

## Approach

The extension supports two paths:

1. Direct download from the active tenant through the design-time endpoint `IntegrationDesigntimeArtifacts(...)/$value`, triggered from the page itself so it can reuse the current session.
2. Manual fallback by importing a ZIP exported from SCPI if SAP changes the endpoint, the DOM, or the session no longer allows the direct request.

The output is a `*-llm-ready.zip` file containing:

- `README.md` with a functional summary of the flow.
- `summary/flow.json` with metadata, parameters, adapters, and BPMN steps.
- `source/...` with the artifact text files normalized and, when applicable, formatted.

## Development

```bash
npm install
npm run build
```

The build outputs the extension into `dist/`.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `/Users/serpean/m/scpi-to-llm/dist`.

## Usage

1. Open your SAP Integration Suite tenant in Chrome.
2. Navigate to the artifact view of the content package.
3. If you want to enable the operational popup locally, set the debug flag in the extension popup console:

```js
localStorage.setItem("scpi-to-llm:popup-debug", "1");
```

4. Open the extension popup.
5. Select the detected Integration Flow.
6. Click `Download for LLM`.

If the direct download fails, use `Manual fallback` with the ZIP exported from SAP.

## Local test

With the sample ZIP present in `example/`:

```bash
npm test
```

## Current limitations

- Artifact detection in the SAP table relies on the visible DOM; if SAP changes the UI significantly, row detection may stop working correctly.
- The direct download assumes the tenant allows `GET /api/v1/IntegrationDesigntimeArtifacts(Id='...',Version='...')/$value` with the current session already open.
- The parser summarizes BPMN, adapters, mappings, and scripts, but it does not semantically interpret the internal content of each `.mmap`.
