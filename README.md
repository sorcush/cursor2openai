# cursor2openai

An OpenAI-compatible Chat Completions adapter that lets [Hermes Agent](https://github.com/NousResearch/hermes-agent) use a Cursor subscription as a custom provider. Each request runs the official Cursor CLI (`agent`) in read-only ask mode. Hermes runs every tool.

Design: [`docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md`](docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md)

## Requirements

- Node.js 22 or later
- The Cursor CLI, logged in: `curl https://cursor.com/install -fsS | bash`, then `agent login`

## Install and run

```bash
npm ci
npm run build
cp .env.example .env
# Set CURSOR2OPENAI_API_KEY in .env, for example to the output of: openssl rand -hex 32
node --env-file=.env dist/cli.js
```

`.env` is git-ignored. You can also set the variables in your shell instead and run `node dist/cli.js`.

On Linux, create the workspace folder once:

```bash
sudo install -d -o "$USER" -m 700 /var/lib/cursor2openai
```

The adapter listens on `http://127.0.0.1:8787/v1` by default.

## Configuration

Set these in `.env` (start from [`.env.example`](.env.example)) or in your shell. Environment variables override `~/.cursor2openai/config.yaml` (keys are the lowercase names without the prefix, for example `port: 9000`). See [`examples/config.yaml`](examples/config.yaml).

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR2OPENAI_API_KEY` | required | Key Hermes must send. At least 32 characters. |
| `CURSOR2OPENAI_HOST` | `127.0.0.1` | Listening address. |
| `CURSOR2OPENAI_PORT` | `8787` | Listening port. |
| `CURSOR2OPENAI_TLS_CERT_FILE`, `CURSOR2OPENAI_TLS_KEY_FILE` | none | Enable HTTPS. Required for a non-loopback address unless insecure HTTP is allowed. |
| `CURSOR2OPENAI_ALLOW_INSECURE_HTTP` | `false` | Allow plain HTTP on a non-loopback address. |
| `CURSOR2OPENAI_DATA_DIR` | `~/.cursor2openai` | Conversation index, model cache, config file. |
| `CURSOR2OPENAI_WORKSPACE_DIR` | macOS `/Users/Shared/cursor2openai`, Linux `/var/lib/cursor2openai` | Folder `agent` runs in. Outside your home folder, mode `0700`. |
| `CURSOR2OPENAI_DEFAULT_MODEL` | `composer-2.5` | Model used when a request names none. |
| `CURSOR2OPENAI_AGENT_BIN` | `agent` | Path to the Cursor CLI. |
| `CURSOR2OPENAI_REQUEST_TIMEOUT_MS` | `600000` | Time limit for one `agent` run. |
| `CURSOR2OPENAI_MAX_CONCURRENT` | `4` | Maximum `agent` processes at once. |
| `CURSOR2OPENAI_MAX_QUEUED` | `16` | Maximum waiting requests. |
| `CURSOR2OPENAI_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for a free slot. |
| `CURSOR2OPENAI_CONVERSATION_TTL_DAYS` | `30` | How long an unused conversation can still be continued. |
| `CURSOR2OPENAI_MAX_CONVERSATIONS` | `10000` | Maximum stored conversations. |
| `CURSOR2OPENAI_MODEL_CACHE_MS` | `300000` | How long the model list is cached. |
| `CURSOR2OPENAI_MAX_BODY_BYTES` | `20971520` | Request size limit. |
| `CURSOR2OPENAI_DEBUG_LOG_AGENT_OUTPUT` | `false` | Log raw `agent` errors. They may contain prompt text. |

## Hermes configuration

Add the provider to your Hermes profile (`config.yaml`) and put `CURSOR2OPENAI_API_KEY` in the profile's `.env`. See [`examples/hermes-config.yaml`](examples/hermes-config.yaml).

- Choose the model and effort together by picking the exact Cursor model name, for example `gpt-5.6-sol-high`.
- The `model_overrides` block must appear under both `custom` and `custom:cursor`. Hermes runs named providers internally as `custom`.
- `session_affinity_header` lets the adapter continue Cursor sessions safely.
- Any Hermes task (main model, delegation, compression, titles) can use this provider.

## Security

- Every request needs the API key. Use HTTPS when Hermes runs on another machine.
- `agent` runs in ask mode with a fixed workspace and a Cursor permissions file that denies shell commands, writes, web fetches, MCP tools, and reads of your home folder and `/etc`.
- Remaining gap: Cursor can still read files outside the denied folders, and a symbolic link or another spelling of a path can get around the rules. For complete protection, run the adapter as a separate operating-system user with its own Cursor login, no MCP servers or rules in its Cursor settings, and no private files.
- Logs contain metadata only.

## Known limitations

- The model's reasoning text is not available: Cursor does not output it in print mode.
- Token usage is not reported. Cursor's counts include its own hidden system prompt, so Hermes uses its own estimate instead.
- `tool_choice`, `parallel_tool_calls`, and `response_format` are followed through instructions to the model.
- Cursor keeps its saved sessions on disk. The adapter never deletes Cursor's files or its own workspace folder. If you delete or move the workspace folder, existing conversations start a fresh Cursor session once.

## Development

```bash
npm test             # unit and integration tests, no real Cursor requests
npm run test:perf    # adapter performance targets
C2O_PYTHON=~/.hermes/hermes-agent/venv/bin/python npm test   # adds the OpenAI Python SDK test
node scripts/pre-implementation-checks.mjs                     # real Cursor checks (about 14 requests)
```

## License

MIT. Not an official Cursor or Nous Research product.
