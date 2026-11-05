/**
 * The route's model catalog and pi-ai descriptors.
 *
 * The catalog has two sources: models written in the profile, and models the
 * forwarded `/models` listing advertised. Configured entries always win on a
 * shared id, so a user can correct a discovered capacity without restating
 * the whole catalog. Descriptors are rebuilt on every `getModels()` call
 * because the tunnel may rebind its loopback port after a reconnect.
 *
 * @module dsh-llm-ssh-tunnel/models
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { DiscoveredModel } from './discovery.js'
import { canonicalModelId, isChatModelId, isRetiredModelId, lookupKnownModel } from './known-models.js'
import { DEFAULT_PROVIDER_API } from './config.js'
import type { ModelConfig, ProviderApi, ProviderModality, ResolvedConfig, ThinkingLevel } from './config.js'

/** The cost object pi-ai requires; this provider does not price tokens. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Where one model's capability facts came from. */
export type FactSource = 'config' | 'discovery' | 'known' | 'defaults'

/** One model after profile defaults and discovery metadata are merged. */
export interface ResolvedModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: readonly ProviderModality[]
  reasoningEfforts?: false | Record<string, string | null>
  compat?: Readonly<Record<string, unknown>>
  /** The explicitly configured output cap, which also becomes the request default. */
  explicitMaxTokens?: number
  /** Where capacity and modality facts came from, for diagnostics. */
  source: FactSource
  /** Matched built-in family, when one applied. */
  family?: string
  /** Wire protocol this model speaks. */
  api: ProviderApi
}

/** The layer that supplied one model's capacity facts. */
function capacitySource(
  source: ModelConfig | DiscoveredModel,
  configured: boolean,
  known: ReturnType<typeof lookupKnownModel>,
): FactSource {
  if (configured) return 'config'
  if (source.contextWindow !== undefined || source.maxTokens !== undefined) return 'discovery'
  if (known?.facts.contextWindow !== undefined || known?.facts.maxTokens !== undefined) return 'known'
  return 'defaults'
}

/**
 * Merge one configured or discovered model with the built-in facts and route
 * defaults.
 *
 * sub2api advertises only ids, so a discovered model has no capacity at all;
 * without the known-model layer every such model would be sized from
 * `defaults` and refuse images. Order is configured entry → endpoint →
 * built-in family → route default, and the winning layer is recorded so the
 * caller can report which models still rest on guesses.
 */
function resolveModel(
  source: ModelConfig | DiscoveredModel,
  config: ResolvedConfig,
  configured: boolean,
): ResolvedModel {
  const known = config.knownModels ? lookupKnownModel(source.id) : undefined
  const endpointInput = source.input !== undefined && source.input.length > 0 ? source.input : undefined

  const contextWindow = source.contextWindow
    ?? known?.facts.contextWindow
    ?? config.defaults.contextWindow
  // An output cap above the context window is not a request the endpoint can
  // serve; clamping keeps one wrong rule from producing an impossible model.
  const maxTokens = Math.min(
    source.maxTokens ?? known?.facts.maxTokens ?? config.defaults.maxTokens,
    contextWindow,
  )
  const input = endpointInput ?? known?.facts.input ?? config.defaults.input
  const explicitEfforts = 'reasoningEfforts' in source ? source.reasoningEfforts : undefined
  const reasoningEfforts = explicitEfforts ?? known?.facts.reasoningEfforts ?? config.defaults.reasoningEfforts

  const source_ = capacitySource(source, configured, known)

  const api = ('api' in source ? source.api : undefined)
    ?? config.defaults.api
    ?? config.api
    ?? DEFAULT_PROVIDER_API
  // OpenAI-family defaults would be noise (and look applied) on an Anthropic
  // route, whose compat keys are a different vocabulary.
  const openAiFamily = api !== 'anthropic-messages'
  const modelCompat = 'compat' in source ? source.compat : undefined
  const compat = {
    ...openAiFamily ? config.compat : {},
    ...openAiFamily ? config.defaults.compat ?? {} : {},
    ...openAiFamily ? modelCompat ?? {} : {},
  }
  return {
    id: source.id,
    name: source.name ?? source.id,
    contextWindow,
    maxTokens,
    input: [...input],
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...Object.keys(compat).length === 0 ? {} : { compat },
    ...configured && source.maxTokens !== undefined ? { explicitMaxTokens: source.maxTokens } : {},
    source: source_,
    api,
    ...known === undefined ? {} : { family: known.family },
  }
}

