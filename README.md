# PingRoom team checklist starter

Send a fixed checklist to a team, then export a local receipt when every item has been checked in PingRoom. Each item records the UUID and timestamp of its first checker. Use it for human verification steps such as following an installation guide or checking a handover package.

Checking an item is shared, permanent room state: one person's check completes that item for everyone. The same person may check every item. This records what people reported doing; it does not establish a quorum, approve an action, prove physical work, or run tasks.

## Try it offline

Requires Node.js 22 or newer. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo publishes a simulated checklist, shows partial progress, exports a completion receipt, and repeats publication without another send. It uses the real SDK with an in-memory HTTP transport, reads no credentials, makes no network requests, and removes its temporary files. Installation needs npm access.

## Connect a team room

1. [Install PingRoom](https://pingroom.io/i). You and a teammate must belong to the same **standard private room**.
2. Run `npm run connect` and approve the printed link, granting that room. If it differs from your connection's home room, use `npm run connect -- --room ROOM_CODE`.
3. Edit `checklist.json`. Keep the ID and content fixed after publication.
4. Run `npm start` once. Teammates open the ping in PingRoom and check items after completing them.
5. Run `npm run check` to read progress. Once all items are checked, the receipt is saved to `receipts/<checklistId>.json`.

```json
{
  "checklistId": "guide-042",
  "title": "Check the onboarding guide",
  "items": [
    "Verify the installation steps",
    "Check the troubleshooting links"
  ]
}
```

IDs use 1–64 letters, digits, `_` or `-`, starting with a letter or digit. Titles allow 1–40 printable ASCII characters. Supply 1–25 distinct items of 1–80 printable ASCII characters each. Leading and trailing spaces are rejected to avoid server trimming. ASCII avoids Unicode-size differences. Input files are limited to 16 KiB. Structured data is checked against the server's 8 KiB JSON limit.

The connecting account needs permission to send: room owner/admin, or a room where everyone may trigger. The connection needs `pingroom:broadcast:send`, `pingroom:notifications:read`, `pingroom:rooms:read`, and the selected room grant. Pairing grants are server-controlled. Sending quotas apply. Every first item check also alerts the other recipients and sender; keep lists short.

Pairing saves ignored `.pingroom/credentials.json`. For environment setup, copy `.env.example` to `.env` and fill both values. Shell variables take precedence. A complete `PINGROOM_TOKEN` and `PINGROOM_ROOM` pair overrides saved credentials; a partial or blank pair fails. Room codes become uppercase. `CHECKLIST_FILE`, `STATE_DIR`, and `RECEIPT_DIR` customize paths. Relative paths and `.env` resolve from this project, regardless of the current directory.

## Resume and recover

`npm start` reuses the saved publication. `npm run check` makes one fresh read, validates the room, original payload, and every tick, then returns `pending` or `complete`. It never checks items on anyone's behalf. Run it manually or from your existing scheduler; space scheduled checks at least a minute apart. Each SDK request has a five-second timeout. A normal check makes two requests and can take about ten seconds.

Before sending, the script saves its exact request and correlation ID. A lost response or interrupted send leaves `send_unknown`; rerunning sends nothing. Find the existing notification, then explicitly attach its UUID:

```sh
npm run find-id
npm run check -- --attach-id NOTIFICATION_UUID
```

The finder scans up to five pages of recent visible history. Free history may be limited to the latest 100 notifications across granted rooms. Results are candidates; absence never proves creation failed. Recovery verifies the full saved checklist, room, and correlation ID. If no ID is found, investigate in the app and preserve local state. Do not delete state and resend: this starter does not guarantee exactly-once delivery. Send errors also leave uncertain state.

A missing notification, revoked grant, public room, malformed tick, or redacted actor produces an error. Existing receipts remain historical records; they are never used to claim a current check succeeded. A fresh incomplete read returns `pending` even if an older receipt remains. Receipts are created atomically, and different contents are never overwritten. Changed work needs a new checklist ID; changing a token or room also requires reviewing the saved binding.

Only one process may use a state directory. After a crash, confirm no process is using it before removing `.checklists/.lock`. Keep state and receipts together when archiving; the directory allows at most 100 checklist IDs. Corrupt state requires a valid backup. Files use `0600` and directories `0700` on POSIX; keep equivalent private permissions on Windows. Receipts contain checklist details and human UUIDs.

Exit codes: `0` published, already published, complete, or finder output; `2` pending; `3` uncertain send; `1` input, storage, access, or API error. Use the returned `status` field when interpreting output.

## Adapt it

Import `runChecklist` from `src/checklist.js` and pass a validated checklist, SDK client, connection, storage paths, and `operation: 'publish'` or `'check'`. Convert your work manifest into this input shape and read the completion receipt as data. Keep external actions in your application with their own policy and idempotency. This starter contains no deployment or ticket-system action.

[SDK documentation](https://github.com/pingroom/sdk) · [Job progress starter](https://github.com/pingroom/starter-job-progress) · [Task claim starter](https://github.com/pingroom/starter-task-claim)

SDK `0.6.0` is pinned with a lockfile under the 14-day release-age policy. CI runs tests and the offline demo on Node.js 22 and 24. Mocks verify application behavior, not live phone delivery. MIT licensed; see [LICENSE](LICENSE).
