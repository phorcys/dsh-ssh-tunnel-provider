/**
 * Built-in capability facts for model families a sub2api deployment commonly
 * fronts.
 *
 * Why this file exists: sub2api's `GET /v1/models` publishes only
 * `{id, type, display_name, created_at}` — no context window, no output cap,
 * and no modality list. A provider that trusted only that listing would size
 * every discovered model from route defaults (262,144 context, 32,768 output,
 * text-only), which is exactly the wrong answer for a 1M-context DeepSeek
 * route: the agent compacts far too early, caps output at a fraction of what
 * the model allows, and refuses image attachments the model would accept.
 *
 * Precedence is deliberate: a configured `models` entry wins over a discovered
 * field, which wins over a rule here, which wins over the route defaults. So
 * this table is a starting point a deployment corrects per model, never a
 * silent override. `knownModels: false` turns it off entirely.
 *
 * Facts are matched on the lowercase model id, first rule wins. Only families
 * with an observed deployment are listed; an unrecognized id keeps the route
 * defaults and is reported as such so the gap is visible rather than guessed.
 *
 * @module dsh-llm-ssh-tunnel/known-models
 */
/** DeepSeek V4 reasoning levels as the deployment's own profile declared them. */
const DEEPSEEK_EFFORTS = {
    low: 'low',
    high: 'high',
    max: 'max',
};
/** GLM and Grok expose an explicit thinking-off spelling on this gateway. */
const OFF_EFFORTS = {
    off: 'none',
    low: 'low',
    high: 'high',
    max: 'max',
};
/** DeepSeek V4 context and output capacity as the gateway serves it. */
const DEEPSEEK_V4 = {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    // Every DeepSeek V4 chat model in the tested catalog accepted an image.
    input: ['text', 'image'],
    reasoningEfforts: DEEPSEEK_EFFORTS,
};
/** GLM 5.x family capacity. */
const GLM = {
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoningEfforts: OFF_EFFORTS,
};
/** Ordered rules; the first match decides. */
const RULES = [
    {
        family: 'deepseek-v4 vision',
        // Only the explicit DeepSeek vision id. A generic "vision" substring would
        // also catch unrelated models such as gpt-4-vision and size them from
        // DeepSeek's window.
        matches: id => /(^|\/)deepseek-v4\.1-flash(\b|$)/.test(id),
        facts: DEEPSEEK_V4,
    },
    {
        family: 'deepseek-v4',
        matches: id => /(^|\/)deepseek-v4(\b|[-.])/.test(id) || /(^|\/)deepseek-flash(\b|$)/.test(id),
        facts: DEEPSEEK_V4,
    },
    {
        family: 'glm-5',
        matches: id => /(^|\/)glm-?5/.test(id),
        facts: GLM,
    },
    {
        family: 'grok-4.6',
        matches: id => /(^|\/)grok-4\.6(\b|$)/.test(id),
        facts: GLM,
    },
    {
        family: 'claude',
        // Anthropic's chat models are all multimodal and share a 200k window; the
        // 32k output ceiling is the current Sonnet/Opus allowance.
        matches: id => /(^|\/)claude-/.test(id),
        facts: { contextWindow: 200_000, maxTokens: 32_768, input: ['text', 'image'] },
    },
    {
        family: 'kimi-k',
        matches: id => /(^|\/)kimi-k/.test(id),
        facts: { contextWindow: 262_144, maxTokens: 32_768, input: ['text', 'image'] },
    },
    {
        family: 'minimax-m3',
        matches: id => /(^|\/)minimax-m3/.test(id),
        facts: { contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'] },
    },
];
/**
 * Look up built-in facts for one model id.
 * @param id - model id exactly as the endpoint advertises it.
 * @returns the matching rule's facts and family name, or undefined when no rule fits.
 */
export function lookupKnownModel(id) {
    const key = id.trim().toLowerCase();
    if (key.length === 0)
        return undefined;
    for (const rule of RULES) {
        if (rule.matches(key))
            return { family: rule.family, facts: rule.facts };
    }
    return undefined;
}
/** Id fragments that name a non-chat model a chat provider must not advertise. */
const NON_CHAT = /(^|[-_/])(image|images|tts|audio|speech|whisper|embed|embedding|embeddings|rerank|moderation|dall-e|flux|midjourney|stable-diffusion|sd-xl|video|sora|veo|kling|runway)([-_./]|$)/;
/**
 * Whether one advertised id can serve a chat request.
 *
 * A sub2api catalog mixes chat, image-generation, embedding, and speech models.
 * This provider streams chat completions only, so advertising the rest would
 * fill the picker with choices that fail on the first request.
 * @param id - model id as the endpoint advertises it.
 * @returns false for an obviously non-chat id.
 */
export function isChatModelId(id) {
    return !NON_CHAT.test(id.trim().toLowerCase());
}
/** Ids the upstream catalog no longer serves; drop them when discovery returns a stale listing. */
const RETIRED_MODEL_IDS = new Set(['deepseek-v4-flash-vision-exp']);
/**
 * Ids the upstream catalog serves for one model. The deployment advertises
 * seven spellings of DeepSeek V4.1 Flash; keep one canonical entry instead of
 * seven identical choices.
 */
const MODEL_ALIASES = {
    'deepseek-v4-flash': 'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
    'deepseek/deepseek-v4-flash': 'deepseek-v4.1-flash',
    'deepseek/deepseek-v4.1-flash': 'deepseek-v4.1-flash',
    'deepseek-flash': 'deepseek-v4.1-flash',
    'deepseek/deepseek-flash': 'deepseek-v4.1-flash',
};
/** Whether an advertised id is known to be retired upstream. */
export function isRetiredModelId(id) {
    return RETIRED_MODEL_IDS.has(id.trim().toLowerCase());
}
/** Canonical id for an alias, or the id itself when it is not an alias. */
export function canonicalModelId(id) {
    const key = id.trim().toLowerCase();
    return MODEL_ALIASES[key] ?? id;
}
/** Every family this build ships facts for, for diagnostics and documentation. */
export function knownModelFamilies() {
    return RULES.map(rule => rule.family);
}