/** Turn configured reasoning levels into pi-ai's capability fields. */
export function reasoningFields(
  efforts: false | Record<string, string | null> | undefined,
): Pick<Model<Api>, 'reasoning' | 'thinkingLevelMap'> {
  if (efforts === undefined || efforts === false || Object.keys(efforts).length === 0) {
    return { reasoning: false }
  }
  const map: Record<string, string | null> = {}
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const wire = efforts[level]
    if (wire === undefined) {
      map[level] = null
    } else if (wire === null) {
      // A valueless "off" declares the level but sends no override; pi-ai
      // models that by leaving the key absent rather than null.
      if (level === 'off') continue
    } else {
      map[level] = wire
    }
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/**
 * The base URL one protocol expects, derived from the configured API root.
 *
 * The OpenAI SDKs treat the base URL as the prefix they append their own path
 * to, so `openai-completions` and `openai-responses` want the `/v1` root. The
 * Anthropic SDK appends `/v1/messages` itself, so it wants the server root —
 * feeding it `/v1` produces `/v1/v1/messages`, which sub2api answers with 404.
 * @param apiRoot - forwarded origin plus the configured `remote.basePath`.
 * @param api - protocol the model speaks.
 * @returns the base URL that protocol expects.
 */
export function protocolBaseUrl(apiRoot: string, api: ProviderApi): string {
  if (api !== 'anthropic-messages') return apiRoot
  return apiRoot.replace(/\/v1\/?$/, '') || apiRoot
}

/** Build one pi-ai descriptor for the current forward origin. */
function toPiModel(
  entry: ResolvedModel,
  provider: string,
  apiRoot: string,
): Model<Api> {
  return {
    id: entry.id,
    name: entry.name,
    api: entry.api,
    provider,
    baseUrl: protocolBaseUrl(apiRoot, entry.api),
    input: [...entry.input],
    ...reasoningFields(entry.reasoningEfforts),
    cost: ZERO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...entry.compat === undefined ? {} : { compat: entry.compat as Model<Api>['compat'] },
  }
}

/** The live catalog for one route. */
export class ModelCatalog {
  private config: ResolvedConfig
  private discovered: readonly DiscoveredModel[] = []

  constructor(config: ResolvedConfig) {
    this.config = config
  }

  /** Replace the profile facts after a live settings edit. */
  update(config: ResolvedConfig): void {
    this.config = config
  }

  /** Drop the discovered half; used when discovery is disabled or the endpoint changes. */
  clearDiscovered(): void {
    this.discovered = []
  }

  /**
   * Replace the discovered half of the catalog, dropping models this route
   * cannot serve (image generation, embeddings, speech).
   * @param models - ids the endpoint advertised.
   * @returns the ids that were dropped for not being chat models.
   */
  setDiscovered(models: readonly DiscoveredModel[]): readonly string[] {
    const keep: DiscoveredModel[] = []
    const dropped: string[] = []
    const seen = new Set<string>()
    for (const model of models) {
      const canonical = canonicalModelId(model.id)
      if (isRetiredModelId(model.id) || !isChatModelId(model.id)) {
        dropped.push(model.id)
        continue
      }
      if (seen.has(canonical)) {
        dropped.push(model.id)
        continue
      }
      seen.add(canonical)
      // Present the canonical spelling even when the listing put an alias
      // first, so the picker does not depend on catalog order.
      const name = model.name === undefined || model.name === model.id ? undefined : model.name
      const next: DiscoveredModel = { ...model, id: canonical }
      if (name === undefined) delete next.name
      else next.name = name
      keep.push(next)
    }
    this.discovered = keep
    return dropped
  }

  /** Current models: configured entries first, then new discovered ids. */
  models(): ResolvedModel[] {
    const result = this.config.models.map(model => resolveModel(model, this.config, true))
    // Configured entries win, including over an alias of the same model.
    const seen = new Set(result.map(model => canonicalModelId(model.id)))
    for (const model of this.discovered) {
      const canonical = canonicalModelId(model.id)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      result.push(resolveModel(model, this.config, false))
    }
    return result
  }

  /**
   * Count models by the layer that supplied their capability facts.
   * @returns totals plus the ids that still rest on route defaults.
   */
  summary(): { total: number; config: number; discovery: number; known: number; fallback: readonly string[] } {
    const models = this.models()
    const result = { total: models.length, config: 0, discovery: 0, known: 0, fallback: [] as string[] }
    for (const model of models) {
      if (model.source === 'config') result.config += 1
      else if (model.source === 'discovery') result.discovery += 1
      else if (model.source === 'known') result.known += 1
      else result.fallback.push(model.id)
    }
    return result
  }

  /**
   * Stable text of the effective catalog, so a refresh publishes only when it
   * changed. Model order is significant: reordering the profile is a change.
   * @returns a signature whose inequality means the picker must re-read.
   */
  signature(): string {
    return JSON.stringify(this.models().map(model => [
      model.id,
      model.name,
      model.api,
      model.contextWindow,
      model.maxTokens,
      model.input,
      model.reasoningEfforts ?? null,
      model.compat ?? null,
    ]))
  }

  /**
   * Output caps explicitly configured by the profile, by model id.
   *
   * The cap is computed from the fully resolved model, not the route default,
   * so a configured `maxTokens` is not clamped to 262k when the model's real
   * window comes from a built-in family or discovery metadata.
   */
  configuredMaxTokens(): ReadonlyMap<string, number> {
    const caps = new Map<string, number>()
    for (const entry of this.config.models) {
      if (entry.maxTokens === undefined) continue
      const model = resolveModel(entry, this.config, true)
      caps.set(model.id, model.maxTokens)
    }
    return caps
  }

  /** Build pi-ai model descriptors against the tunnel's current origin. */
  piModels(provider: string, apiRoot: string): Model<Api>[] {
    return this.models().map(model => toPiModel(model, provider, apiRoot))
  }

  /** The profile's default reasoning level, when configured. */
  defaultReasoning(): ThinkingLevel | undefined {
    return this.config.reasoning
  }
}

/** Build the pi-ai provider whose `getModels()` always reads the live catalog. */
export function buildPiProvider(options: {
  provider: string
  displayName: string
  /** The forwarded origin plus the configured API root, read per call. */
  baseUrl: () => string
  catalog: ModelCatalog
}): Provider {
  const build = (): Model<Api>[] => options.catalog.piModels(options.provider, options.baseUrl())
  return {
    ...createProvider({
      id: options.provider,
      name: options.displayName,
      auth: {
        apiKey: {
          name: `${options.displayName} API key`,
          resolve: ({ credential }) => Promise.resolve(
            credential?.key === undefined || credential.key.length === 0
              ? { auth: {}, source: options.displayName }
              : { auth: { apiKey: credential.key }, source: options.displayName },
          ),
        },
      },
      models: build(),
      // A protocol map lets one route serve all three wires and dispatches on
      // each model's own `api`, which is what a mixed catalog needs.
      api: {
        'openai-completions': openAICompletionsApi(),
        'openai-responses': openAIResponsesApi(),
        'anthropic-messages': anthropicMessagesApi(),
      },
    }),
    getModels: () => build(),
  }
}
