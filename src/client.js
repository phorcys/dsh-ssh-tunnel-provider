/**
 * Browser half of the SSH-tunnel provider: one Settings > Plugins card backed
 * by the plugin's own same-origin JSON route.
 *
 * This file is copied verbatim to `lib/client.js` by `scripts/build-client.mjs`
 * and loaded by the DSH client module loader. It uses only React and the
 * plugin's HTTP route, with no client UI package dependency, so it survives
 * across DSH point releases and works for a provider inserted by a profile
 * patch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-ssh-tunnel',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'settings.sshTunnel'
    const ROUTE = '/plugins/dsh-llm-ssh-tunnel/config'
    const DEFAULT_API_KEY_REF = 'SUB2API_API_KEY'

    const en = {
      title: 'SSH tunnel provider',
      summary: 'Reach sub2api through an in-process SSH forward.',
      description: 'Model requests go to a loopback port that this DSH process forwards over SSH. sub2api needs no public listener and no system ssh binary.',
      sshHost: 'SSH host',
      sshPort: 'SSH port',
      sshUser: 'SSH user',
      keyFile: 'Private key file',
      keyFileHint: 'Leave empty to use an ssh-agent. Windows paths such as C:\\Users\\me\\.ssh\\id_ed25519 are accepted.',
      knownHosts: 'known_hosts file',
      hostKey: 'Host key policy',
      hostKeyAcceptNew: 'Accept new (pin on first use)',
      hostKeyYes: 'Strict',
      hostKeyNo: 'Insecure (accept unknown)',
      remoteHost: 'sub2api host',
      remotePort: 'sub2api port',
      basePath: 'API base path',
      apiKeyRef: 'API key reference',
      apiKey: 'sub2api API key',
      apiKeyHint: 'Stored through the DSH credential service; the literal value never enters the settings document.',
      configured: 'configured',
      notConfigured: 'not configured',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The tunnel reconnects automatically if connection settings changed.',
      saveFailed: 'The settings write was refused. Check the fields and try again.',
      loadFailed: 'Could not read the plugin settings route.',
      connection: 'Connection',
      target: 'sub2api target',
      credential: 'Credential',
      catalog: 'Model catalog',
      refresh: 'Refresh models',
      refreshing: 'Refreshing…',
      refreshed: 'Model list refreshed.',
      refreshFailed: 'Refresh failed',
      modelsKnown: 'models',
      lastChecked: 'last checked',
      neverChecked: 'not checked yet',
      autoRefresh: 'Reopening the model picker re-checks this list after',
      fallbackHint: 'model(s) fall back to default 262144/32768 because the endpoint publishes no capacities. Declare them under "models" to correct context, output, or image support.',
      api: 'Wire protocol',
      apiCompletions: 'Chat Completions (/v1/chat/completions)',
      apiResponses: 'Responses (/v1/responses)',
      apiAnthropic: 'Anthropic Messages (/v1/messages)',
      apiHint: 'sub2api serves all three. Responses is usually the fastest on DeepSeek; per-model overrides live in "models".',
    }

    const zh = {
      title: 'SSH 隧道 Provider',
      summary: '通过进程内 SSH 转发访问 sub2api。',
      description: '模型请求发到本机回环端口，由 DSH 进程经 SSH 转发；sub2api 不需要公网监听，也不依赖系统 ssh 命令。',
      sshHost: 'SSH 主机',
      sshPort: 'SSH 端口',
      sshUser: 'SSH 用户',
      keyFile: '私钥文件',
      keyFileHint: '留空则使用 ssh-agent。支持 C:\\Users\\me\\.ssh\\id_ed25519 这类 Windows 路径。',
      knownHosts: 'known_hosts 文件',
      hostKey: '主机密钥策略',
      hostKeyAcceptNew: '接受新主机（首次记录并固定）',
      hostKeyYes: '严格校验',
      hostKeyNo: '不安全（接受未知主机）',
      remoteHost: 'sub2api 主机',
      remotePort: 'sub2api 端口',
      basePath: 'API 根路径',
      apiKeyRef: 'API Key 引用名',
      apiKey: 'sub2api API Key',
      apiKeyHint: '通过 DSH 凭据服务保存，明文不会写入 settings 文档。',
      configured: '已配置',
      notConfigured: '未配置',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。连接参数变化时隧道会自动重连。',
      saveFailed: '设置写入被拒绝，请检查字段后重试。',
      loadFailed: '读取插件设置路由失败。',
      connection: '连接',
      target: 'sub2api 目标',
      credential: '凭据',
      catalog: '模型列表',
      refresh: '刷新模型',
      refreshing: '刷新中…',
      refreshed: '模型列表已刷新。',
      refreshFailed: '刷新失败',
      modelsKnown: '个模型',
      lastChecked: '上次检查',
      neverChecked: '尚未检查',
      autoRefresh: '重新打开模型选择器时，超过',
      fallbackHint: '个模型使用了 262144/32768 的默认容量，因为端点没有公布任何容量信息。请在 "models" 里声明它们，以修正上下文、输出长度和图片支持。',
      api: '协议',
      apiCompletions: 'Chat Completions（/v1/chat/completions）',
      apiResponses: 'Responses（/v1/responses）',
      apiAnthropic: 'Anthropic Messages（/v1/messages）',
      apiHint: 'sub2api 三种协议都支持。DeepSeek 上 Responses 通常最快；单个模型的覆盖写在 "models" 里。',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' },
      intro: { margin: 0, opacity: 0.72, lineHeight: 1.5 },
      section: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', border: '1px solid var(--dsh-border, rgba(127,127,127,.25))', borderRadius: '8px' },
      sectionTitle: { margin: 0, fontSize: '12px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', opacity: 0.65 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', fontWeight: 500 },
      hint: { margin: 0, fontSize: '11px', opacity: 0.62, lineHeight: 1.4 },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', background: 'var(--dsh-input-bg, transparent)', color: 'inherit', font: 'inherit' },
      select: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', background: 'var(--dsh-input-bg, transparent)', color: 'inherit', font: 'inherit' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      button: { padding: '7px 14px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', font: 'inherit', cursor: 'pointer' },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      status: { fontSize: '12px', opacity: 0.72 },
      error: { fontSize: '12px', color: '#d9534f' },
      badge: { fontSize: '11px', padding: '2px 7px', borderRadius: '999px', border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', opacity: 0.8 },
    }

    const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

    /** Field wrapper with a label and optional hint. */
    function field(label, control, hint, key) {
      return h('div', { style: styles.field, key },
        h('label', { style: styles.label }, label),
        control,
        hint === undefined ? null : h('p', { style: styles.hint }, hint))
    }

    /** Text input bound to one draft key. */
    function textInput(draft, key, onChange, options = {}) {
      return h('input', {
        style: styles.input,
        value: draft[key] ?? '',
        type: options.type ?? 'text',
        inputMode: options.inputMode,
        placeholder: options.placeholder,
        spellCheck: false,
        onChange: event => onChange(key, event.target.value),
      })
    }

    /** Short relative age of a timestamp, for the catalog status line. */
    function ageText(timestamp) {
      if (typeof timestamp !== 'number') return undefined
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.round(hours / 24)}d`
    }

    /** Convert the route's settings document into editable strings. */
    function draftFor(settings) {
      return {
        sshHost: settings.ssh?.host ?? '',
        sshPort: String(settings.ssh?.port ?? 22),
        sshUser: settings.ssh?.user ?? '',
        identityFile: settings.ssh?.identityFile ?? '',
        knownHostsFile: settings.ssh?.knownHostsFile ?? '',
        strictHostKeyChecking: settings.ssh?.strictHostKeyChecking ?? 'accept-new',
        remoteHost: settings.remote?.host ?? '127.0.0.1',
        remotePort: String(settings.remote?.port ?? 8080),
        basePath: settings.remote?.basePath ?? '/v1',
        apiKeyEnv: settings.apiKeyEnv ?? DEFAULT_API_KEY_REF,
        api: settings.api ?? 'openai-completions',
      }
    }

    /** One fetch against the plugin route. */
    async function request(method, token, body) {
      const response = await fetch(ROUTE, {
        method,
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...method === 'GET' ? {} : { 'content-type': 'application/json' },
          ...token === undefined ? {} : { 'x-dsh-ssh-tunnel-token': token },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** The full settings form. */
    function CardBody(props) {
      const { t } = props
      const [data, setData] = React.useState(undefined)
      const [draft, setDraft] = React.useState(undefined)
      const [keyText, setKeyText] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [message, setMessage] = React.useState(undefined)
      const [failed, setFailed] = React.useState(false)
      const [loadError, setLoadError] = React.useState(undefined)

      React.useEffect(() => {
        let live = true
        void request('GET').then((payload) => {
          if (!live) return
          setData(payload)
          setDraft(draftFor(payload.settings))
        }).catch((error) => {
          if (live) setLoadError(error instanceof Error ? error.message : String(error))
        })
        return () => { live = false }
      }, [])

      if (loadError !== undefined) {
        return h('div', { style: styles.root },
          h('p', { style: styles.error }, `${t('loadFailed')} ${loadError}`))
      }
      if (draft === undefined || data === undefined) {
        return h('p', { style: styles.status }, t('loadFailed'))
      }

      const update = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      const ref = (draft.apiKeyEnv ?? DEFAULT_API_KEY_REF).trim() || DEFAULT_API_KEY_REF
      const disabled = saving
      const keyDisabled = saving || data.credential?.writable === false

      const refresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        setMessage(undefined)
        setFailed(false)
        try {
          const payload = await request('POST', data.token, { action: 'refresh' })
          setData(payload)
          setMessage(`${t('refreshed')} (${payload.catalog?.models ?? 0} ${t('modelsKnown')})`)
        } catch (error) {
          setFailed(true)
          setMessage(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setRefreshing(false)
        }
      }

      const save = async () => {
        if (disabled) return
        setSaving(true)
        setMessage(undefined)
        setFailed(false)
        const port = (text, label, fallback) => {
          if (text.trim() === '') return fallback
          const value = Number(text)
          if (!Number.isInteger(value) || value < 1 || value > 65535) {
            throw new Error(`${label} must be an integer between 1 and 65535`)
          }
          return value
        }
        let settings
        try {
          settings = {
            ssh: {
              host: draft.sshHost.trim(),
              port: port(draft.sshPort, 'SSH port', 22),
              user: draft.sshUser.trim(),
              identityFile: draft.identityFile.trim(),
              knownHostsFile: draft.knownHostsFile.trim(),
              strictHostKeyChecking: draft.strictHostKeyChecking,
            },
            remote: {
              host: draft.remoteHost.trim() || '127.0.0.1',
              port: port(draft.remotePort, 'sub2api port', 8080),
              basePath: draft.basePath.trim() || '/v1',
            },
            apiKeyEnv: ref,
            api: draft.api,
          }
        } catch (error) {
          setFailed(true)
          setMessage(error instanceof Error ? error.message : String(error))
          setSaving(false)
          return
        }
        try {
          const payload = await request('POST', data.token, {
            settings,
            ...keyText.trim() === '' ? {} : { apiKey: keyText.trim() },
          })
          setData(payload)
          setDraft(draftFor(payload.settings))
          setKeyText('')
          setMessage(t('saved'))
        } catch (error) {
          setFailed(true)
          setMessage(error instanceof Error ? error.message : t('saveFailed'))
        } finally {
          setSaving(false)
        }
      }

      const catalog = data.catalog ?? {}
      const age = ageText(catalog.refreshedAt)
      const autoMinutes = typeof catalog.maxAgeMs === 'number' && catalog.maxAgeMs > 0
        ? Math.round(catalog.maxAgeMs / 60_000)
        : undefined

      return h('div', { style: styles.root },
        h('p', { style: styles.intro }, t('description')),

        h('div', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('catalog')),
          h('div', { style: styles.row },
            h('span', { style: styles.badge }, `${catalog.models ?? 0} ${t('modelsKnown')}`),
            h('span', { style: styles.status },
              `${t('lastChecked')}: ${age === undefined ? t('neverChecked') : age}`),
            h('button', {
              type: 'button',
              style: refreshing ? { ...styles.button, ...styles.buttonDisabled } : styles.button,
              disabled: refreshing,
              onClick: () => { void refresh() },
            }, refreshing ? t('refreshing') : t('refresh'))),
          autoMinutes === undefined ? null : h('p', { style: styles.hint },
            `${t('autoRefresh')} ${autoMinutes} min.`),
          (catalog.fallback ?? 0) > 0
            ? h('p', { style: styles.hint }, `${catalog.fallback} ${t('fallbackHint')}`)
            : null),

        h('div', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('connection')),
          h('div', { style: styles.grid },
            field(t('sshHost'), textInput(draft, 'sshHost', update, { placeholder: 'nas.example' }), undefined, 'sshHost'),
            field(t('sshPort'), textInput(draft, 'sshPort', update, { type: 'number', inputMode: 'numeric' }), undefined, 'sshPort'),
            field(t('sshUser'), textInput(draft, 'sshUser', update, { placeholder: 'deploy' }), undefined, 'sshUser'),
            field(t('keyFile'), textInput(draft, 'identityFile', update, { placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519' }), t('keyFileHint'), 'identityFile'),
            field(t('knownHosts'), textInput(draft, 'knownHostsFile', update, { placeholder: '~/.ssh/known_hosts' }), undefined, 'knownHosts'),
            field(t('api'), h('select', {
              style: styles.select,
              value: draft.api,
              onChange: event => update('api', event.target.value),
            },
            h('option', { value: 'openai-responses' }, t('apiResponses')),
            h('option', { value: 'openai-completions' }, t('apiCompletions')),
            h('option', { value: 'anthropic-messages' }, t('apiAnthropic'))), t('apiHint'), 'api'),
            field(t('hostKey'), h('select', {
              style: styles.select,
              value: draft.strictHostKeyChecking,
              onChange: event => update('strictHostKeyChecking', event.target.value),
            },
            h('option', { value: 'accept-new' }, t('hostKeyAcceptNew')),
            h('option', { value: 'yes' }, t('hostKeyYes')),
            h('option', { value: 'no' }, t('hostKeyNo'))), undefined, 'hostKey'))),

        h('div', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('target')),
          h('div', { style: styles.grid },
            field(t('remoteHost'), textInput(draft, 'remoteHost', update, { placeholder: '127.0.0.1' }), undefined, 'remoteHost'),
            field(t('remotePort'), textInput(draft, 'remotePort', update, { type: 'number', inputMode: 'numeric' }), undefined, 'remotePort'),
            field(t('basePath'), textInput(draft, 'basePath', update, { placeholder: '/v1' }), undefined, 'basePath'))),

        h('div', { style: styles.section },
          h('h4', { style: styles.sectionTitle }, t('credential')),
          h('div', { style: styles.grid },
            field(t('apiKeyRef'), textInput(draft, 'apiKeyEnv', update, { placeholder: DEFAULT_API_KEY_REF }), undefined, 'apiKeyEnv'),
            field(t('apiKey'), h('input', {
              style: styles.input,
              type: 'password',
              value: keyText,
              autoComplete: 'off',
              disabled: keyDisabled,
              placeholder: data.credential?.configured === true ? t('configured') : t('notConfigured'),
              onChange: event => setKeyText(event.target.value),
            }), t('apiKeyHint'), 'apiKey')),
          h('div', { style: styles.row },
            h('span', { style: styles.badge }, `${ref}: ${data.credential?.configured === true ? t('configured') : t('notConfigured')}`))),

        h('div', { style: styles.row },
          h('button', {
            type: 'button',
            style: disabled ? { ...styles.button, ...styles.buttonDisabled } : styles.button,
            disabled,
            onClick: () => { void save() },
          }, saving ? t('saving') : t('save')),
          message === undefined ? null : h('span', { style: failed ? styles.error : styles.status }, message)))
    }

    /** Card entry: the Plugins page asks for a summary or the full form. */
    function SshTunnelCard(props) {
      if (props.view === 'summary') return props.t('summary')
      return h(CardBody, props)
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ssh-tunnel: settings copy')
      ctx.effect(
        () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'ssh-tunnel',
          order: 60,
          label: () => t('title'),
          locale: NS,
          inject: () => ({ t }),
        }, SshTunnelCard)),
        'ssh-tunnel: settings card',
      )
    }

    return { name: 'llm-ssh-tunnel', inject, apply }
  },
})
