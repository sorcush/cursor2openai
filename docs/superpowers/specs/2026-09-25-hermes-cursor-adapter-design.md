# Hermes Cursor Adapter: Design

**Date:** 2026-09-25
**Status:** Revised after two independent reviews, a Cursor permissions spike, and a Hermes request probe; awaiting written-spec review
**Repository:** `sorcush/cursor2openai` (fork of `alfons-fhl/Cursor-Plan2API`)

## 1. Goal

Turn this repository into a small, secure adapter that lets Hermes Agent use a Cursor subscription as a custom model provider.

Hermes must behave on the Cursor provider the same way it behaves on the OpenAI provider for tool calls, streaming, screenshots, and multi-step tasks. The adapter must work for every Hermes task that a profile assigns to it: the main conversation, subagents (delegation), compression, title generation, and other auxiliary tasks.

### Success criteria

- Hermes can use the adapter as a named custom provider with the `chat_completions` transport, for any task in a profile.
- Hermes completes multi-step tool tasks with Cursor models. Every Hermes tool is run by Hermes, never by the adapter or Cursor.
- Streaming and non-streaming responses both work, including tool calls.
- Screenshots sent by Hermes reach the model.
- A model is selected by its exact Cursor name, which includes the effort level.
- On most steps of a continued Hermes conversation, the adapter sends only the new messages to Cursor. This also holds after the adapter restarts and after several days.
- The security checks in section 11 pass. `npm audit` reports zero vulnerabilities.

### Constraints

- Runs on macOS or Linux.
- Reachable from other machines on a local network.
- Started manually. Keeping it running is out of scope.
- Uses only documented Cursor CLI (`agent`) behavior.
- Personal use. One user, one Cursor login.

### Known limitations accepted for version 1

