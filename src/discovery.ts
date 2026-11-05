/**
 * `GET {basePath}/models` interrogation through the local forward.
 *
 * This is the same openai-compatible listing shape `dsh-llm-pi-ai` reads, but
 * the endpoint is the SSH-forwarded origin, so discovery needs the same
 * credential and headers as a model request. Parsing is deliberately tolerant:
 * sub2api installations front several upstreams, and their listings differ in
 * which capacity and modality fields they publish.
 *
 * @module dsh-llm-ssh-tunnel/discovery
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ProviderModality } from './config.js'

/** One model the forwarded endpoint advertises. */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ProviderModality[]
}

/** Upper bound on a model-listing body; a malformed gateway must not exhaust memory. */
const MAX_MODELS_BODY_BYTES = 8 * 1024 * 1024

/** Discovery request facts. */
export interface DiscoverModelsOptions {
  /** Forwarded origin plus API root, without a trailing slash. */
  baseUrl: string
  /** Resolved bearer credential, when the route names one. */
  apiKey?: string
  /** Deployment headers; attribution names win collisions. */
  headers: Readonly<Record<string, string>>
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Total time allowed for the listing. */
  timeoutMs?: number
}

/** Convert one unknown value to a positive integer, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** Read the first positive integer among several upstream spellings. */
function firstInteger(source: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = positiveInteger(source[name])
    if (value !== undefined) return value
  }
  return undefined
}

/** Normalize one modality list, keeping only known values. */
function modalities(value: unknown): ProviderModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.flatMap((item) => {
    if (typeof item !== 'string') return []
    const normalized = item.toLowerCase()
    if (normalized === 'text') return ['text' as const]
    if (normalized === 'image' || normalized === 'vision') return ['image' as const]
    return []
  })
  return result.length === 0 ? undefined : [...new Set(result)]
}

/** Read an input-modality list from the shapes gateways actually publish. */
function inputModalities(source: Record<string, unknown>): ProviderModality[] | undefined {
  const direct = modalities(source.input) ?? modalities(source.input_modalities) ?? modalities(source.modalities)
  if (direct !== undefined) return direct
  const architecture = source.architecture
  if (typeof architecture === 'object' && architecture !== null) {
    const record = architecture as Record<string, unknown>
    return modalities(record.input_modalities) ?? modalities(record.modalities)
  }
  return undefined
}

/** Turn one listing entry into a model, or undefined when it has no usable id. */
function toModel(entry: unknown, fallbackId?: string): DiscoveredModel | undefined {
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id.length === 0 ? undefined : { id }
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const id = [record.id, record.model, record.name, fallbackId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
  if (id === undefined) return undefined
  const name = [record.name, record.display_name, record.displayName]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
  return {
    id,
    ...name === undefined || name === id ? {} : { name },
    ...(() => {
      const contextWindow = firstInteger(record, [
        'context_window', 'context_length', 'max_context_length', 'max_input_tokens', 'input_token_limit',
      ])
      return contextWindow === undefined ? {} : { contextWindow }
    })(),
    ...(() => {
      const maxTokens = firstInteger(record, [
        'max_output_tokens', 'max_tokens', 'max_completion_tokens', 'output_token_limit',
      ])
      return maxTokens === undefined ? {} : { maxTokens }
    })(),
    ...(() => {
      const input = inputModalities(record)
      return input === undefined ? {} : { input }
    })(),
  }
}

/**
 * Parse a `/models` payload into deduplicated models in endpoint order.
 *
 * Accepts the standard `data` array, a bare array, a `models` array, and the
 * enriched `models` object several gateways use (the key is the request id
 * even when the entry names a different display id).
 * @param payload - decoded JSON response.
 * @returns models in endpoint order, deduplicated by id.
 */
export function parseModelList(payload: unknown): DiscoveredModel[] {
  let entries: unknown[] = []
  if (Array.isArray(payload)) {
    entries = payload
  } else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.data)) entries = record.data
    else if (Array.isArray(record.models)) entries = record.models
    else if (typeof record.models === 'object' && record.models !== null) {
      entries = Object.entries(record.models as Record<string, unknown>)
        .map(([id, value]) => typeof value === 'object' && value !== null ? { id, ...value } : { id })
    }
  }

  const seen = new Set<string>()
  const result: DiscoveredModel[] = []
  for (const entry of entries) {
    const model = toModel(entry)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

/**
 * Read one JSON response under a hard byte cap.
 * @param response - successful listing response.
 * @returns decoded JSON.
 * @throws Error when the body exceeds the cap or is not JSON.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_MODELS_BODY_BYTES) {
    throw new Error(`listing body is larger than ${MAX_MODELS_BODY_BYTES} bytes`)
  }
  if (response.body === null) return JSON.parse(await response.text())

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MODELS_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`listing body is larger than ${MAX_MODELS_BODY_BYTES} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
}

/**
 * Interrogate the forwarded endpoint's model listing.
 * @param options - forwarded origin, credential, headers, and cancellation.
 * @returns advertised models in endpoint order.
 * @throws LlmError `AUTH` on a rejected credential, `DISCOVERY_FAILED` on transport/protocol failure.
 */
export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModel[]> {
  const headers = new Headers(attributionHeaders())
  for (const [name, value] of Object.entries(options.headers)) headers.set(name, value)
  if (options.apiKey !== undefined && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${options.apiKey}`)
  }
  headers.set('accept', 'application/json')

  const timeout = options.timeoutMs ?? 15_000
  const signals = [AbortSignal.timeout(timeout)]
  if (options.signal !== undefined) signals.push(options.signal)
  const signal = AbortSignal.any(signals)

  let response: Response
  try {
    // Refuse redirects: the listing carries the Authorization header, and
    // following a redirect would hand that credential to another origin.
    response = await fetch(`${options.baseUrl}/models`, {
      headers,
      signal,
      redirect: 'error',
      cache: 'no-store',
    })
  } catch (error) {
    throw new LlmError(
      `ssh-tunnel: could not read ${options.baseUrl}/models through the tunnel: ${error instanceof Error ? error.message : String(error)}`,
      'DISCOVERY_FAILED',
      { cause: error },
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new LlmError(
      `ssh-tunnel: the endpoint rejected the API key while listing models (HTTP ${response.status})`,
      'AUTH',
      { status: response.status },
    )
  }
  if (!response.ok) {
    throw new LlmError(
      `ssh-tunnel: ${options.baseUrl}/models returned HTTP ${response.status}`,
      'DISCOVERY_FAILED',
      { status: response.status },
    )
  }

  let payload: unknown
  try {
    payload = await readBoundedJson(response)
  } catch (error) {
    throw new LlmError(
      `ssh-tunnel: /models returned an unusable body: ${error instanceof Error ? error.message : String(error)}`,
      'DISCOVERY_FAILED',
      { cause: error },
    )
  }
  const models = parseModelList(payload)
  if (models.length === 0) {
    throw new LlmError(
      `ssh-tunnel: ${options.baseUrl}/models advertised no models; configure "models" explicitly`,
      'NO_MODELS',
    )
  }
  return models
}
