# Hermes Cursor Adapter: Design

**Date:** 2026-09-25
**Status:** Approved in conversation, awaiting written-spec review
**Repository:** `sorcush/cursor2openai` (fork of `alfons-fhl/Cursor-Plan2API`)

## 1. Goal

Turn this repository into a small, secure adapter that lets Hermes Agent use a Cursor subscription as a custom model provider.

Hermes must behave on the Cursor provider the same way it behaves on the OpenAI provider. That includes tool calls, streaming, screenshots, and multi-step tasks.

### Success criteria

- Hermes can be configured with the adapter as a named custom provider using the `chat_completions` transport.
- Hermes completes multi-step tool tasks with Cursor models. Hermes runs every tool. Cursor never runs Hermes tools or changes the machine.
- Streaming works, including streamed tool calls and token usage.
- Screenshots sent by Hermes reach the model.
- Continuing a Hermes conversation sends only new messages to Cursor on most steps, including after the adapter restarts and after several days.
- All security issues found in the review of the original repository are fixed. `npm audit` reports zero vulnerabilities.

### Constraints

- Runs on macOS or Linux.
- Reachable from other machines on a local network.
- Started manually. Keeping it running is out of scope.
- Uses only documented Cursor CLI (`agent`) behavior.
- Personal use. One user, one Cursor login.

## 2. Scope

### Kept

- `POST /v1/chat/completions`
- `GET /v1/models`

### Removed

Everything else in the repository is deleted:

- Anthropic Messages (`/v1/messages`), Responses API (`/v1/responses`)
- Embeddings (`/v1/embeddings`) and the `@xenova/transformers` dependency
- Image generation (`/v1/images/generations`)
- Usage API (`/v1/usage`), macOS Keychain access, Dashboard API key bridge, cost estimates
- Admin page, request log stream, playground, OpenAPI endpoints
- Health endpoint details (see section 9 for the replacement startup checks)
- Docker files, launchd and systemd templates, background daemon commands
- Agent pool, startup warm-up request, profile rotation
- Delegate mode, agent mode, plan mode and plan fast path, OpenCode prompts
- Adapter-side context compression, compact tool schemas, auto-continue, tool argument "fixer", JSON mode
- Built-in model catalog and extra models; outbound HTTP proxy support
- SQLite session persistence and the existing session store
- The existing ad hoc test scripts, replaced by the tests in section 11

### Renaming

The package, binary, and environment variable prefix are renamed to match the fork: package `cursor2openai`, binary `cursor2openai`, variables `CURSOR2OPENAI_*`.

## 3. Approach

Each Hermes request starts a short-lived `agent` process in print mode. The adapter links each Hermes conversation to a saved Cursor session. When a request continues a known conversation, the adapter runs `agent --resume <session ID>` and sends only the new messages. Otherwise it starts a new Cursor session with the full conversation.

No `agent` process stays running between requests. A Cursor session is saved data plus an ID. The Cursor CLI stores sessions on local disk, grouped by workspace folder (`~/.cursor/chats/<workspace id>/<session id>`). For that reason the adapter always uses the same workspace folder.

Rejected alternatives:

- **Trim and harden only.** Re-sends the whole conversation on every step. Simpler, but long tasks stay slow.
- **One long-running `agent acp` process.** Might be faster and support native tool calls, but depends on unproven behavior (pausing on a tool call while Hermes runs it). Can be explored later as a separate experiment.

## 4. Components

Each file has one job. File names use kebab-case.

| File | Job |
|---|---|
| `src/cli.ts` | Entry point. Loads configuration, runs startup checks, starts the server, handles shutdown. |
| `src/config.ts` | Loads and validates configuration from environment variables and an optional config file. |
| `src/server.ts` | HTTP or HTTPS server. Routes the two endpoints. Enforces API key, content type, and size limit. |
| `src/log.ts` | Writes one metadata line per request. Never writes prompts, images, or keys. |
| `src/conversation/fingerprint.ts` | Cleans up messages and computes fingerprints. |
| `src/conversation/conversation-index.ts` | Maps fingerprints to Cursor session IDs. One-time use, expiry, size cap, saved to disk. |
| `src/prompt/prompt-builder.ts` | Builds the full prompt or the continued prompt. |
| `src/prompt/tool-protocol.ts` | Tool instructions for the model, and the parser for tool-call markers. |
| `src/prompt/stream-splitter.ts` | Splits streamed model output into text to send now, text to hold back, and tool-call blocks. |
| `src/images/attachments.ts` | Validates embedded images, saves them for one request, deletes them afterward. |
| `src/cursor/agent-runner.ts` | Starts `agent` with fixed flags and a minimal environment, parses its stream output, stops it on disconnect or timeout. |
| `src/cursor/error-classifier.ts` | Maps `agent` failures to OpenAI-style errors. |
| `src/cursor/model-list.ts` | Fetches and caches the list of models available to the Cursor login. |
| `src/openai/types.ts` | Request and response types for the Chat Completions format. |
| `src/openai/response-writer.ts` | Writes non-streamed responses and streamed chunks in OpenAI format. |
| `src/openai/chat-completions.ts` | The request handler that connects the parts above. |

