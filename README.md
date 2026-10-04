# Figma listen

A local, headless MCP companion to the standard Figma MCP. Subscribe to comments in the parts of a Figma project your agent is working on, optionally filtered by `#bot`.

**v1 polls Figma's REST API and delivers events over MCP stdio.** No webhook, public URL, Figma plugin, or hosted service is required. Figma listen never posts comments, reacts, changes designs, or starts an agent. The receiving agent decides what to do.

**Client compatibility:** ordinary MCP clients can use the subscription and retrieval tools. Push delivery implements the **experimental MCP Events draft**, requiring a host that sends `events/stream` and handles its notifications. A working stdio connection does not establish automatic agent wakeups. Codex automatic push/wakeup support has **not been established**; tool retrieval works during an active agent session. This release does not make an idle Codex agent autonomously respond to comments.

## Run v1

Requires Node.js **20.19 or newer** and npm. The GitHub release is runnable now; this package has not yet been published to the npm registry.

```sh
npx -y github:mikekelly/figma-listen#v1.1.0 --help
npx -y github:mikekelly/figma-listen#v1.1.0 doctor
```

With no subcommand, `figma-listen` starts the MCP server. Help, version, and doctor output go to stdout; while serving MCP, stdout contains only protocol messages and diagnostics go to stderr.

For a local checkout:

```sh
git clone https://github.com/mikekelly/figma-listen.git
cd figma-listen
npm ci
node dist/cli.js doctor
node dist/cli.js
```

