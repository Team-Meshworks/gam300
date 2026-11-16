# Organisation directory integration

`OrganizationDirectory` receives only organisations, projects and accounts the current user is authorized to inspect. Its data types are UI adapters, not an API contract; the host and server own access control and authoritative data. Key the directory by identity or authorization context when mounting it. Selection is controlled by the host through `selectedId` and `onSelect`, so directory recovery cannot reset it independently of the data fetch. Organisation search persists on return to the list, while the keyed account list resets its query and role filter on a switch.

`AccountDirectoryPage` connects the administrator `/organisations` route to live directory, provisioning, profile override and lifecycle APIs. It loads cursor pages for the selected organisation and refetches an account before opening its details. `AccountDialog` reuses the shared native modal for creation and field-by-field overrides. Facilitator is the display label for the server's Educator role. The directory retrieves eligible initial passwords from the issuing administrator’s bulk-import receipt. Only the operation ID is saved in browser storage. Individual account reads omit credentials.

Project dialogs remain read-only through `onPreview`. The development preview uses fictional data and no backend. The directory retains the Inter font fallback for the Satoshi design. Organisation transfers are not offered.

`npm run test:accounts` checks browser interactions and responsive layout. The server's `AccountDirectoryBrowserTests` exercises creation, overrides, reload and sign-in through the real HTTPS API and disposable PostgreSQL database. Deploy the `AddBulkImportReceipts` migration with the receipt-aware API.
