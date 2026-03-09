# SCPI to LLM

Chrome extension for downloading a SAP Cloud Integration artifact and converting it into a single text file that is easier to consume with an LLM.

## Output

Each export generates a `*-llm-ready.txt` file with:

- a short functional summary of the Integration Flow
- a JSON section with the parsed flow metadata
- the textual source files concatenated with clear file boundaries

## Approach

The extension supports two paths:

1. Direct download from the active SAP tenant, triggered from the page so it can reuse the current session.
2. Manual fallback by importing a ZIP exported from SCPI if SAP changes the endpoint, the DOM, or the session no longer allows the direct request.

## Development

```bash
npm install
npm run build
```

The build output is written to `dist/`.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `/Users/serpean/m/scpi-to-llm/dist`.

## Usage

1. Open your SAP Integration Suite tenant in Chrome.
2. Navigate to the content package detail page where the Integration Flows are listed.
3. Open the `Actions` menu of a flow.
4. Click `To LLM`.

If the direct download fails, use the popup fallback and import the ZIP exported from SAP manually.

## Local Test

With the sample ZIP present in `example/`:

```bash
npm test
```

## Privacy

A store-ready privacy policy draft is available at [PRIVACY_POLICY.md](/Users/serpean/m/scpi-to-llm/PRIVACY_POLICY.md).

## Current Limitations

- Artifact detection in the SAP table relies on the visible DOM. If SAP changes the UI significantly, row detection may stop working correctly.
- The direct download path depends on the authenticated SAP session already being open in the browser.
- The parser summarizes BPMN, adapters, mappings, and scripts, but it does not semantically interpret the internal content of each `.mmap`.