Runtime dependencies: `zod` and `yaml` only. The HTTP and HTTPS servers use Node's built-in modules.

## 5. Configuration

Environment variables override the optional file `<data folder>/config.yaml`. Requests can never change configuration.

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR2OPENAI_API_KEY` | none, required | Key Hermes must send. At least 32 characters. |
| `CURSOR2OPENAI_HOST` | `127.0.0.1` | Listening address. Set to `0.0.0.0` or a LAN address to accept network connections. |
| `CURSOR2OPENAI_PORT` | `8787` | Listening port. |
| `CURSOR2OPENAI_DATA_DIR` | `~/.cursor2openai` | Holds the workspace folder, the fingerprint file, the model cache, and the optional config file. |
| `CURSOR2OPENAI_DEFAULT_MODEL` | `composer-2.5` | Used when a request names no model. |
| `CURSOR2OPENAI_AGENT_BIN` | `agent` | Path to the Cursor CLI. |
| `CURSOR2OPENAI_REQUEST_TIMEOUT_MS` | `600000` | Time limit per request (10 minutes). |
| `CURSOR2OPENAI_MAX_CONCURRENT` | `4` | Maximum `agent` processes at once. Extra requests wait. |
| `CURSOR2OPENAI_CONVERSATION_TTL_DAYS` | `30` | Unused fingerprints expire after this many days. |
| `CURSOR2OPENAI_MAX_CONVERSATIONS` | `10000` | Maximum stored fingerprints. Least recently used are removed first. |
| `CURSOR2OPENAI_MODEL_CACHE_MS` | `300000` | How long the model list is cached (5 minutes). |
| `CURSOR2OPENAI_MAX_BODY_BYTES` | `20971520` | Request size limit (20 MB). |
| `CURSOR2OPENAI_TLS_CERT_FILE` | none | Certificate file. With the key file, enables HTTPS. |
| `CURSOR2OPENAI_TLS_KEY_FILE` | none | Private key file for HTTPS. |

`CURSOR_API_KEY` is passed through to `agent` if it is set. Otherwise `agent` uses its own saved login.

## 6. Request flow

1. **Check.** Verify the API key, content type, and size. Parse the body. Verify the model is in the model list (section 9). Reject anything invalid (section 10).
2. **Fingerprint.** Find the last assistant message. Compute the fingerprint of all messages up to and including it, together with the model name and the tool list.
3. **Look up.** Take the matching session ID out of the conversation index. Taking it removes it, so each fingerprint is used at most once.
4. **Run.**
   - **Match found:** run `agent --resume <session ID>` with the continued prompt (section 7).
   - **No match, or no assistant message yet:** run `agent` without `--resume` with the full prompt.
   - **Resume failed before any text was sent to Hermes:** retry once without `--resume` with the full prompt. This applies only to failures classified as `upstream_error` (section 10). Rate limits, usage limits, context length, login, and timeout errors are returned to Hermes without a retry.
5. **Respond.** Stream or return the answer (section 8).
6. **Record.** On success, compute the fingerprint of the request's messages plus the assistant reply exactly as it was returned to Hermes. Store it with the session ID Cursor reported.

On failure, disconnect, or timeout, nothing is recorded. The next request starts fresh, because the saved Cursor session may contain a partial turn.

### Fingerprint rules

The fingerprint is the SHA-256 hash of a canonical JSON document (keys sorted, no extra spaces) containing:

- `model`: the model name.
- `tools`: the request's tool definitions, sorted by function name.
- `messages`: each message cleaned up as follows.

| Role | Cleaned-up form |
|---|---|
| `system`, `developer` | role `system`, text |
| `user` | text parts joined with newlines, trimmed; each image replaced by the SHA-256 hash of its data |
| `assistant` | text trimmed (`null` becomes empty); tool calls as a list of name plus arguments, with arguments parsed and re-serialized canonically. Tool-call IDs and reasoning fields are excluded. |
| `tool` | text, trimmed. The tool-call ID is excluded. |

This works because Hermes re-sends earlier messages byte-for-byte identical on every step. It builds its system prompt once per conversation and rebuilds it only after compressing the conversation (Hermes source: `agent/turn_context.py`, "prompt-cache invariant").

### Conversation index

- Each entry holds a session ID and a last-used time.
- Entries unused for longer than the expiry (default 30 days) are removed when the index loads and once per hour.
- At most `MAX_CONVERSATIONS` entries are kept. The least recently used are removed first.
- The index is saved to `<data folder>/conversations.json`. It is written to a temporary file and then renamed, so a crash never leaves a half-written file. Writes are grouped and happen at most once per second, and always at shutdown.
- If the file is missing or unreadable at startup, the adapter starts with an empty index and logs a warning.

## 7. Prompts

### Full prompt

Sent for a new Cursor session. Contains, in order:

1. The tool protocol instructions (section 8), including the full tool list: each tool's name, description, and parameter schema.
2. Hermes's system messages.
3. The conversation, one block per message, labeled `User:`, `Assistant:`, `Assistant tool calls:`, or `Tool result (<tool name>):`.
4. Image references for every image still in the conversation (section 9).

### Continued prompt

Sent with `--resume`. Contains:

1. The messages after the last assistant message, usually tool results or a new user message, in the same labeled format.
2. Image references for images in those messages only.
3. A one-line reminder of the tool-call format. The full tool list is not repeated.

The prompt is always sent through standard input, never as a command-line argument, so it does not appear in process listings.

## 8. Tool calls and streaming

### Tool protocol

In ask mode, Cursor cannot call Hermes tools directly. The prompt tells the model to request tools in this exact format:

```text
<tool_calls>
[{"name": "read_file", "arguments": {"path": "notes.md"}}]
</tool_calls>
```

Rules given to the model:

- Normal text may come before the opening marker.
- Several tools may be requested in one block.
- Stop writing after the closing marker.
- Use only tools from the provided list.

### Converting to OpenAI format

- Each tool call gets a new unique ID (`call_` plus 24 random characters). IDs written by the model are ignored.
- `arguments` written as an object is converted to a JSON string. No other changes are made.
- Tool calls with unknown names or invalid arguments are passed through. Hermes rejects them and reports the problem to the model, as it does with OpenAI.
- If the block between the markers is not a valid JSON array of objects, the whole reply is returned as plain text with finish reason `stop`, and a warning is logged.
- Text after the closing marker is dropped. Its length is logged.
- Finish reason is `tool_calls` when tool calls are returned, otherwise `stop`.
- Events from Cursor's own internal tools, such as reading an image file, are never forwarded.

### Streaming

- Text is forwarded to Hermes as `delta.content` as soon as Cursor produces it.
- The stream splitter holds back only the end of the text that could be the start of `<tool_calls>`. For example, a trailing `<to` is held until the next piece of output shows whether it is the marker. Held text is sent as soon as it cannot be the marker, or when the stream ends.
- After the opening marker, output is collected until the closing marker or the end of the stream. The block is then parsed and sent as `delta.tool_calls` chunks, one per call, with the full arguments in a single chunk.
- Thinking text from Cursor is forwarded as `delta.reasoning_content`.
- The final chunk carries the finish reason. If the request asked for `stream_options.include_usage`, a usage chunk follows. The stream ends with `data: [DONE]`.
- Non-streamed requests use the same splitter and return one complete response.

### Token usage

Hermes uses reported token counts to track how full the context is and when to compress it. So `prompt_tokens` must describe the whole conversation, even when only new messages were sent.

- If Cursor's usage for a continued session covers the whole conversation, it is used as reported.
- Otherwise `prompt_tokens` is estimated as the character count of the full prompt divided by 4. The full prompt is the one that would have been sent for a new session.
- `completion_tokens` comes from Cursor when available, otherwise it is estimated the same way from the reply.

Which case applies is confirmed by pre-implementation check 3 (section 12).

### Disconnect

If Hermes closes the connection before the answer is complete, the adapter stops the `agent` process and records nothing.

## 9. Screenshots, models, and the Cursor process

### Screenshots

- Accepted only as `data:image/<png|jpeg|gif|webp>;base64,...` inside `image_url` parts.
- `file://` addresses and web addresses are rejected with a 400 error.
- Maximum 5 MB per decoded image, maximum 10 images per request.
- Images are saved as `<workspace>/attachments/<request ID>/image-<n>.<ext>`, readable only by the adapter's user, and deleted when the request ends.
- The prompt lists each image's relative path and asks the model to view it.

