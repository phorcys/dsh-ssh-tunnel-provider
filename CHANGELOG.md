# Changelog

## 0.2.2

- Collapse the seven advertised DeepSeek V4.1 Flash ids to the canonical
  `deepseek-v4.1-flash`; the model is text+image with 1M context / 384k output.
- Filter retired `deepseek-v4-flash-vision-exp` ids from discovery and remove
  duplicate/retired entries from the example presets.
- Stop clamping configured output caps to the route default window.
- Invalidate in-flight discovery when the SSH forward changes; clear discovered
  models when discovery is disabled.
- Wait for tunnel readiness in `prepareCall`, and tear down accepted loopback
  sockets when a forward restarts.
- Persist the default credential reference when a key is entered without one,
  allow clearing optional settings fields, and write settings atomically with an
  exclusive temp file.
- Refuse discovery redirects and cap listing bodies.
- Remove committed test private keys and deployment-specific examples; tests
  generate throwaway keys at runtime.

## 0.2.1

- Add `openai-responses` and `anthropic-messages` protocols alongside chat
  completions, with per-model protocol overrides and correct Anthropic base path.
- Add built-in model-family facts for endpoints that publish ids only.
- Add access-driven model-list refresh, a manual refresh action, and image
  capability metadata.

## 0.2.0

- Initial public package shape: SSH tunnel, settings card, discovery, and
  `LlmAdapter` integration.