- **Reasoning text is not available.** Cursor suppresses thinking output in print mode for every output format ([Cursor output format](https://cursor.com/docs/cli/reference/output-format)). Hermes will not show the model's reasoning for this provider. The selected effort level still applies, because it is part of the model name.
- **Cursor's built-in tools are only partly locked down.** A permissions file blocks MCP tools, shell commands, writes, web fetches, and reads of the user's home folder. Some reads remain possible. See section 12.

## 2. Scope

### Kept

- `POST /v1/chat/completions`
- `GET /v1/models`

### Removed

Everything else in the repository is deleted:

- Anthropic Messages (`/v1/messages`) and Responses API (`/v1/responses`)
- Embeddings (`/v1/embeddings`) and the `@xenova/transformers` dependency
- Image generation (`/v1/images/generations`)
- Usage API (`/v1/usage`), macOS Keychain access, Dashboard API key bridge, cost estimates
- Health endpoint, admin page, request log stream, playground, OpenAPI endpoints
- Docker files, launchd and systemd templates, background daemon commands
- Agent pool, startup warm-up request, profile rotation
- Delegate mode, agent mode, plan mode and plan fast path, OpenCode prompts
- Adapter-side context compression, compact tool schemas, auto-continue, and the tool argument "fixer"
- Built-in model catalog, extra models, and model-name prefix removal
- Outbound HTTP proxy support
- SQLite session persistence and the existing session store
- The existing ad hoc test scripts, replaced by the tests in section 13

### Renaming

The package, command, and environment variable prefix are renamed to match the fork: package `cursor2openai`, command `cursor2openai`, variables `CURSOR2OPENAI_*`.

## 3. Approach

Each Hermes request starts a short-lived `agent` process in print mode. The adapter links each Hermes conversation to a saved Cursor session. When a request continues a known conversation, the adapter runs `agent --resume <session ID>` and sends only the new messages. Otherwise it starts a new Cursor session with the full conversation.

No `agent` process stays running between requests. A Cursor session is saved data plus an ID. The Cursor CLI stores sessions on local disk, grouped by workspace folder (`~/.cursor/chats/<workspace id>/<session id>`). For that reason the adapter always uses the same workspace folder.

The workspace folder is the adapter's own folder. It is never a project repository. It lives outside the user's home folder, in a permanent location, because the permissions file denies reads of the home folder and a deny rule would also block screenshots stored there (section 12).

The benefit claimed for this approach is smaller prompts on continued steps, measured as characters sent to Cursor. End-to-end speed of Cursor's responses is not measured and not claimed.

Rejected alternatives:

- **Trim and harden only.** Re-sends the whole conversation on every step.
- **One long-running `agent acp` process.** Depends on unproven behavior (pausing on a tool call while Hermes runs it). Can be explored later as a separate experiment.

## 4. Components

Each file has one job. File names use kebab-case.

| File | Job |
|---|---|
| `src/cli.ts` | Entry point. Loads configuration, runs startup checks, starts the server, handles shutdown. |
| `src/config.ts` | Loads and validates configuration from environment variables and an optional config file. |
| `src/server.ts` | HTTP or HTTPS server. Routes the two endpoints. Enforces API key, content type, size limit, server timeouts, and the request queue. |
| `src/log.ts` | Writes one metadata line per request. Never writes prompts, images, keys, or raw `agent` output unless debug logging is enabled. |
| `src/conversation/fingerprint.ts` | Builds the canonical form of messages and computes conversation keys. |
| `src/conversation/conversation-index.ts` | Maps conversation keys to Cursor session IDs and tool markers. One-time use, expiry, size cap, saved to disk. |
| `src/prompt/prompt-builder.ts` | Builds the full prompt or the continued prompt, including JSON response instructions. |
| `src/prompt/tool-protocol.ts` | Generates tool markers, writes tool instructions for the model, and parses tool-call blocks. |
| `src/prompt/stream-splitter.ts` | Splits streamed model output into text to send now, text to hold back, and tool-call blocks. |
| `src/images/attachments.ts` | Validates embedded images, saves them for one request, deletes them afterward. |
| `src/cursor/agent-runner.ts` | Starts `agent` with fixed flags and a minimal environment, parses and de-duplicates its stream output, stops it on disconnect or timeout. |
| `src/cursor/workspace-permissions.ts` | Builds the Cursor permissions file for the workspace, writes it, and verifies it before each run. |
| `src/cursor/error-classifier.ts` | Maps `agent` failures to OpenAI-style errors. |
| `src/cursor/model-list.ts` | Fetches and caches the list of models available to the Cursor login. |
| `src/openai/types.ts` | Request and response types for the Chat Completions format. |
| `src/openai/request-contract.ts` | Validates request fields and applies the rules in section 7. |
| `src/openai/response-writer.ts` | Writes non-streamed responses and streamed chunks in OpenAI format. |
| `src/openai/chat-completions.ts` | The request handler that connects the parts above. |

Runtime dependencies: `zod` and `yaml` only. The HTTP and HTTPS servers use Node's built-in modules.

## 5. Configuration

Environment variables override the optional file `<data folder>/config.yaml`. Requests can never change configuration.

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR2OPENAI_API_KEY` | none, required | Key Hermes must send. At least 32 characters. |
| `CURSOR2OPENAI_HOST` | `127.0.0.1` | Listening address. |
| `CURSOR2OPENAI_PORT` | `8787` | Listening port. |
| `CURSOR2OPENAI_TLS_CERT_FILE` | none | Certificate file. With the key file, enables HTTPS. |
| `CURSOR2OPENAI_TLS_KEY_FILE` | none | Private key file for HTTPS. |
| `CURSOR2OPENAI_ALLOW_INSECURE_HTTP` | `false` | Must be `true` to listen on a non-loopback address without HTTPS. |
| `CURSOR2OPENAI_DATA_DIR` | `~/.cursor2openai` | Holds the conversation index, model cache, and optional config file. Created with mode `0700`. |
| `CURSOR2OPENAI_WORKSPACE_DIR` | macOS: `/Users/Shared/cursor2openai`; Linux: `/var/lib/cursor2openai` | The folder `agent` runs in. Holds the Cursor permissions file and temporary screenshots. Must be outside the home folder, owned by the adapter's user, and mode `0700`. |
| `CURSOR2OPENAI_DEFAULT_MODEL` | `composer-2.5` | Used when a request names no model. |
| `CURSOR2OPENAI_AGENT_BIN` | `agent` | Path to the Cursor CLI. |
| `CURSOR2OPENAI_REQUEST_TIMEOUT_MS` | `600000` | Time limit for one `agent` run (10 minutes). |
| `CURSOR2OPENAI_MAX_CONCURRENT` | `4` | Maximum `agent` processes at once. |
| `CURSOR2OPENAI_MAX_QUEUED` | `16` | Maximum requests waiting for a free slot. |
| `CURSOR2OPENAI_QUEUE_TIMEOUT_MS` | `60000` | Maximum time a request waits for a free slot. |
| `CURSOR2OPENAI_CONVERSATION_TTL_DAYS` | `30` | Unused conversation entries expire after this many days. |
| `CURSOR2OPENAI_MAX_CONVERSATIONS` | `10000` | Maximum stored entries. Least recently used are removed first. |
| `CURSOR2OPENAI_MODEL_CACHE_MS` | `300000` | How long the model list is cached (5 minutes). |
| `CURSOR2OPENAI_MAX_BODY_BYTES` | `20971520` | Request size limit (20 MB). |
| `CURSOR2OPENAI_DEBUG_LOG_AGENT_OUTPUT` | `false` | When `true`, logs `agent` error output for local troubleshooting. It may contain prompt text. |

`CURSOR_API_KEY` is passed through to `agent` if it is set. Otherwise `agent` uses its own saved login.

Loopback addresses are `127.0.0.1`, `::1`, and `localhost`. Any other address counts as non-loopback.

## 6. Request flow

1. **Admit.** Verify the API key, content type, and size. If all `agent` slots are busy, wait in the queue. Reject with 503 if the queue is full or the wait exceeds the queue timeout.
2. **Validate.** Parse the body and apply the request rules (section 7). Verify the model is in the model list (section 10).
3. **Key.** Find the last assistant message. Compute the conversation key of all messages up to and including it (see "Conversation key" below).
4. **Look up.** Remove the matching entry from the conversation index. The adapter waits until a save that includes this removal has completed (see "Conversation index") before `agent` starts. Each entry is therefore used at most once, even if the process or the machine crashes.
5. **Run.**
   - **Entry found:** run `agent --resume <session ID>` with the continued prompt (section 8), using the tool marker stored in the entry.
   - **No entry, or no assistant message yet:** run `agent` without `--resume` with the full prompt and a new tool marker.
   - **Resume failed before any text was sent to Hermes:** retry once without `--resume` with the full prompt and a new tool marker. This applies only to failures classified as `upstream_error` (section 11). Other errors are returned to Hermes without a retry.
6. **Respond.** Stream or return the answer (section 9).
7. **Record.** On success, compute the conversation key of the request's messages plus the assistant reply exactly as it was returned to Hermes. Store the key with the session ID Cursor reported and the tool marker. Additions are saved in batches, at most once per second, and always at shutdown.

Nothing is recorded after a failure, a disconnect, a timeout, or a reply where extra tool calls were dropped (section 7). The next request starts fresh, because the saved Cursor session no longer matches what Hermes has.

### Conversation key

The key is the SHA-256 hash of a canonical JSON document (keys sorted, no extra spaces) containing:

- `affinity`: the value of the `X-Cursor2openai-Conversation` request header, or an empty string if the header is absent. Hermes sends this header when the provider sets `session_affinity_header` (section 14). It separates two Hermes conversations whose messages happen to be identical. Auxiliary requests (titles, compression) and subagents carry the same value as their parent conversation, so they are kept apart by their different messages, not by this value.
- `model`: the model name.
- `tools`: the request's tool definitions, in the order sent.
- `controls`: the effective values of the fields that change the prompt: `tool_choice` (missing means `auto`), `parallel_tool_calls` (missing means `true`), and `response_format` (missing means `text`).
- `messages`: each message in canonical form.

Canonical form of a message:

| Field | Rule |
|---|---|
| `role` | Kept exactly. `system` and `developer` stay distinct. |
| `content` | Kept exactly. A string stays a string. A list of parts keeps its order and part types. Text is not trimmed. Each image part is replaced by `{"type": "image_url", "sha256": <hash of the data address>}`. `null` becomes `""`, because Hermes stores empty content as `""` and sends it back that way (confirmed by the Hermes probe, section 14). |
| `tool_calls` | Kept in order, with `id`, `type`, `function.name`, and `function.arguments` exactly as strings. |
| `tool_call_id` | Kept exactly. |
| Anything else | Removed. This includes `name` (Hermes removes it from tool messages), `reasoning`, `reasoning_content`, and `reasoning_details`. |

This works because Hermes re-sends earlier messages byte-for-byte identical on every step, using the `api_content` sidecar, and rebuilds its system prompt only after compressing the conversation (Hermes source: `agent/turn_context.py`, "prompt-cache invariant"). The Hermes probe confirmed that the system prompt, the first user message, and the tool list were byte-identical between two steps (section 14).

A conversation that compresses its history, edits a message, changes model, changes its tool list, or changes one of the controls produces a different key, and correctly starts a fresh Cursor session.

### Conversation index

- Each entry holds a session ID, a tool marker, and a last-used time.
- Entries unused for longer than the expiry (default 30 days) are removed when the index loads and once per hour.
- At most `MAX_CONVERSATIONS` entries are kept. The least recently used are removed first.
- The index is saved to `<data folder>/conversations.json` with mode `0600`.
- One writer performs all saves, one at a time, in order. Each save writes the complete current index. A newer save can never be overwritten by an older one.
- Each save writes a temporary file, forces it to disk (`fsync`), renames it over the old file, and then forces the folder to disk. A process crash or a machine crash therefore never leaves a half-written file or loses a completed removal.
- A removal (section 6, step 4) triggers a save immediately and waits for it. Additions wait for the next batched save.
- If the file is missing or unreadable at startup, the adapter starts with an empty index and logs a warning.

## 7. Request rules

| Field | Rule |
|---|---|
| `model` | Honored. Must be an exact name from the model list. Missing means the default model. |
| `messages` | Honored. Must be a non-empty list. Roles `system`, `developer`, `user`, `assistant`, `tool`. |
| `stream` | Honored. |
| `stream_options.include_usage` | Honored when Cursor reports usage (section 9). |
| `tools` | Honored. Function tools only. Other tool types are rejected with 400. |
| `tool_choice` | `auto` or missing: normal. `none`: tools are not described to the model. `required`: the model is told it must request at least one tool. A named function: the model is told to request that function. The last two are instructions, not guarantees. |
| `parallel_tool_calls` | `false`: the model is told to request at most one tool. If it requests several anyway, only the first is returned, and the Cursor session is not recorded (section 6), because Cursor's saved reply no longer matches what Hermes received. Otherwise several calls are allowed. |
| `response_format` | `json_object` or `json_schema`: the model is told to answer only with JSON, matching the schema when one is given. The whole reply is collected before anything is sent, code fences around it are removed, and it is then sent as one piece, also for streamed requests. The reply is not validated. `text` or missing: normal. Hermes uses this for title generation (section 14). |
| `n` | Must be 1 or missing. Anything else is rejected with 400. |
| `reasoning_effort`, `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `user`, `metadata` | Accepted and ignored. The Cursor CLI has no options for them. Effort comes from the model name. |
| Any other field | Accepted and ignored. |

## 8. Prompts

### Full prompt

Sent for a new Cursor session. Contains, in order:

1. The tool protocol instructions with this session's tool marker, and the full tool list: each tool's name, description, and parameter schema. Omitted when there are no tools or `tool_choice` is `none`.
2. JSON response instructions, when `response_format` asks for JSON.
3. Hermes's system and developer messages.
4. The conversation, one block per message, labeled `User:`, `Assistant:`, `Assistant tool calls:`, or `Tool result (<tool name>, id <tool_call_id>):`. The tool name is found from the earlier assistant tool call with the same ID. A tool result with no matching call is labeled `Tool result (unknown tool, id <tool_call_id>):`.
5. Image references for every image still in the conversation (section 10).

### Continued prompt

Sent with `--resume`. Contains:

1. The messages after the last assistant message, in the same labeled format.
2. Image references for images in those messages only.
3. A one-line reminder of the tool-call format with this session's marker, when tools are present. The full tool list is not repeated.
4. JSON response instructions, when `response_format` asks for JSON.

The prompt is always sent through standard input, never as a command-line argument.

## 9. Tool calls and streaming

### Tool protocol

In ask mode, Cursor cannot call Hermes tools directly. The prompt tells the model to request tools in a block between two marker lines. Each Cursor session gets its own random marker, for example `TOOL_CALLS_7f3a9c2e`, stored in the conversation index so continued prompts use the same one:

```text
<TOOL_CALLS_7f3a9c2e>
[{"name": "read_file", "arguments": {"path": "notes.md"}}]
</TOOL_CALLS_7f3a9c2e>
```

Rules given to the model:

- Each marker must be on its own line.
- Normal text may come before the opening marker.
- At most one block per reply. Several tools may be requested inside that one block.
- Stop writing after the closing marker.
- Use only tools from the provided list.

Because the marker is random and must fill a whole line, it is unlikely to appear by accident when the model discusses tool calls or writes code. It is still possible, because the model sees the marker in its instructions.

### Parsing the block

- The block starts at the first line that is exactly the opening marker.
- It ends at the first line that is exactly the closing marker and after which the collected content parses as a JSON array. A closing marker inside a JSON string does not end the block early.
- Every item in the array must be an object with a non-empty string `name`. `arguments` must be an object, a string, or missing.
- If the block is invalid (no valid closing point by the end of the output, more than 1 MB, not a JSON array, or an item that breaks the rule above), no tool calls are returned. The block's text is sent to Hermes as normal text, finish reason is `stop`, and a warning is logged.
- Everything after the closing marker is dropped, including any further blocks. Its length is logged.

Only one block is ever turned into tool calls, and tool calls are sent only after the whole block has been checked. So tool calls never need to be taken back.

### Converting to OpenAI format

- Each tool call gets a new unique ID (`call_` plus 24 random characters). IDs written by the model are ignored.
- `function.arguments` is always sent as a string. An object is converted to JSON text. A string is sent unchanged. A missing value becomes `"{}"`.
- Tool calls with unknown names, or arguments that are not valid for the tool, are passed through. Hermes rejects them and reports the problem to the model, as it does with OpenAI.
- When tool calls are returned, `content` is the text written before the block, or `""` if there was none. It is never `null`, so the conversation key matches when Hermes sends the message back (section 6).
- Finish reason is `tool_calls` when tool calls are returned, otherwise `stop`.
- Events from Cursor's own tools are never forwarded.

### Reading Cursor's stream

With `--stream-partial-output`, Cursor emits three kinds of `assistant` events ([Cursor output format](https://cursor.com/docs/cli/reference/output-format)). The runner keeps only the first kind:

| `timestamp_ms` | `model_call_id` | Meaning | Action |
|---|---|---|---|
| Present | Absent | New text | Use |
| Present | Present | Duplicate flush before a tool call | Skip |
| Absent | Absent | Duplicate flush at end of turn | Skip |

The session ID comes from the `system` init event or the terminal `result` event.

### Streaming to Hermes

- Text is forwarded as `delta.content` as soon as it arrives, except for text the splitter holds back.
- The splitter holds back a line only while it could still become the opening marker. It sends the held text as soon as it cannot, or when the stream ends.
- After the opening marker, output is collected until the block ends (see "Parsing the block"). The calls are then sent as `delta.tool_calls` chunks, one per call, each with a stable `index`, the final `id`, the function name, and the full arguments.
- For requests with a JSON `response_format`, nothing is streamed early. The complete reply is sent as one `delta.content` chunk (section 7).
- The final chunk carries the finish reason. If usage was requested and is available, a separate chunk follows with `choices: []` and the `usage` object. The stream ends with `data: [DONE]`.
- Non-streamed requests use the same splitter and return one complete response.

### Token usage

Hermes treats reported usage as authoritative for tracking how full the context is. The documented `result` event contains no usage fields. So:

- If Cursor reports usage and, for continued sessions, the usage covers the whole conversation, it is returned.
- Otherwise usage is omitted from the response. Hermes then uses its own estimate. The adapter never reports estimated values.

Pre-implementation check 3 (section 15) determines which case applies.

### Disconnect

If Hermes closes the connection before the answer is complete, the adapter stops the `agent` process and records nothing.

## 10. Screenshots, models, and the Cursor process

### Screenshots

- Accepted only as `data:image/<png|jpeg|gif|webp>;base64,...` inside `image_url` parts.
- `file://` addresses and web addresses are rejected with 400.
- The base64 text must decode strictly, and the first bytes must match the declared image type.
- Maximum 5 MB per decoded image, 10 images per request, and 20 MB of decoded images per request.
- Images are saved as `<workspace>/attachments/<request ID>/image-<n>.<ext>`. The folder is created with mode `0700` and must not already exist. Each file is created with mode `0600` and must not already exist. The folder is deleted when the request ends.
- The prompt lists each image's path relative to the workspace and asks the model to view it.

### Model list

- Fetched with `agent --list-models` at startup and whenever the cached list is older than `MODEL_CACHE_MS`.
- Also saved to `<data folder>/models-cache.json`. If fetching fails, the saved list is used. If there is no saved list, chat requests and the model list return 503.
- `GET /v1/models` returns Cursor's model names exactly, in the OpenAI list format: `id`, `object: "model"`, `created`, `owned_by: "cursor"`.
- Effort is chosen by choosing the model name, for example `gpt-5.6-sol-high`. The adapter does not interpret `reasoning_effort`.
- Only exact names from the list are accepted. No prefix is removed. This also stops a crafted name such as `--force` from being read as a command-line option.

### How `agent` is run

Fixed arguments:

```text
agent --print --mode ask --trust --workspace <workspace folder>
      --model <model> --output-format stream-json --stream-partial-output
      [--resume <session ID>]
```

- Never `--force`, `--yolo`, `--approve-mcps`, or a workspace from a request.
- The workspace folder is set by `CURSOR2OPENAI_WORKSPACE_DIR`. It contains only the Cursor permissions file (section 12) and temporary screenshots. It is never a project repository. `--trust` applies only to it.
- Before each run, the adapter verifies that the permissions file exists with exactly the expected content, and rewrites it if not. The file is written to a temporary file in the same folder and then renamed.
- No part of the workspace path, and neither `.cursor` nor `attachments` inside it, may be a symbolic link. This matters on macOS, where `/Users/Shared` is writable by every local user, so another user could create a link in place of the adapter's folder.
- Environment passed to `agent`: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` if set, `CURSOR_API_KEY` if set, and `NO_COLOR=1`. Nothing else, and never the adapter's own API key.
- On timeout or disconnect, the adapter stops the `agent` process and every process it started.

### Startup checks

The adapter stops with a clear message if any of these fail:

1. The API key is set and at least 32 characters long.
2. A non-loopback address has HTTPS configured, or `ALLOW_INSECURE_HTTP` is `true`.
3. Both TLS files are set, or neither is. When set, both can be read.
4. `agent --version` succeeds.
5. `agent status` reports a logged-in user.
6. The data folder can be created with mode `0700` and written.
7. The workspace folder exists or can be created, is owned by the adapter's user, has mode `0700`, and can be written. On Linux the default location usually needs a one-time setup: `sudo install -d -o "$USER" -m 700 /var/lib/cursor2openai`. The startup message shows this command when the folder cannot be created.
8. No part of the workspace path is a symbolic link, and its real path equals the configured path. Checked without following links.
9. The workspace folder is not inside any folder the permissions file denies, such as the home folder. Otherwise screenshots would be unreadable.
10. The permissions file can be written into the workspace folder.
11. The model list can be fetched, or a saved list exists.

No model request is sent at startup. When `ALLOW_INSECURE_HTTP` is used, a warning is logged at every startup.

### Server timeouts

- Request headers must arrive within 10 seconds.
- The request body must arrive within 60 seconds.
- Idle keep-alive connections close after 5 seconds.

### Shutdown

On `SIGINT` or `SIGTERM`, the adapter stops accepting requests, waits up to 30 seconds for running requests, stops any remaining `agent` processes, and saves the conversation index.

## 11. Security and errors

### Security checks

Version 1 is complete when all of these are true. Each is covered by a test in section 13 or a startup check in section 10. They address the findings from the review of the original repository.

1. Every request requires the API key, compared in constant time. The adapter does not start without a key of at least 32 characters.
2. Non-loopback listening requires HTTPS unless `ALLOW_INSECURE_HTTP` is `true`.
3. No request field or header can select agent mode, a workspace, extra `agent` flags, or local file paths.
4. `agent` is never started with `--force`, `--yolo`, or `--approve-mcps`.
5. Model names are accepted only from the model list.
6. `file://` and web image addresses are rejected. The adapter makes no outbound network requests itself.
7. No CORS headers are sent. `OPTIONS` requests get 405.
8. Request size, image size, queue length, queue wait, and server timeouts are all limited.
9. The adapter's API key is never passed to `agent`.
10. Logs never contain prompts, images, keys, or raw `agent` output, unless debug logging is enabled.
11. The data folder is `0700`, and the conversation index and model cache inside it are `0600`. The workspace folder is `0700`, contains no symbolic links, and each screenshot folder and file inside it is `0700` and `0600`.
12. `npm audit` reports zero vulnerabilities, and runtime dependencies are limited to `zod` and `yaml`.
13. The Cursor permissions file (section 12) is present with the expected rules before every `agent` run.

### Log contents

One JSON line per request with: time, request ID, model, `fresh` or `continued`, the reason for a fresh start (`new`, `no-match`, `resume-failed`), status, error class if any, duration, characters sent to Cursor, characters of the full prompt, and token counts if available.

### Errors returned to Hermes

All errors use the OpenAI error body: `{"error": {"message", "type", "code"}}`. Messages are short and contain no stack traces, file paths, or `agent` output.

| Situation | Status | `code` |
|---|---|---|
| Invalid request, invalid image, unsupported field value | 400 | `invalid_request_error` |
| Wrong or missing API key | 401 | `invalid_api_key` |
| Model not in the list | 404 | `model_not_found` |
| Unknown path | 404 | `not_found` |
| Wrong method | 405 | `method_not_allowed` |
| Body too large | 413 | `request_too_large` |
| Cursor rate limit | 429 | `rate_limit_exceeded` |
| Cursor usage limit reached | 429 | `insufficient_quota` |
| Conversation too long for the model | 400 | `context_length_exceeded` |
| Queue full or queue wait exceeded | 503 | `server_busy` |
| Cursor CLI not logged in, or no model list | 503 | `service_unavailable` |
| Time limit reached | 504 | `timeout` |
| Any other `agent` failure | 502 | `upstream_error` |

- Cursor does not document its error codes. The error classifier recognizes cases from `agent` exit codes and error text. All patterns live in `error-classifier.ts` with tests built from real samples (check 4 in section 15). Unrecognized failures become 502.
- The adapter never retries rate-limited or failed requests itself. Hermes retries. The only automatic retry is the fresh retry after a failed resume (section 6).
- If a failure happens after streaming started, the adapter sends an error event in the stream and closes it.

## 12. Cursor's built-in tools and the permissions file

### The problem

Hermes runs every Hermes tool. However, the adapter can reach Cursor's models only through the `agent` program, which is Cursor's own coding assistant and has its own built-in tools. These tools run directly on the adapter's machine. Hermes never sees them, so Hermes's approvals, allowlists, and secret redaction do not apply to them.

A tool result from Hermes, such as the text of a web page, could contain hidden instructions. Those instructions could lead the model to use Cursor's tools: read a private file and include it in the reply, or call an MCP tool from the user's Cursor settings. Those MCP tools may be pre-approved in the user's global Cursor settings and may run commands or write files.

### The mitigation

The adapter writes a Cursor per-project permissions file, `<workspace folder>/.cursor/cli.json` ([Cursor permissions](https://cursor.com/docs/cli/reference/permissions)). It writes the file at startup and verifies it before every run (section 10). The file denies:

- `Shell(*)`: all shell commands
- `Write(**)` and `Write(/**)`: all file writes. Cursor's documentation says relative patterns apply only inside the workspace, so the absolute form is also needed. Ask mode already blocks writes, so these are a second layer.
- `WebFetch(*)`: all web fetches
- `Mcp(*:*)`: all MCP tools
- The user's home folder, under every spelling the adapter can compute: `Read(~/**)`, `Read(<HOME>/**)` with the value of `HOME`, `Read(<real path of HOME>/**)` if different, and on macOS `Read(/System/Volumes/Data<HOME>/**)`. The spike showed that `~` works, but Cursor does not document it, so the absolute forms are included too.
- System folders with secrets: `Read(/etc/**)` and `Read(/root/**)`, plus on macOS `Read(/private/etc/**)` and `Read(/System/Volumes/Data/private/etc/**)`.

The file has no allow rules, because allow rules do not restrict reads that are not listed, and deny rules always win over allow rules.

### Evidence from the spike on 2026-09-25 (macOS)

Tested with `agent --print --mode ask --trust --workspace <folder>` and `composer-2.5-fast`, checking Cursor's own tool events:

| Test | Without the file | With the file |
|---|---|---|
| Read a file outside the workspace | Read and returned | Blocked when its folder is denied |
| Read a file in the home folder | Read and returned | Blocked by `Read(~/**)` |
| Read a denied file through a relative path (`../`) | not tested | Blocked |
| Read a denied file through an alternate spelling (`/private/tmp` for `/tmp`) | not tested | **Read and returned** |
| View a screenshot in the workspace | Works | Works, when the workspace is not inside a denied folder |
| Shell `cat` after a denied read | not tested | Blocked by `Shell(*)` |
| Web fetch | not tested | Blocked |
| MCP tool pre-approved in global settings | not tested | Blocked by `Mcp(*:*)` |
| Deny all reads, allow only the screenshots folder | not applicable | Screenshot blocked: the deny wins |

### Remaining gap, accepted for version 1

- Files outside the denied folders remain readable, for example under `/tmp`, `/var`, `/opt`, `/Users/Shared`, and other system folders.
- A denied file can still be read through a path spelling the file does not list, or through a symbolic link that points into a denied folder. The rules compare path text, not the real file.
- Cursor may add new tools in future releases that the file does not cover.

**Recommendation in the README.** For complete protection, run the adapter under a separate operating-system user that has its own Cursor login, no MCP servers or rules in its Cursor settings, and no private files.

## 13. Testing

All automated tests use Node's built-in test runner. No automated test sends a real Cursor request.

### Unit tests

- Conversation key: canonical form rules, including `null` and `""` content producing the same key, content-part lists, images, tool-call IDs, removed fields, the affinity header, and each control changing the key.
- Two-step tool continuation: a tool-call reply returned by the adapter, then sent back in the exact shape Hermes used in the probe (`content: ""`, tool result with only `role`, `content`, and `tool_call_id`), produces a matching key.
- Conversation index: one-time use with the removal saved before the run, saves completing in order when a removal and a batched addition overlap, expiry, size cap, save and load, recovery from a corrupt file.
- Tool protocol: marker generation, a valid block, several calls in one block, text before the block, text and a second block after it (dropped), a closing marker inside a JSON string, missing closing marker, the 1 MB limit, items that are not objects or have no name, arguments as object, string, or missing.
- Stream splitter: markers split across chunks at every position, lines that resemble the marker but are not, output ending mid-marker.
- Stream reading: the three kinds of `assistant` events, session ID extraction.
- Request rules: every row of the table in section 7, including a JSON `response_format` reply sent as one piece with fences removed, and a `parallel_tool_calls: false` reply with several calls that is trimmed and not recorded.
- Prompt builder: tool-name lookup from tool-call IDs, unmatched tool results, JSON instructions, continued prompt contents.
- Response writer: non-streamed body, streamed chunks, stable tool-call indexes, usage chunk with `choices: []`, omitted usage, `[DONE]`.
- Error classifier: every row of the error table, from recorded `agent` output.
- Images: allowed types, strict base64, first-byte checks, size and count limits, rejected address types, file modes, cleanup.
- Configuration and startup checks: missing or short key, non-loopback without HTTPS, one TLS file only, environment overriding the file, workspace folder inside the home folder, wrong owner, wrong mode, a symbolic link anywhere in the workspace path or in place of `.cursor` or `attachments`.
- Workspace permissions: the generated rules for macOS and Linux, including every home-folder spelling, and detection of a changed or missing file.

### Integration tests

The whole adapter runs against a fake `agent` executable. The fake replays recorded stream output and records its arguments, standard input, and environment. Tests confirm that:

- Forbidden flags are never passed, and the workspace is always the configured workspace folder.
- The permissions file is written at startup with exactly the rules in section 12, and is restored before a run if it was changed or deleted.
- The adapter refuses to start when the workspace folder is inside the home folder, has the wrong owner, or has the wrong mode.
- A second request in the same conversation uses `--resume`, sends only the new messages, and uses the same tool marker.
- Two conversations with identical messages but different affinity headers never share a session.
- A retried or parallel request with the same key starts fresh.
- A failed resume is retried once as a fresh session, and a rate-limit failure is not retried.
- The adapter's API key is not in the environment given to `agent`.
- `agent` is stopped when the client disconnects or the time limit is reached. A fake `agent` that starts a child process confirms the child is stopped too.
- Continuation still works after the adapter restarts.
- If the adapter is killed after removing an entry but before `agent` finishes, a restarted adapter does not reuse that entry.
- Queue limits and server timeouts behave as specified.
- Streamed responses parse correctly with the official OpenAI Python SDK, the same client library Hermes uses.

### Manual end-to-end check

With real Hermes (using the configuration in section 14) and real Cursor:

1. A simple chat, streamed and not streamed.
2. A multi-step tool task.
3. A screenshot.
4. Switching models mid-conversation.
5. Restarting the adapter mid-conversation.
6. A conversation long enough for Hermes to compress its history.
7. Title generation and compression assigned to the Cursor provider.
8. A subagent (delegation) assigned to the Cursor provider.
9. The effort picker in Hermes Desktop for this provider is hidden or disabled.

During this check, the adapter log must show `continued` on normal steps. A `no-match` on a normal step means Hermes changed an earlier message, and the canonical form rules must be revisited.

### Performance measurements

These measure the adapter only, not Cursor.

| Measurement | Method | Target |
|---|---|---|
| Adapter processing time per request, excluding the time to start `agent` | Internal timestamps, benchmark against the fake `agent` | Under 10 ms |
| Delay between receiving output from `agent` and writing it to Hermes | Same benchmark | Under 5 ms per chunk |
| Share of continued steps | Adapter log during the manual check | Over 90% of steps after the first, excluding steps after compression |
| Prompt size on continued steps | Characters sent to Cursor compared with the full prompt | Reported for the manual check; no fixed target, because it depends on the task |

## 14. Hermes configuration

```yaml
providers:
  cursor:
    api: https://<adapter address>:8787/v1
    transport: chat_completions
    key_env: CURSOR2OPENAI_API_KEY
    default_model: composer-2.5
    session_affinity_header: X-Cursor2openai-Conversation

model_overrides:
  custom:                         # the name Hermes uses internally for named providers
    _default:
      supports_reasoning: false   # no effort sent; effort comes from the model name
      supports_vision: true       # send screenshots natively
  custom:cursor:                  # the name shown in pickers
    _default:
      supports_reasoning: false
      supports_vision: true

model:
  provider: custom:cursor
  default: composer-2.5
```

- The same key goes in Hermes's `.env` file as `CURSOR2OPENAI_API_KEY`.
- With a self-signed certificate, add `ssl_ca_cert: <path>` to the provider entry.
- Use `http://` only with `ALLOW_INSECURE_HTTP=true` on the adapter.
- Auxiliary tasks and delegation can point at the same provider with any Cursor model name.
- The overrides are needed under both names. A named provider such as `custom:cursor` runs internally as provider `custom`, and Hermes looks up these settings under that name (`hermes_cli/runtime_provider_custom.py`, `agent/reasoning_params.py`).

### Evidence from the Hermes probe on 2026-09-25 (macOS)

Hermes one-shot runs (`hermes -z`) were pointed at a recording HTTPS server with a self-signed certificate, using a throwaway `HERMES_HOME`. Screenshot routing was checked by calling Hermes's own decision function (`decide_image_input_mode`) with the same configuration, because one-shot mode does not attach images.

| What was checked | Overrides under `custom:cursor` only | Overrides under `custom` and `custom:cursor` |
|---|---|---|
| `reasoning_effort` on main requests | Sent (`medium`) | Not sent |
| Screenshot routing | `text` (images become descriptions) | `native` (images sent as `image_url`) |
| `X-Cursor2openai-Conversation` header | Sent | Sent |
| HTTPS with `ssl_ca_cert` | Works | Works |

Other recorded behavior:

- A tool-call reply returned with `content: null` came back as `content: ""`. The tool-call ID and the argument text came back unchanged.
- The system prompt (about 10,800 characters), the first user message, and the tool list were byte-identical between step 1 and step 2.
- The assistant message came back with only `role`, `content`, and `tool_calls`. The tool result had only `role`, `content`, and `tool_call_id`.
- Hermes often sends three helper tools (`tool_search`, `tool_describe`, `tool_call`) that load other tools on demand, instead of the full tool list. The adapter treats them as ordinary tools.
- Title generation sent a separate non-streamed request with a strict JSON schema in `response_format`, `reasoning_effort: "none"`, and the same conversation header.
- `GET /v1/models` was called without the conversation header.

## 15. Pre-implementation checks

Done with a few tiny real Cursor requests before any code is written:

1. `agent --resume <session ID>` works with the prompt on standard input, in a fixed workspace folder, from a new process.
2. Ask mode can view an image saved in the workspace folder.
3. Whether stream output includes token usage, and whether a continued session reports usage for the whole conversation.
4. Error output for an unknown model, a missing login, and a rate or usage limit if one can be produced, recorded as test samples.
5. `agent` runs with only the environment variables listed in section 10.
6. On Linux, the permissions file blocks the same things it blocked in the macOS spike (section 12): a home-folder read, a shell command, a web fetch, and an MCP tool, while a screenshot in the workspace stays readable. On both systems, an absolute-path write outside the workspace is blocked.
7. `agent --resume` still works after the workspace folder is deleted and recreated at the same path.
8. Hermes probe: done on 2026-09-25 on macOS, results in section 14. Repeat it on the machine where Hermes will run, with the final configuration.

If check 1, 2, or 6 fails, work stops and the design is revisited, because the approach depends on them.

If check 7 fails, the design stays the same. The adapter never deletes its workspace folder itself. The README states that deleting or moving the folder makes existing conversations start fresh once.

## 16. Other known limitations

- Cursor keeps saved sessions on disk and never deletes them. The adapter does not delete Cursor's internal files, because their layout is not documented.
- Whether Cursor can resume a session that is several days old is not confirmed. If it cannot, the fresh retry keeps the conversation working at the cost of one slower step.
- Each step still starts a new `agent` process and loads the saved session.
- `tool_choice`, `parallel_tool_calls`, and `response_format` are followed through instructions to the model, so compliance is likely but not guaranteed.
- Error recognition depends on `agent` error text, which may change between Cursor releases.