### Model list

- Fetched with `agent --list-models` at startup and whenever the cached list is older than `MODEL_CACHE_MS`.
- Also saved to `<data folder>/models-cache.json`. If fetching fails, the saved list is used. If there is no saved list, the model list endpoint and chat requests return 503.
- `GET /v1/models` returns the OpenAI list format: `id`, `object: "model"`, `created`, `owned_by: "cursor"`.
- Effort is chosen through the model name, for example `claude-opus-5-5-high`. The adapter does not translate Hermes reasoning-effort settings.
- Only names in the list are accepted. A model prefix such as `openai/` is removed first. This also stops a crafted name such as `--force` from being read as a command-line option.

### How `agent` is run

Fixed arguments:

```text
agent --print --mode ask --trust --workspace <data folder>/workspace
      --model <model> --output-format stream-json --stream-partial-output
      [--resume <session ID>]
```

- Never `--force`, `--yolo`, `--approve-mcps`, or a workspace from a request.
- The workspace is an empty folder owned by the adapter. `--trust` applies only to it.
- Environment passed to `agent`: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` if set, `CURSOR_API_KEY` if set, and `NO_COLOR=1`. Nothing else, and never the adapter's own API key. Check 5 in section 12 confirms that `agent` works with only these.
- On timeout or disconnect, the adapter stops the `agent` process and every process it started.

### Startup checks

The adapter stops with a clear message if any of these fail:

1. The API key is set and at least 32 characters long.
2. `agent --version` succeeds.
3. `agent status` reports a logged-in user.
4. The data folder and workspace folder can be created and written.
5. The model list can be fetched, or a saved list exists.

No model request is sent at startup.

### Shutdown

On `SIGINT` or `SIGTERM`, the adapter stops accepting requests, waits up to 30 seconds for running requests, stops any remaining `agent` processes, and saves the conversation index.

## 10. Security and errors

### Security

- **API key.** Required on every request as `Authorization: Bearer <key>`. Compared in constant time.
- **Network.** Listens on `127.0.0.1` unless configured otherwise. When listening on any other address without HTTPS configured, it logs a warning that the key and conversations travel unencrypted.
- **HTTPS.** Enabled when both certificate and key files are configured.
- **Requests.** Only `application/json`, up to the size limit. No CORS headers. `OPTIONS` requests get 405.
- **Logs.** One JSON line per request with: time, request ID, model, `fresh` or `continued`, the reason for a fresh start (`new`, `no-match`, `resume-failed`), status, duration, characters sent to Cursor, characters of the full prompt, and token counts. Prompts, images, and keys are never logged.
- **Dependencies.** `npm audit` must report zero vulnerabilities.
- **Recommended setup (documented, not enforced).** Run the adapter as its own operating system user with its own Cursor login, so `agent` does not load someone's personal Cursor MCP servers or rules.

### Errors returned to Hermes

All errors use the OpenAI error body: `{"error": {"message", "type", "code"}}`. Messages are short and contain no stack traces or file paths. Full `agent` error output is logged, cut to 2,000 characters.

| Situation | Status | `code` |
|---|---|---|
| Invalid request, invalid image, unsupported image address | 400 | `invalid_request_error` |
| Wrong or missing API key | 401 | `invalid_api_key` |
| Model not in the list | 404 | `model_not_found` |
| Wrong method or path | 404 or 405 | `not_found` |
| Body too large | 413 | `request_too_large` |
| Cursor rate limit | 429 | `rate_limit_exceeded` |
| Cursor usage limit reached | 429 | `insufficient_quota` |
| Conversation too long for the model | 400 | `context_length_exceeded` |
| Cursor CLI not logged in, or no model list | 503 | `service_unavailable` |
| Time limit reached | 504 | `timeout` |
| Any other `agent` failure | 502 | `upstream_error` |

- Cursor does not document its error codes. The error classifier recognizes cases from `agent` exit codes and error text. All patterns live in `error-classifier.ts` with tests built from real samples (check 4 in section 12). Unrecognized failures become 502.
- The adapter never retries rate-limited or failed requests itself. Hermes retries. The only automatic retry is the fresh retry after a failed resume (section 6).
- If a failure happens after streaming started, the adapter sends an error event in the stream and closes it.

## 11. Testing

All tests use Node's built-in test runner. No real Cursor requests are made by automated tests.

### Unit tests

- Fingerprint cleanup, canonical JSON, and matching, including assistant messages returned with `null` content, extra fields, or different tool-call IDs.
- Conversation index: one-time use, expiry, size cap, save and load, recovery from a corrupt file.
- Tool protocol parser: valid blocks, several calls, text before the marker, text after the marker, invalid JSON, arguments as objects.
- Stream splitter: markers split across chunks in every position, text that resembles the marker but is not, output ending mid-marker.
- Response writer: non-streamed body, streamed chunks, usage chunk, `[DONE]`.
- Error classifier: every row of the error table, from recorded `agent` output.
- Images: allowed types, size and count limits, rejected address types, file cleanup.
- Configuration: missing or short API key, invalid values, environment overriding the file.
- Model validation: prefix removal, unknown names, names starting with `-`.

### Integration tests

The whole adapter runs against a fake `agent` executable. The fake replays recorded stream output and records its arguments, standard input, and environment. Tests confirm that:

- `--force` and other forbidden flags are never passed, and the workspace is always the adapter's folder.
- A second request in the same conversation uses `--resume` and sends only the new messages.
- A retried or parallel request with the same fingerprint starts fresh.
- A failed resume is retried once as a fresh session.
- The adapter's API key is not in the environment given to `agent`.
- `agent` is stopped when the client disconnects or the time limit is reached.
- Continuation still works after the adapter restarts.

### Manual end-to-end check

With real Hermes and Cursor:

1. A simple chat.
2. A multi-step tool task.
3. A screenshot.
4. Switching models mid-conversation.
5. Restarting the adapter mid-conversation.
6. A conversation long enough for Hermes to compress its history.

### Performance measurements

These measure the adapter only, not Cursor.

| Measurement | Method | Target |
|---|---|---|
| Time the adapter adds per request | Benchmark against the fake `agent`, which answers immediately | Under 10 ms |
| Delay before streamed text reaches Hermes | Same benchmark, from fake output to client receipt | Under 5 ms |
| Share of steps that continue a session | Metadata log from the manual check | Over 90% of steps after the first |
| Prompt size on continued steps | Characters sent compared with the full prompt | Under 20% of the full prompt |

## 12. Pre-implementation checks

Done with a few tiny real Cursor requests before any code is written:

1. `agent --resume <session ID>` works with the prompt on standard input, in a fixed workspace folder, from a new process.
2. Ask mode can view an image saved in the workspace folder.
3. Stream output includes token usage, and whether a continued session reports usage for the whole conversation.
4. Error output for an unknown model and for a missing login, recorded as test samples.
5. `agent` runs with only the environment variables listed in section 9.

If check 1 or 2 fails, work stops and the design is revisited, because the approach depends on them.

## 13. Hermes configuration

```yaml
providers:
  cursor:
    api: http://<adapter address>:8787/v1
    transport: chat_completions
    key_env: CURSOR2OPENAI_API_KEY
    default_model: composer-2.5

model:
  provider: custom:cursor
  default: composer-2.5
```

The same key goes in Hermes's `.env` file as `CURSOR2OPENAI_API_KEY`. Use `https://` when HTTPS is enabled.

## 14. Known limitations

- Cursor keeps saved sessions on disk and never deletes them. The adapter does not delete Cursor's internal files, because their layout is not documented.
- Whether Cursor can resume a session that is several days old is not confirmed. If it cannot, the fresh retry keeps the conversation working at the cost of one slower step.
- Each step still starts a new `agent` process and loads the saved session. Removing that cost would require the long-running approach rejected in section 3.
- Error recognition depends on `agent` error text, which may change between Cursor releases.