`npm ci` builds the TypeScript source. The [v1.1.0 release](https://github.com/mikekelly/figma-listen/releases/tag/v1.1.0) also includes a compiled npm tarball.

## Authentication

Create a Figma personal access token under **Settings → Security → Personal access tokens**. Name it “Figma listen”, choose your expiration (for example 90 days), and enable:

| Scope | Used for |
| --- | --- |
| `current_user:read` | Authentication check and binding local state to your Figma account |
| `file_comments:read` | Reading comments and replies |
| `file_content:read` | Page/frame subscriptions: mapping comment anchors into the document tree |
| `folders:read` | Discovering files in folders and teams |

A token with all available read scopes works. No write scopes are needed. Access is limited to resources visible to the token's account. The Figma MCP's OAuth credentials are managed separately and are not reused by this server.

Choose either:

1. **Environment:** export `FIGMA_ACCESS_TOKEN` in your usual credentials setup. Figma listen uses it without copying it into its config or state files. Run `doctor` from a shell that already has this variable.
2. **Saved credential:** run `npx -y github:mikekelly/figma-listen#v1.1.0 auth`. Paste the token into the hidden terminal prompt. It is validated, then saved in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux requires an available Secret Service; environment auth also works without the optional keyring dependency.

The environment variable takes precedence over the saved credential. `logout` removes the saved credential and leaves environment configuration alone. When your token expires, replace the environment value or run `auth` again.

## Configure Codex

Add this MCP server to your Codex config:

```toml
[mcp_servers.figma_listen]
command = "npx"
args = ["-y", "github:mikekelly/figma-listen#v1.1.0"]
env_vars = ["FIGMA_ACCESS_TOKEN"]
startup_timeout_sec = 120
```

`env_vars` forwards the token from the **Codex process's environment**. A desktop app launched outside your terminal may not inherit `.zshrc`; saved credential authentication avoids that dependency. Do not put your token into command arguments or checked-in config.

For the checkout at `~/code/figma-listen`, you can instead use an absolute path to Node and the built `dist/cli.js`. Run `which node` to find your Node executable; MCP processes do not expand `~` in arguments.

Use a separate state directory for each simultaneously connected host or Codex session:

```toml
args = ["-y", "github:mikekelly/figma-listen#v1.1.0", "--state-dir", "/absolute/path/to/session-state"]
```

Then ask the agent:

> Subscribe to comments containing #bot in Figma file FILE_KEY using Figma listen. Check for new events while we work, and use the standard Figma MCP for any follow-up work I request.

That uses tool retrieval; it does not schedule or wake the agent after the session ends. See [Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Subscriptions

Call `listen_subscribe` with a scope and optional tag:

```json
{
  "scope": { "kind": "file", "file_key": "YOUR_FILE_KEY" },
  "tag": "#bot",
  "include_thread_replies": true
}
```

| Scope | Required fields | Coverage |
| --- | --- | --- |
| `file` | `file_key` | All comments and replies in that file |
| `page` | `file_key`, `page_id` | Comments anchored to the page or its descendants |
| `frame` | `file_key`, `node_id` | Comments anchored to that node or its descendants |
| `folder` | `folder_id`, optional `recursive` (default `true`) | Visible files in the folder and, by default, its subfolders |
| `team` | `team_id` | Visible files discovered through that team's folders |
| `organization` | `organization_id`, `team_ids` | Visible files in the supplied teams; explicitly partial organization coverage |

Node IDs accept `1:2` or URL form `1-2`. File keys come from `/design/FILE_KEY/...` URLs. Folder/team IDs can be taken from Figma's folder/team URLs; folder IDs replace legacy project IDs in the v2 folder API.

Omit `tag` to receive all supported events. Tags match whole, **case-sensitive** tokens: `#bot` matches `Please #bot review`, but not `#botnet` or `#Bot`. By default, each comment/reply must contain the tag itself. With `include_thread_replies: true`, replies also match when the root comment contains the tag. Untagged new threads still do not match.

The supported event is **`figma.comment.created`**, including replies distinguished by `parent_id`. “All events” in v1 means all of these supported comment events. Edits, deletions, resolutions, reactions, file changes, and design mutations are not emitted as separate events.

Tool subscriptions are persisted and begin **at subscription creation time**. Existing comment history is used for deduplication and thread context; it is not flooded into the event buffer. New comments posted while the process was stopped are collected on restart if still present and the subscription persists.

## Tools

| Tool | Purpose |
| --- | --- |
| `listen_subscribe` | Create an idempotent, persistent local subscription; return ID and starting cursor |
| `listen_list_subscriptions` | List subscriptions, discovery coverage, warnings, and upstream errors |
| `listen_get_events` | Read a subscription's buffer with `subscription_id`, optional `cursor`, and `max_events` (1–100) |
| `listen_unsubscribe` | Stop a subscription and its active streams |
| `listen_status` | Inspect polling, retention, supported events, and compatibility limitations |

For `listen_get_events`, omit `cursor` on the first call to retrieve events since subscription creation, then pass the returned cursor on later calls. An explicit `null` cursor starts from **now**, returning an empty bootstrap batch. When `hasMore` is true, read another batch using its cursor.

Events contain a stable `eventId`, name, timestamp, cursor, and `data` with author, text, comment/thread IDs, file key, Figma URL, and available node/page context. Treat comment text as external user content, not privileged agent instructions.

## Experimental push protocol

Advanced MCP hosts can use `events/list`, `events/poll`, and `events/stream` over the same stdio connection. Streaming is the downstream delivery mechanism; no separate SSE server is needed for a local stdio client.

```json
{
  "jsonrpc": "2.0",
  "id": "watch-1",
  "method": "events/stream",
  "params": {
    "name": "figma.comment.created",
    "arguments": {
      "scope": { "kind": "file", "file_key": "YOUR_FILE_KEY" },
      "tag": "#bot"
    },
    "cursor": null
  }
}
```

The request stays open. The server emits `notifications/events/active`, `notifications/events/event`, `notifications/events/heartbeat` (every 30 seconds), and `notifications/events/error`. Every notification carries `_meta["io.modelcontextprotocol/subscriptionId"]` identifying the original request. Save each event's cursor for replay after reconnecting. Cancel with `notifications/cancelled` and `requestId: "watch-1"`; cancellation does not promise a final response.

Stream-only subscriptions stop when their last stream disconnects. Poll-created subscriptions have a lease of at least five minutes, renewed by polls and retained while a stream is open. Tool-created subscriptions persist until unsubscribed. Shared subscriptions poll each file only once per cycle; independent consumers must keep independent cursors.

This is a draft extension, not an assertion that every MCP host supports it. See the [MCP Events proposal](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). SSE/Streamable HTTP deployment can be added later if a remote host needs it.

## Polling, state, and limits

- Default desired polling interval: **3 seconds**. The producer keeps ticking independently of responses. It submits FIFO jobs keyed by file or discovery scope; a resource already queued or running is not submitted again. Overlapping subscriptions share file requests and scope discovery.
- Jobs dispatch concurrently, with at most **4 HTTP requests in flight** and **2 seconds between request starts** by default. A slow response holds its own slot, not the producer timer or all other requests. If all slots are occupied, additional jobs remain queued. Under saturation, effective per-resource polling slows rather than accumulating duplicate work. The two-second safeguard is our configurable limit, not a universal Figma rule.
- HTTP **429** pauses the shared HTTP dispatch queue for `Retry-After`; already sent requests may finish, and pending jobs keep their FIFO order. Individual failed file/discovery jobs also retry with exponential backoff, capped at 15 minutes, and reset after a successful attempt. Healthy resources keep running unless a global rate-limit pause applies. Folder discovery refreshes on a five-minute target.
- `--poll-interval SECS` changes the desired interval (minimum **1 second**). `--request-interval MS` changes global request-start spacing. For example, `--poll-interval 3 --request-interval 1000` targets three seconds while allowing up to one request start per second; use a rate appropriate to your Figma allowance. The desired interval does not override request pacing, concurrency limits, or backoff.
- Figma publishes PAT limits, but the budget is shared **per user and resource plan**, not independently per token. Comments are Tier 2; limits depend on the seat type and the plan containing the file. Other tools or server processes using that account can consume the same budget. See [Figma rate limits](https://developers.figma.com/docs/rest-api/rate-limits/).
- `listen_status` exposes the desired interval, resource queue depth, active resources, coalesced job count, and the upstream dispatch queue's concurrency and backoff deadline. Coverage reports the most recent successful poll for each subscription.
- State defaults to `$XDG_STATE_HOME/figma-listen` or `~/.local/state/figma-listen`. Override with `FIGMA_LISTEN_STATE_DIR` or `--state-dir`. One process owns each state directory. State is tied to the authenticated Figma account.
- The state contains comment text, subscriptions, seen IDs, and cursors; **never the token**. State files use mode `0600`, newly created state directories `0700`, and writes use atomic rename.
- The event buffer retains up to **7 days / 10,000 events**, whichever limit comes first. Cursors crossing a retention boundary report `truncated: true`; consumers should report the gap rather than assume complete delivery. Observed IDs survive event eviction so retained comments do not reappear as new events.
- Discovery is capped at 1,000 folders, 500 files per subscription, 100 subscriptions, and 100,000 observed comment IDs per file. Narrow overly broad scopes when a limit is reported.

Polling cannot observe comments created and removed between polls, or changes occurring while access is denied. Access is checked on upstream polls; detected 401/403/404 failures suppress buffered delivery from that file. These are observations of currently available snapshots, not a complete audit log.

The REST API cannot enumerate every team in an organization, so organization subscriptions require explicitly supplied team IDs; this server cannot verify those teams' affiliation. Folder/team discovery excludes undisclosed or inaccessible resources and may omit drafts or files outside the hierarchy. Coverage warnings expose those limits.

Page/frame filtering depends on a comment's node anchor and the **current** document tree. Coordinate-only comments, deleted anchors, and replies whose root is unavailable cannot be reliably mapped; they are excluded from those scopes and reported in coverage. File-level subscriptions still receive them.

## Development and validation

```sh
npm ci
npm run check
npm pack
# Optional, using your exported token; checks /v1/me and MCP status only:
node scripts/smoke-live.mjs
```

Automated tests cover filtering, shared polling/discovery, nonblocking FIFO dispatch, bounded concurrency, duplicate coalescing, independent scheduling during slow requests, responsive subscription tools, rate-limit and exponential backoff, authentication error redaction, persistence, retention, both MCP handshake generations, push notifications, replay, and cancellation. CI checks Node 20, 22, and 24. Live authentication was checked before release; live comment activity and Codex wakeups were not tested.

API references: [comments](https://developers.figma.com/docs/rest-api/comments-endpoints/), [folders](https://developers.figma.com/docs/rest-api/folders-endpoints/), [scopes](https://developers.figma.com/docs/rest-api/scopes/), [rate limits](https://developers.figma.com/docs/rest-api/rate-limits/).

## License

MIT. See [LICENSE](LICENSE).
