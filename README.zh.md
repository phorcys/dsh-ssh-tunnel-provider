# dsh-llm-ssh-tunnel

[![CI](https://github.com/phorcys/dsh-ssh-tunnel-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/phorcys/dsh-ssh-tunnel-provider/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 SSH 隧道模型 Provider，带浏览器设置卡片。

它解决的是这个很常见的家庭网络场景：**sub2api 跑在 NAS 上，NAS 不暴露公网，DSH 却可能在另一台机器上。** 插件在 DSH 进程内建立 SSH 转发，把所有模型请求发到 `127.0.0.1` 的临时端口，sub2api 本身不需要监听公网。

```text
DSH  ──►  127.0.0.1:<临时端口>  ──ssh2──►  NAS 127.0.0.1:8080  ──►  sub2api
```

对 DSH 来说，这就是一个普通的 `LlmAdapter`：模型选择、工具调用、图片、回放、推理等级、token 统计、重试都和别的 provider 一样。OpenAI / Anthropic 协议转换直接复用 `@deepseek-ai/dsh-llm-pi-ai` 的公开 `PiAiAdapter`。

已在 DSH 0.2.1-rc.5 + 真实 sub2api 上验证：发现、流式输出、三种协议和图片输入都走通了隧道。自动化测试使用进程内 `ssh2.Server`，不需要 NAS 凭据，也不需要系统 `ssh`。

## 项目状态

`0.2.x` 是 beta 插件。传输、凭据处理、模型发现、设置卡片和三种协议都有测试覆盖，并在真实部署上跑过；`1.0` 之前接口仍可能调整。

## 环境要求

- DeepSeek Harness `0.2.1-rc.5` 或兼容版本
- Node.js `^22.19.0` 或 `>=24.0.0`
- 设置卡片需要 Web profile；模型路由本身不依赖它
- 一个能访问 sub2api 回环监听的 SSH 账号

## 为什么用进程内 SSH

传输层是 [`ssh2`](https://github.com/mscdex/ssh2)，不是操作系统自带的 `ssh` 命令。因此：

- Windows、Linux、macOS 走同一套代码。
- 不需要安装 OpenSSH 客户端，没有 `ssh.exe`，也没有 `/dev/null` 配置绕过。
- 私钥、passphrase、密码认证、ssh-agent/Pageant 都在进程内处理。
- 本地转发只绑定 `127.0.0.1`。

代价是 `ssh2` **不会读取 `~/.ssh/config`**。请显式填写 `host`、`port`、`user`、`identityFile`（设置卡片就是这些字段），或者在 YAML 里写清楚。

## 安装

从本仓库 clone 安装：

```sh
git clone https://github.com/phorcys/dsh-ssh-tunnel-provider.git dsh-llm-ssh-tunnel
cd dsh-llm-ssh-tunnel
npm ci
npm run build
dsh plugin --profile web add link:$PWD
```

也可以用 `npm install`；`npm ci` 使用仓库里的 lockfile，CI 走的就是它。`pnpm install` / `pnpm run build` 同样可用。

或者打包后安装 tarball：

```sh
npm pack
dsh plugin --profile web add ./dsh-llm-ssh-tunnel-0.2.2.tgz
```

包内已经包含构建好的 `lib/`（包括浏览器 bundle）。安装后重启或刷新 Web UI。

`link:` 安装直接运行仓库里的 `lib/`，所以拉取改动后要重新 `npm run build` 并重启 `dsh web`——Host 半边每个进程只加载一次。

## 配置

在 profile 的 `cordis.patch.yml` 里加入 provider（也可以用 `--patch` 传入）：

```yaml
- insert:
    - id: llm-sub2api-ssh
      name: dsh-llm-ssh-tunnel
      config:
        provider: sub2api-ssh          # 路由名，建议长期保持不变
        displayName: Sub2API (SSH)

        ssh:
          host: nas.example          # 主机名或 IP；不支持 ssh_config 别名
          port: 22
          user: deploy
          identityFile: ~/.ssh/id_ed25519
          knownHostsFile: ~/.ssh/known_hosts
          strictHostKeyChecking: accept-new

        remote:
          host: 127.0.0.1              # 从 NAS 视角解析的地址
          port: 8080                   # sub2api HTTP 端口
          basePath: /v1

        apiKeyEnv: SUB2API_API_KEY          # 通过 DSH 凭据层或环境变量解析
        discoverModels: true

- id: agent-default-model
  config:
    provider: sub2api-ssh
    model: deepseek-v4.1-flash
```

然后打开 **Settings → Plugins → SSH tunnel provider**。卡片可以修改连接参数和 sub2api API Key，不需要改 YAML 或重启：

- SSH host、port、user
- 私钥文件路径
- known_hosts 文件
- 主机密钥策略
- sub2api host、port、API 根路径
- API Key 引用名和 API Key 本身

API Key 通过 DSH 凭据服务保存；设置文件里只存引用名。卡片写入 `$DSH_HOME/.ssh-tunnel-provider.<provider>.json`，后续启动时覆盖 YAML 里的连接参数。删除该文件即可恢复 profile 配置。

### 字段说明

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `sub2api-ssh` | 路由键；挂载时固定，修改后需改 YAML 并重启。 |
| `displayName` | 路由键 | 模型选择器里显示的名字。 |
| `ssh.host` | 必填 | SSH 主机名或 IP。 |
| `ssh.port` | `22` | SSH 端口。 |
| `ssh.user` | 当前系统用户 | SSH 用户。 |
| `ssh.identityFile` / `ssh.key` | ssh-agent | 私钥路径，支持 `~`。OpenSSH/PEM 格式。 |
| `ssh.passphraseEnv` | 无 | 加密私钥 passphrase 的凭据引用。 |
| `ssh.passwordEnv` | 无 | SSH 密码认证的凭据引用（优先用密钥）。 |
| `ssh.agent` | 无 | `true` 自动推断 `SSH_AUTH_SOCK`（Windows 上尝试 Pageant）；字符串可指定 socket 或 `pageant`。 |
| `ssh.knownHostsFile` | `~/.ssh/known_hosts` | 主机密钥固定文件。 |
| `ssh.strictHostKeyChecking` | `accept-new` | `yes`、`no` 或 `accept-new`。 |
| `remote.host` | `127.0.0.1` | 从 NAS 视角解析的 sub2api 地址。 |
| `remote.port` | 必填 | sub2api HTTP 端口。 |
| `remote.basePath` | `/v1` | API 根路径；留空表示直接使用 origin。 |
| `localPort` | `0` | 本地回环端口；`0` 自动选择。 |
| `api` | `openai-completions` | 未单独指定协议的模型使用哪种协议：`openai-completions`、`openai-responses` 或 `anthropic-messages`。 |
| `apiKeyEnv` | 无 | sub2api key 的凭据引用。 |
| `headers` | 无 | 模型请求和发现额外使用的 HTTP 头。 |
| `compat` | sub2api 默认值 | pi-ai 的 OpenAI-completions 兼容开关。 |
| `models` | 无 | 显式模型目录。不填则走发现。 |
| `defaults` | `262144` / `32768` / `[text]` | 发现到的或未写全的模型的兜底值。 |
| `discoverModels` | `models` 为空时 true | 通过隧道请求 `GET {basePath}/models`。 |
| `knownModels` | `true` | 端点没有公布容量/模态时，用内置的模型家族事实补齐。设为 `false` 则只信 `models` 和 `defaults`。 |
| `modelsMaxAgeMs` | `600000`（10 分钟） | 列表超过这个年龄后，下一次读取目录会在后台刷新。`0` 表示每次读取都刷新；负数表示不自动刷新。 |
| `reasoning` | 无 | 调用方未指定时物化的默认推理等级。 |
| `retryPolicy` | normal，5 次 | Provider 自己的重试策略。 |
| `streamIdleTimeoutMs` | `300000` | 上游流式读取的空闲上限。 |
| `requestTimeoutSeconds` | `20` | 一次请求等待隧道重连的时间。 |
| `startupTimeoutSeconds` | `8` | 目录为空时，启动阶段等待首次模型发现的时间。 |
| `maxRequestImageBytes` | `20 MiB` | 单次请求的图片负载上限。 |
| `requestImagePixelBudget` | `2048×2048` | 单张图片像素预算。 |
| `requestImageMaxBytes` | `1 MiB` | 单张图片编码后目标大小。 |

## 三种协议

sub2api 同时提供三种协议，这个 provider 都能用：

| `api` | 路径 | 说明 |
|---|---|---|
| `openai-completions` | `POST /v1/chat/completions` | 默认值，兼容性最广。 |
| `openai-responses` | `POST /v1/responses` | reasoning 和 tool call 是原生 item；在 DeepSeek 部署上通常最快。 |
| `anthropic-messages` | `POST /v1/messages` | 需要服务器根路径，不能带 `/v1`，见下。 |

路由级默认用 `api:`，单个模型可以在 `models` 里覆盖：

```yaml
api: openai-responses
models:
  - id: deepseek-v4.1-flash          # 继承 openai-responses
  - id: claude-sonnet-4-5
    api: anthropic-messages          # 单模型覆盖
```

没有指定协议的模型依次取路由 `api` → `defaults.api` → `openai-completions`。同一条路由可以混用协议：每个模型走自己的线路，这正是混合目录需要的。设置卡片里也有这个下拉框。

**每种协议的 base path 不同。** OpenAI 的 SDK 会在 base URL 后面自己拼路径，所以要 `/v1` 根；Anthropic 的 SDK 自己会拼 `/v1/messages`，给它 `/v1` 就会变成 `/v1/v1/messages`，sub2api 直接 404。插件做了区分：`remote.basePath: /v1` 对 OpenAI 协议原样使用，对 `anthropic-messages` 会去掉末尾的 `/v1`。

实测（都走这条隧道、真实 sub2api、`deepseek-v4.1-flash`、各 3 次）：

```text
openai-completions   "pong" 1789ms, 1601ms, 1257ms
openai-responses     "pong" 1270ms, 1181ms, 1477ms
anthropic-messages   "pong" 1811ms, 1216ms,  994ms
```

三种都能跑通；在这个请求规模下差异接近噪声，所以选协议更应该看行为（reasoning item 结构、tool call 保真度），而不是只看这几个数字。

### 生图在 DSH 里走不通

`gpt-image-*` 这类 id 会出现在 sub2api 的列表里，但有两道独立的限制让它们进不来：

- 实测网关本身不支持 Images API：`POST /v1/images/generations` 返回 `404 {"error":{"message":"Images API is not supported for this platform"}}`。换一套部署也许支持，但下面第二条限制仍然存在。
- DSH 的 LLM seam 只流式传输文本、reasoning 和 tool call。`LlmAdapter` 没有图像输出操作，所以即使网关返回了图片，也没有地方交付。

因此目录会把这些 id 过滤掉，而不是放进去让人选了必然失败。变通办法是让有工具权限的模型自己去调网关——那是工具，不是 provider 能力。

## 模型列表什么时候刷新

在 sub2api 里新增模型后，不需要重启 DSH。有五条路径能让模型选择器看到新模型，按你实际会遇到的顺序：

1. **读取目录时发现列表过期。** 任何一次 `listModels()` 读取——打开模型选择器、打开 Models 设置页、客户端重新同步目录——都会先问运行时：列表是否已经超过 `modelsMaxAgeMs`（默认 10 分钟，和 DSH 自带 DeepSeek adapter 的窗口一致）。超过就在后台重读；读取本身不会被阻塞。
2. **设置卡里的「刷新模型」按钮。** 在 **Settings → Plugins → SSH tunnel provider** 里，点一下立刻刷新并显示新的模型数量；刚在 sub2api 加完模型时这是最确定的方式。
3. **保存设置卡。** 保存会重新读取列表，因为模型列表就是它刚写入的 endpoint、key、headers 的属性。
4. **启动时。** 首次列取在启动阶段进行——只有在配置目录为空时才会阻塞，保证 headless 一次性任务能选到发现出来的模型。
5. **首次成功前的重试循环**，每 30 秒一次，用于开机时 NAS 还在休眠的情况。

刷新只在目录真的变化时才发布：此时会发出 `llm/adapters-updated`，这正是 DSH 模型选择器、Models 页、subagent 选择器已经在监听的事件。内容相同的列表不会重复发布，所以空闲的选择器不会陷入反复重读。刷新失败会退避 30 秒，并继续用上一个目录提供服务。

```yaml
modelsMaxAgeMs: 60000   # 一分钟后就重新检查，而不是十分钟
# modelsMaxAgeMs: 0     # 每次读取目录都重新检查
# modelsMaxAgeMs: -1    # 只用按钮和启动刷新，不自动刷新
```

## 模型目录

`discoverModels: true` 时，插件通过隧道读取 OpenAI 兼容的 `/models`。解析器接受 `data` 数组、裸数组、`models` 数组以及部分网关的 `models` 对象；会尽量读取 `context_window` / `context_length` / `max_input_tokens`、`max_output_tokens` / `max_tokens` 和输入模态字段。

### sub2api 只公布 id

sub2api 的 `/v1/models` 只返回 `{id, type, display_name, created_at}`，没有上下文长度、没有输出上限、没有模态列表。如果只信这个列表，每个模型都会套用 `defaults`（262,144 上下文、32,768 输出、仅文本）——对一个 1M 上下文的 DeepSeek 路由来说这是错的：压缩触发得太早、输出被限制在模型能力的一小部分、图片附件会被拒绝。

所以能力事实按这个顺序解析，并记录每个模型最终用到了哪一层：

1. 你写的 `models` 条目；
2. 端点公布的值；
3. **内置家族表**（`knownModels: true`，默认开启）；
4. 路由的 `defaults`。

内置表覆盖这套部署实际在用的 chat 家族——DeepSeek V4 及其视觉变体（1M 上下文、384k 输出、low/high/max 推理）、GLM 5.x、Grok 4.6、Kimi K、MiniMax M3，以及 Claude（200k）。测试账号能路由到的家族都实测接受图片输入；Grok 4.6 只在列表里出现、该账号无法路由，因此它的模态沿用 GLM 条目。`knownModels: false` 可以关掉它。

列表还会做过滤：这条路由只做 chat completions，所以图片生成、embedding、语音类 id（`gpt-image-*`、`*-embedding-*`、`whisper-*`、`flux-*` 等）会被丢弃，而不是放进选择器让人选了必然失败。丢弃数量会写进日志。显式写在 `models` 里的条目不会被过滤——那是明确的请求。

每次刷新都会记录每个模型是怎么定容量的，并点名仍然落在默认值上的那些：

```text
ssh-tunnel: model facts — 0 configured, 0 from the endpoint, 24 from built-in families
ssh-tunnel: 40 model(s) use route defaults (262144 context / 32768 output): claude-fable-5, … — declare them under "models" if those capacities are wrong
```

设置卡片里也会显示同样的数量。表里没有的模型不会被猜，请显式声明。

发现接口不一定什么都知道。最典型的是视觉能力经常缺失，所以需要按模型显式声明：

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

同 id 时，显式 `models` 按字段覆盖发现结果。`discoverModels: false` 时，`models` 不能为空。

### 一个模型，多个 id

这套部署用 `deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4.1-flash`、`deepseek-flash`、`deepseek/deepseek-flash` 七个 id 指向同一个模型。发现时会折叠为规范 id **`deepseek-v4.1-flash`**，选择器里只出现一项，而不是七个相同选项。该模型接受文本和图片，声明 1,000,000 上下文 / 384,000 输出。

`deepseek-v4-flash-vision-exp` 已下线；如果旧列表里仍有它，会被过滤掉。

## 工作原理

- `apply()` 分配一个回环端口，注册一个 `LlmAdapter` 路由，并启动 `SshTunnel`。
- `SshTunnel` 持有一个 `ssh2.Client` 和一个本地 TCP server。每个本地连接通过 `direct-tcpip` 打开到 `remote.host:remote.port` 的通道，然后双向 pipe。
- 就绪判断是真的通过转发建立一次 TCP 连接，而不是只看 SSH client 还活着。连接断开后按指数退避重连（1 秒 → 30 秒）。
- 重连期间到达的请求最多等 `requestTimeoutSeconds`，超时后以 `TUNNEL_UNAVAILABLE` 失败。
- 主机密钥按 `known_hosts` 校验；`accept-new` 首次连接后固定，后续密钥变化会被拒绝。
- 设置卡片只访问一个回环、带进程内 token 的路由（`/plugins/dsh-llm-ssh-tunnel/config`）。token 由同源页面获取；跨源 POST 或缺少 token 的请求会被拒绝。
- 连接参数变化时只重启隧道；模型/参数变化时重建目录和 profile。provider 路由本身不会注销。

## 安全说明

- 设置路由只接受回环来源。用 `http://127.0.0.1:...` 或 `http://localhost:...` 打开 Web UI 时卡片可用；通过局域网地址打开 DSH 时，卡片的 `Host` 不是回环地址，路由会拒绝它（模型路由不受影响）。

- 本地转发只绑定 `127.0.0.1`，不会用 `0.0.0.0`。
- `apiKeyEnv` 只是引用。密钥每次请求通过 DSH 凭据服务（或启动环境）解析，不写进设置文件，也不进日志。
- 设置路由要求每进程生成的 CSRF token，并校验回环 `Host`/`Origin`。
- `strictHostKeyChecking: no` 会接受未知主机密钥；如果 `known_hosts` 里已经固定过且不匹配，仍然会被拒绝。只适合一次性测试环境。
- ssh2 客户端继承 DSH 进程环境，但 API key 不会出现在任何命令行参数里。

## 排错

**`TUNNEL_UNAVAILABLE`**
在设置卡片里检查 host/port/user/key，并看 DSH 日志。虽然插件不用系统 ssh，手工做一次连通性检查仍然有用：

```sh
ssh -i ~/.ssh/id_ed25519 deploy@nas.example true
```

**主机密钥不匹配**
报错会给出指纹。如果 NAS 重装或主机密钥确实变了，先从 `known_hosts` 删除旧行（或把 `ssh.knownHostsFile` 指到新文件）再连接。不要在不可控网络上改成 `no`。

**`MISSING_CREDENTIAL`**
`apiKeyEnv`（或 `ssh.passphraseEnv` / `ssh.passwordEnv`）指向的引用没有值。通过凭据服务保存、导出环境变量，或者去掉该引用。

**加密私钥**
把 `ssh.passphraseEnv` 指向一个凭据引用并保存 passphrase，或者使用 ssh-agent（`ssh.agent: true`）。ssh2 不支持 PuTTY `.ppk`；请用 PuTTYgen 转成 OpenSSH 格式。

**Windows**
私钥路径可以直接写 `C:\Users\me\.ssh\id_ed25519`。`agent: true` 在 Windows 上会尝试 Pageant；Windows OpenSSH agent 请显式指定它的 named pipe。PPK 不支持。

**Web 设置卡片不显示**
浏览器半边只在 Web profile 里加载。确认包已安装到 profile，重启 `dsh web`，再看 **Settings → Plugins**。Host provider 在没有卡片时也能工作，只是没有 UI。

**模型显示 262k 上下文、输出很短、或没有图片支持**
说明这个模型落到了路由默认值上，因为 sub2api 没有公布任何容量信息。检查 DSH 日志里的 `model facts — … from built-in families` 和 `N model(s) use route defaults` 警告；然后在 `models` 里声明它的 `contextWindow`、`maxTokens`、`input`。内置表里已收录的家族不用手动写。

**sub2api 里新增的模型不出现**
再打开一次模型选择器：超过 `modelsMaxAgeMs`（默认 10 分钟）后的读取会在后台刷新列表。想立刻生效就点设置卡里的**刷新模型**，或者设置 `modelsMaxAgeMs: 0`。如果 `/models` 里仍然没有这个模型，就需要显式写一条 `models`。

**模型选择器为空**
`/models` 发现失败或端点没有返回模型。看 DSH 日志，并显式配置 `models`。

**设置改了不生效 / YAML 仍然优先**
卡片写的是 `$DSH_HOME/.ssh-tunnel-provider.<provider>.json`，它会覆盖 YAML 连接参数。删除该文件即可恢复 profile 层。

## 限制

- 不支持 `~/.ssh/config` 别名、`ProxyJump`、交互式 keyboard/2FA。
- 不支持 PuTTY `.ppk`，需要转 OpenSSH/PEM。
- 只支持明文 HTTP。HTTPS 的 sub2api 会出示 NAS 域名的证书，而不是 `127.0.0.1` 的证书；请在 NAS 回环上终止 TLS，或使用能解析到回环的可信证书和主机名。
- 当前构建每个 DSH 进程只注册一个设置卡片路由。推荐一个 SSH 隧道 provider 条目；第二个条目仍可作为模型 provider 工作，但无法共用设置卡片。
- `GenerateOptions.stop` 会被 pi-ai 适配器拒绝（`UNSUPPORTED_OPTION`）。
- 发现结果只是元数据。没有公布容量的模型会用 `defaults`；视觉模型通常需要显式 `input: [text, image]`。

## 开发

```sh
npm ci
npm run build
npm test
```

CI 在 Node 22 和 Node 24 上跑同一套测试。测试是自包含的：启动进程内 `ssh2.Server` 和 HTTP mock，不需要 NAS。

集成测试会启动一个进程内 `ssh2.Server`（公钥认证 + `direct-tcpip`）和一个 mock OpenAI 兼容服务，覆盖注册、发现、流式输出、`prepareCall`、主机密钥校验和设置路由，不需要真实 SSH 服务器。

## 贡献

开发环境、测试要求和示例/测试数据的隐私规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。测试刻意保持自包含，贡献者不需要真实 NAS 也能验证。

## 安全

安全模型和私密报告方式见 [SECURITY.md](SECURITY.md)。不要在公开 issue 里放 API Key、私钥、主机名或 `known_hosts` 内容。

## License

MIT
