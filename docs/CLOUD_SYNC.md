# Cloud Sync

OmniRoute can mirror your local configuration (provider connections, combos, API keys, model aliases) to a remote OmniRoute control plane so multiple devices stay in lock-step. **It's entirely optional.** OmniRoute works fully local; this doc only matters if you want fleet management.

## TL;DR — turn it on from the dashboard

1. Go to **Dashboard → Endpoints**.
2. Scroll to the **Endpoint** card. If cloud sync isn't configured, you'll see an inline "Set up cloud sync" panel.
3. Paste your cloud URL (e.g. `https://omniroute-cloud.example.com`) and click **Save**.
4. Click **Enable sync** in the row above. You should see "Using Cloud Proxy" within a second or two.

That's it. No env edits, no restarts.

## What gets synced

The sync bundle includes:

- Provider connections (encrypted-at-rest values are re-encrypted with the cloud's key during upload).
- Combo definitions and the active routing strategy.
- API key records (hash only — raw keys never leave the device).
- Model aliases / wildcards.
- A version hash so the cloud can detect drift.

Logs, prompts, request bodies, and usage history do **not** sync. Only the configuration plane.

## Resolution order

The effective cloud URL is resolved in this order:

| Source              | Editable in UI? | Use case                          |
| ------------------- | --------------- | --------------------------------- |
| `CLOUD_URL` env     | No              | Operators pinning at deploy time  |
| `NEXT_PUBLIC_CLOUD_URL` env | No      | Legacy alias for `CLOUD_URL`      |
| `settings.cloudUrl` (DB) | Yes — Settings → Endpoint → "Set up cloud sync" | End-user configures from dashboard |

If you set `CLOUD_URL` in env, the in-dashboard editor is hidden (the env value wins). To make the dashboard the source of truth, unset both env vars and let users configure via the UI.

## How to disable

Click **Disable cloud** on the Endpoints page. The next push is suppressed; future sync attempts stop. The persisted `cloudUrl` is kept so you can re-enable later — clear it manually in Settings if you want to wipe it entirely.

## What about my data on the cloud?

The cloud control plane is **your responsibility** — OmniRoute itself does not run a hosted service. The `CLOUD_URL` you point at should be an instance you control (e.g. omnirouteCloud / a custom build / a partner deployment).

If you need to revoke access:

1. Disable sync from the dashboard (see above).
2. Rotate `STORAGE_ENCRYPTION_KEY` so any stale ciphertext the cloud holds cannot be decrypted by a future leak of your old key.
3. Optionally regenerate every API key from the dashboard so existing tokens are useless.

## API surface

| Endpoint                   | Method   | Purpose                                                                                 |
| -------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `/api/sync/cloud`          | `GET`    | Returns `{ enabled, connected, syncing, lastSync }` so the sidebar icon stays accurate. |
| `/api/sync/cloud`          | `POST`   | `{ action: "enable" | "sync" | "disable" }` — drives the toggle from the dashboard.     |
| `/api/sync/bundle`         | `POST`   | The cloud control plane fetches the latest config bundle here (sync-token auth).        |
| `/api/sync/initialize`     | `POST`   | First-run handshake with the cloud.                                                     |
| `/api/sync/tokens`         | `GET/POST` | Manage the sync tokens that the cloud uses to authenticate to this instance.          |
| `/api/cloud/auth`          | `POST`   | The cloud verifies an API key issued by this instance.                                  |
| `/api/cloud/credentials/update` | `PUT` | The cloud pushes a refreshed provider credential back (manage-scope required).         |

Audit log entries for every cloud-affecting action land in `mcp_tool_audit` and `audit_events`. See `/dashboard/audit`.

## Troubleshooting

| Symptom                              | Cause                                                                                                         | Fix                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| "Cloud sync needs a URL first"       | The toggle was clicked before the URL was saved.                                                              | Fill in the URL field below the toggle and click Save first.                          |
| "Couldn't save (HTTP 400)"           | The URL didn't parse as `https://…` or `http://…`.                                                            | Include the scheme; trailing slashes are stripped automatically.                      |
| "Couldn't save (HTTP 401/403)"       | Your session lapsed or your API key lost `manage` scope.                                                       | Log back into the dashboard.                                                          |
| Sidebar icon stays at "Cloud Off"    | `cloudEnabled` is true but the cloud is unreachable. Check `/api/sync/cloud` GET in DevTools for `connected`. | Verify the URL is correct; check the cloud's logs.                                    |
| Sync is slow                         | `CLOUD_SYNC_TIMEOUT_MS` (default 12 s) caps each round-trip; long bundles can exceed it.                       | Raise the env var or shrink your provider list.                                       |
| You set `CLOUD_URL` in env but the dashboard still shows the editor | The dashboard prefers env. Make sure the env was actually loaded by the running process. | Run `npm run doctor` to confirm env state.                                            |

## Related env vars

See [`docs/ENVIRONMENT.md`](ENVIRONMENT.md) for full reference. The most relevant:

| Variable                     | Default     | Effect                                                                          |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `CLOUD_URL`                  | _unset_     | Pin the cloud URL at the env layer (highest precedence).                        |
| `NEXT_PUBLIC_CLOUD_URL`      | _unset_     | Same as above; kept for backwards compatibility.                                |
| `CLOUD_SYNC_TIMEOUT_MS`      | `12000`     | Per-request timeout for sync round-trips.                                       |
| `STORAGE_ENCRYPTION_KEY`     | required in production | Encrypts provider credentials before they hit the cloud bundle.        |
