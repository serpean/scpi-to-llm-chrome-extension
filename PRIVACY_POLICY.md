# Privacy Policy for SCPI to LLM

Last updated: March 9, 2026

## Overview

SCPI to LLM is a Chrome extension that helps a user export SAP Cloud Integration artifacts from an authenticated SAP Integration Suite session and convert them into a local `.txt` file prepared for use with large language models.

## Data Handling

SCPI to LLM does not sell personal data.

SCPI to LLM does not use personal data for advertising.

SCPI to LLM does not transfer user data to third parties, except when the user is already interacting directly with their own SAP tenant in the browser.

SCPI to LLM does not use remote code.

SCPI to LLM does not collect analytics, tracking identifiers, browsing history outside the supported SAP pages, or marketing data.

## What The Extension Accesses

The extension accesses the following information only to perform its core function:

- The currently open SAP Integration Suite page on `*.hana.ondemand.com`
- Artifact metadata visible on the page, such as artifact name, type, and version
- The artifact export file downloaded from the user's SAP tenant

## How The Data Is Used

The extension uses this information only to:

- identify the selected SAP Integration Flow
- request the artifact export from the authenticated SAP tenant
- transform the artifact into a local LLM-ready `.txt` file
- save the resulting file through the browser download flow

## Local Processing

Artifact contents are processed locally in the browser extension.

The generated `.txt` file is saved locally through Chrome's downloads API.

The extension does not intentionally send artifact content to external servers operated by the extension publisher.

## Permissions Explanation

`activeTab`

Used to interact with the current SAP page the user has open.

`downloads`

Used to save the generated `.txt` export to the user's device.

`https://*.hana.ondemand.com/*`

Used so the extension can operate on supported SAP Integration Suite pages and request artifact exports from the active tenant session.

## Data Retention

The extension does not maintain a remote database of user data.

Any exported files remain under the user's control on their local machine and follow the user's browser and operating system storage behavior.

## Security

The extension is designed to process data locally and minimize access to only the SAP pages required for its single purpose.

Users should still review generated exports before sharing them with any LLM or external system, because SAP artifacts may contain business logic, configuration details, or other sensitive information.

## Changes To This Policy

This privacy policy may be updated if the extension's functionality or data handling changes.

Material changes should be reflected in an updated policy date and, where required, in the Chrome Web Store listing.

## Contact

Publisher contact: replace this line with your public support email before publishing.
