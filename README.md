# dsh-llm-ssh-tunnel

An SSH-tunnelled, multi-protocol model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a browser settings card.

It exists for the common home-lab shape: **sub2api runs on the NAS, the NAS is not exposed to the public internet, and DSH may be running somewhere else.** The provider opens an in-process SSH forward and sends every model request to a loopback port, so sub2api never needs a public listener.

```text
DSH  ──►  127.0.0.1:<ephemeral>  ──ssh2──►  NAS 127.0.0.1:8080  ──►  sub2api
```

The route is a normal `LlmAdapter`: model selection, tools, images, replay, reasoning effort, token accounting, and retries behave the same as any other DSH provider. The OpenAI and Anthropic wire conversions are reused from the public `@deepseek-ai/dsh-llm-pi-ai` adapter.

Verified with DSH 0.2.1-rc.5 against a live sub2api deployment: discovery, streaming, all three wire protocols, and image input round-tripped through the tunnel. The automated suite uses an in-process `ssh2` server, so it needs no NAS credentials and no system `ssh`.

## Why in-process SSH?

The transport is [`ssh2`](https://github.com/mscdex/ssh2), not the operating-system `ssh` command. That means:

- Windows, Linux, and macOS use the same code path.
- No OpenSSH client installation, no `ssh.exe`, no `/dev/null` config workaround.
- Key files, passphrases, password auth, and ssh-agent/Pageant are handled in-process.
- The forward is bound to `127.0.0.1` only.

The trade-off is that `ssh2` does **not** read `~/.ssh/config`. Use explicit `host`, `port`, `user`, and `identityFile` fields (the settings card asks for them), or fill them in YAML.

## Install

From this checkout:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add link:/absolute/path/to/ssh-tunnel-provider
```

Or pack it and install the tarball:

```sh
pnpm pack
dsh plugin --profile web add ./dsh-llm-ssh-tunnel-0.2.2.tgz
```

The package ships a built `lib/`, including the browser bundle. Restart or refresh the Web UI after installing.

A link install runs the checkout's `lib/`, so after pulling changes run `pnpm run build` again and restart `dsh web` — the Host half is loaded once per process.

## Configure

Add the provider to the profile's `cordis.patch.yml` (or pass it with `--patch`):

```yaml
- insert:
    - id: llm-sub2api-ssh
      name: dsh-llm-ssh-tunnel
      config:
        provider: sub2api-ssh          # route key; keep it stable
        displayName: Sub2API (SSH)

        ssh:
          host: nas.example          # hostname or IP; no ssh_config aliases
          port: 22
          user: deploy
          identityFile: ~/.ssh/id_ed25519
          knownHostsFile: ~/.ssh/known_hosts
          strictHostKeyChecking: accept-new

        remote:
          host: 127.0.0.1              # as resolved by the NAS
          port: 8080                   # sub2api HTTP port
          basePath: /v1

        apiKeyEnv: SUB2API_API_KEY          # resolved through DSH credentials / env
        discoverModels: true

- id: agent-default-model
  config:
    provider: sub2api-ssh
    model: deepseek-v4.1-flash
```

Then open **Settings → Plugins → SSH tunnel provider**. The card edits the same connection facts plus the sub2api API key, with no YAML edit or restart:

- SSH host, port, user
- private key file path
- known_hosts path
- host-key policy
- sub2api host, port, API base path
- API key reference and the key itself

The API key is written through the DSH credential service; the settings document holds only the reference name. The card's values are stored in `$DSH_HOME/.ssh-tunnel-provider.<provider>.json` and override the YAML connection facts on later boots. Delete that file to return to the profile values.

### Fields

| Field | Default | Meaning |
|---|---|---|
| `provider` | `sub2api-ssh` | Route key used by `GenerateOptions.provider`. Fixed at mount; change it in YAML and restart. |
| `displayName` | route key | Label shown in selectors. |
| `ssh.host` | required | SSH hostname or IP. |
| `ssh.port` | `22` | SSH port. |
| `ssh.user` | OS user | SSH user. |
| `ssh.identityFile` / `ssh.key` | agent | Private key path; `~` expanded. OpenSSH/PEM format. |
| `ssh.passphraseEnv` | none | Credential reference for an encrypted key's passphrase. |
| `ssh.passwordEnv` | none | Credential reference for SSH password auth (key auth preferred). |
| `ssh.agent` | none | `true` infers `SSH_AUTH_SOCK` (Pageant on Windows); a string names a socket or `pageant`. |
| `ssh.knownHostsFile` | `~/.ssh/known_hosts` | Host-key pinning file. |
| `ssh.strictHostKeyChecking` | `accept-new` | `yes`, `no`, or `accept-new`. |
| `remote.host` | `127.0.0.1` | Destination as resolved by the NAS. |
| `remote.port` | required | sub2api HTTP port. |
| `remote.basePath` | `/v1` | API root; empty forwards the origin unchanged. |
| `localPort` | `0` | Loopback port; `0` picks a free one. |
| `api` | `openai-completions` | Wire protocol for models that do not override it: `openai-completions`, `openai-responses`, or `anthropic-messages`. |
| `apiKeyEnv` | none | Credential reference for the sub2api key. |
| `headers` | none | Extra HTTP headers for model and discovery requests. |
| `compat` | sub2api defaults | pi-ai OpenAI-completions compatibility switches. |
| `models` | none | Explicit catalog. Omit to discover. |
| `defaults` | `262144` / `32768` / `[text]` | Fallbacks for discovered or underspecified models. |
| `discoverModels` | true when `models` is empty | Query `GET {basePath}/models` through the tunnel. |
| `knownModels` | `true` | Fill capacities and modalities from built-in model families when the endpoint publishes none. Set `false` to trust only `models` and `defaults`. |
| `modelsMaxAgeMs` | `600000` (10 min) | Age at which the next catalog read refreshes the listing in the background. `0` refreshes on every read; a negative value disables it. |
| `reasoning` | none | Default reasoning level when a caller omits one. |
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy. |
| `streamIdleTimeoutMs` | `300000` | Idle ceiling while one upstream stream read is outstanding. |
| `requestTimeoutSeconds` | `20` | How long one model request waits for a reconnecting tunnel. |
| `startupTimeoutSeconds` | `8` | Boot-time wait for the first discovery when the catalog is empty. |
| `maxRequestImageBytes` | `20 MiB` | Request-level image payload bound. |
| `requestImagePixelBudget` | `2048×2048` | Per-image pixel budget. |
| `requestImageMaxBytes` | `1 MiB` | Per-image encoded-byte target. |

## Wire protocols

sub2api serves all three OpenAI/Anthropic wires, and this provider can use any of them:

| `api` | Path | Notes |
|---|---|---|
| `openai-completions` | `POST /v1/chat/completions` | Default. Widest compatibility. |
| `openai-responses` | `POST /v1/responses` | Reasoning items and tool calls as native items; usually the fastest on DeepSeek deployments. |
| `anthropic-messages` | `POST /v1/messages` | Needs the server root, not `/v1` — see below. |

Set the route default with `api:`, and override per model in `models`:

```yaml
api: openai-responses
models:
  - id: deepseek-v4.1-flash          # inherits openai-responses
  - id: claude-sonnet-4-5
    api: anthropic-messages          # per-model override
```

A model that names no protocol takes the route `api`, then `defaults.api`, then `openai-completions`. One route can mix protocols: each model dispatches to its own wire, which is what a mixed catalog needs. The settings card exposes the route default as a dropdown.

**Base path per protocol.** The OpenAI SDKs append their own path to the base URL, so they need the `/v1` root. The Anthropic SDK appends `/v1/messages` itself, so a `/v1` base would produce `/v1/v1/messages` and sub2api answers that with 404. The provider derives this: `remote.basePath: /v1` is used as-is for the OpenAI protocols and stripped of its `/v1` for `anthropic-messages`.

Measured through this tunnel against a live sub2api (three runs each, `deepseek-v4.1-flash`):

```text
openai-completions   "pong" 1789ms, 1601ms, 1257ms
openai-responses     "pong" 1270ms, 1181ms, 1477ms
anthropic-messages   "pong" 1811ms, 1216ms,  994ms
```

All three work; the difference at this request size is close to noise, so pick by behaviour (reasoning item shape, tool-call fidelity) rather than by these numbers alone.

### Image generation is not reachable through DSH

`gpt-image-*` ids appear in a sub2api listing, but two independent limits keep them out of this provider:

- The tested gateway rejects the Images API outright: `POST /v1/images/generations` answers `404 {"error":{"message":"Images API is not supported for this platform"}}`. A different deployment may serve it, but the second limit still applies.
- DSH's LLM seam streams text, reasoning, and tool calls only. `LlmAdapter` has no image-output operation, so even a gateway that returned a rendered image would have nowhere to deliver it.

The catalog therefore filters those ids instead of offering choices that must fail on the first request. As a workaround, a model with tool access can call the gateway itself; that is a tool, not a provider feature.

## When the model list refreshes

Adding a model in sub2api does not require a DSH restart. Five things reach the picker, in the order you are likely to hit them:

1. **A catalog read made after the listing went stale.** Any `listModels()` read — opening the model picker, opening the Models settings page, or a client re-syncing its catalog — first asks the runtime whether the listing is older than `modelsMaxAgeMs` (default 10 minutes, the same window DSH's own DeepSeek adapter uses). If it is, the listing is re-read in the background; the read itself is never delayed.
2. **The explicit `Refresh models` button** in **Settings → Plugins → SSH tunnel provider**. It refreshes immediately and reports the new count, which is the deterministic option when you just added models.
3. **Saving the settings card.** A saved card re-reads the listing, because the model list is a property of the endpoint, key, and headers it just wrote.
4. **Boot.** The first listing runs at startup — blocking only while the configured catalog is empty, so a one-shot headless task can name a discovered model.
5. **A retry loop** before the first successful listing, every 30 seconds, for a NAS that was asleep at boot.

A refresh publishes only when the catalog actually changed: it then announces `llm/adapters-updated`, which is the event DSH's model selector, Models page, and subagent picker already listen to. An identical listing publishes nothing, so an idle picker never re-reads in a loop. A failed refresh backs off for 30 seconds and keeps the previous catalog serving.

```yaml
modelsMaxAgeMs: 60000   # re-check after one minute instead of ten
# modelsMaxAgeMs: 0     # re-check on every catalog read
# modelsMaxAgeMs: -1    # only the button and boot, never automatically
```

## Model catalog

With `discoverModels: true`, the provider reads the OpenAI-compatible `/models` listing through the tunnel. The parser accepts a `data` array, a bare array, a `models` array, and an enriched `models` object. It reads `context_window` / `context_length` / `max_input_tokens`, `max_output_tokens` / `max_tokens`, and input modalities when published.

### sub2api publishes ids only

A sub2api deployment answers `/v1/models` with `{id, type, display_name, created_at}` and nothing else — no context window, no output cap, no modality list. A provider that trusted only the listing would size every model from `defaults` (262,144 context, 32,768 output, text-only), which is wrong for a 1M-context DeepSeek route: the agent compacts far too early, output is capped at a fraction of what the model allows, and image attachments are refused.

So capability facts resolve in this order, and the winning layer is recorded per model:

1. the `models` entry you wrote,
2. whatever the endpoint published,
3. a **built-in family table** (`knownModels: true`, the default),
4. the route `defaults`.

The built-in table covers the chat families this deployment serves — DeepSeek V4 and its vision variants (1M context, 384k output, low/high/max reasoning), GLM 5.x, Grok 4.6, Kimi K, MiniMax M3, and Claude (200k). The families the test account could route all accepted image input; Grok 4.6 was listed but not routable for that account, so its modality is inherited from the GLM entry. `knownModels: false` disables the table.

The listing is also filtered: this route streams chat completions only, so image-generation, embedding, and speech ids (`gpt-image-*`, `*-embedding-*`, `whisper-*`, `flux-*`, …) are dropped instead of offered as choices that could only fail. The dropped count is logged. A configured `models` entry is never filtered — writing it is an explicit request.

Every refresh logs how each model was sized, and names the ones still resting on defaults:

```text
ssh-tunnel: model facts — 0 configured, 0 from the endpoint, 24 from built-in families
ssh-tunnel: 40 model(s) use route defaults (262144 context / 32768 output): claude-fable-5, … — declare them under "models" if those capacities are wrong
```

The settings card shows the same count. A model outside the table is not guessed at: declare it explicitly.

```yaml
models:
  - id: deepseek-v4.1-flash
    name: DeepSeek V4.1 Flash
    contextWindow: 1000000
    maxTokens: 384000
    input: [text, image]
    reasoningEfforts:
      low: low
      high: high
      max: max
```

Configured entries win over discovered entries with the same id, field by field. If `discoverModels: false`, `models` must not be empty.

### One model, several advertised ids

The deployment lists `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4.1-flash`, `deepseek-flash`, and `deepseek/deepseek-flash` for the same model. Discovery collapses them to the canonical **`deepseek-v4.1-flash`**, so the picker shows one entry rather than seven identical choices. That model accepts text and images and declares 1,000,000 context / 384,000 output.

`deepseek-v4-flash-vision-exp` is retired upstream; a stale listing that still contains it is filtered out.

## How it works

- `apply()` allocates a loopback port, registers one `LlmAdapter` route, and starts an `SshTunnel`.
- `SshTunnel` owns one `ssh2.Client` and one local TCP server. Each accepted connection opens a `direct-tcpip` channel to `remote.host:remote.port` and pipes the sockets.
- Readiness is a real TCP connection through the forward, not just a live SSH client. A dropped connection closes the listener and reconnects with exponential backoff (1s → 30s).
- A request that arrives during a reconnect waits up to `requestTimeoutSeconds`, then fails with `TUNNEL_UNAVAILABLE`.
- Host keys are checked against `known_hosts`; `accept-new` pins an unknown host after the first successful connection. A changed key is refused.
- The settings card talks to one loopback-only, token-guarded route (`/plugins/dsh-llm-ssh-tunnel/config`). The token is fetched by the same-origin page; the route rejects cross-origin POSTs and requests without the token.
- Connection settings are applied live: an SSH/remote change restarts only the forward; a model/knob change rebuilds the catalog/profile. The provider route is never unregistered.

## Security notes

- The settings route is loopback-only. It works when the Web UI is opened as `http://127.0.0.1:...` or `http://localhost:...`; opening DSH through a LAN address makes the card's own `Host` non-loopback, so the route refuses it (the model route is unaffected).

- The forward binds to `127.0.0.1`, never `0.0.0.0`.
- `apiKeyEnv` is a reference. The key is resolved per request through the DSH credential service (or launch environment) and is never written to the settings document or logs.
- The settings route requires a per-process CSRF token and a loopback `Host`/`Origin`.
- `strictHostKeyChecking: no` accepts an unknown host key; a key already pinned in `known_hosts` that no longer matches is still refused. Use it only for disposable test environments.
- The ssh2 client inherits the DSH process environment; the API key is not placed on any command line.

## Troubleshooting

**`TUNNEL_UNAVAILABLE`**
Check the host/port/user/key in the settings card and the DSH log. A quick sanity check with the system client is useful even though the plugin does not use it:

```sh
ssh -i ~/.ssh/id_ed25519 deploy@nas.example true
```

**Host key mismatch**
The message names the fingerprint. If the NAS was rebuilt or its host key legitimately changed, remove the old line from `known_hosts` (or point `ssh.knownHostsFile` elsewhere) and reconnect. Do not switch to `no` on a network you do not control.

**`MISSING_CREDENTIAL`**
`apiKeyEnv` (or `ssh.passphraseEnv` / `ssh.passwordEnv`) names a reference with no value. Store it through the credentials service, export it, or remove the reference.

**Encrypted private key**
Set `ssh.passphraseEnv` to a credential reference and store the passphrase there, or use an ssh-agent (`ssh.agent: true`). PuTTY `.ppk` files are not supported by ssh2; convert them with PuTTYgen to OpenSSH format.

**Windows**
Use a normal path such as `C:\Users\me\.ssh\id_ed25519`. `agent: true` tries Pageant on Windows; for the Windows OpenSSH agent, name its pipe explicitly. PPK keys are not supported.

**Web card is missing**
The browser half is loaded only in the Web profile. Confirm the package is installed in the profile, restart `dsh web`, and check **Settings → Plugins**. The host provider works without the card; only the UI is absent.

**A model shows 262k context, short output, or no image support**
That model fell through to the route defaults, because sub2api publishes no capacities. Check the DSH log line `model facts — … from built-in families` and the `N model(s) use route defaults` warning; declare the model under `models` with `contextWindow`, `maxTokens`, and `input`. Families listed in the built-in table are already handled.

**A model added in sub2api does not appear**
Open the picker again: a read after `modelsMaxAgeMs` (10 minutes by default) refreshes the listing in the background. To force it, press **Refresh models** in the settings card, or set `modelsMaxAgeMs: 0`. A model that `/models` still does not list needs an explicit `models` entry.

**Model picker is empty**
The `/models` discovery failed or the endpoint returned nothing. Check the DSH log and configure `models` explicitly.

**Settings changes do not survive / YAML wins**
The card writes `$DSH_HOME/.ssh-tunnel-provider.<provider>.json`, which overrides the YAML connection facts. Delete the file to reset to the profile layer.

## Limitations

- No `~/.ssh/config` aliases, `ProxyJump`, or interactive keyboard/2FA prompts.
- No PuTTY `.ppk` keys; convert to OpenSSH/PEM.
- Plain HTTP only. An HTTPS sub2api endpoint would present a certificate for the NAS name, not `127.0.0.1`; terminate TLS on the NAS loopback or use a trusted certificate and a hostname that resolves to loopback.
- This build registers one settings-card route per DSH process. One SSH-tunnel provider entry is the supported shape; a second entry still serves model calls but cannot share the settings card.
- `GenerateOptions.stop` is rejected by the pi-ai adapter (`UNSUPPORTED_OPTION`).
- Discovery is advisory metadata. Models that publish no capacities get the configured defaults; vision models usually need `input: [text, image]` explicitly.

## Development

```sh
pnpm run build
pnpm test
```

The integration test starts an in-process `ssh2.Server` implementing public-key auth and `direct-tcpip`, plus a mock OpenAI-compatible endpoint. It covers registration, discovery, streaming, `prepareCall`, host-key verification, and the settings route without touching a real SSH server.

## License

MIT
