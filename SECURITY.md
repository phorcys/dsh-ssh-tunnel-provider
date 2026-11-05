# Security policy

## Supported versions

Security fixes are made on the latest `0.2.x` release.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a
vulnerability) rather than a public issue. Do not paste API keys, private keys,
host names, or full `known_hosts` contents into an issue.

Include the affected version, a minimal reproduction, and the impact. I will
acknowledge a report as soon as practical and coordinate a fix and disclosure.

## Security model

- The SSH forward binds to `127.0.0.1`; it never opens a public listener.
- Host keys are checked against `known_hosts`. `accept-new` pins the first key;
  a changed pinned key is refused even with `strictHostKeyChecking: no`.
- The model API key is stored through the DSH credential service. The settings
  document contains only the credential reference and connection facts, never
  the key literal.
- The settings HTTP route is loopback-only, requires a per-process token, and
  rejects non-loopback `Host`/`Origin` values. It is not intended to be exposed
  through a reverse proxy.
- Discovery refuses redirects, so an `Authorization` header cannot be forwarded
  to another origin, and caps the listing body.

## Operational guidance

- Keep `$DSH_HOME/.ssh-tunnel-provider.<provider>.json` owner-readable only.
- Use `strictHostKeyChecking: yes` on untrusted networks.
- Prefer a dedicated SSH key with a forced-command/restricted account rather
  than a general-purpose login.
- Review dependency advisories in the DSH host; this plugin uses the host's
  `@deepseek-ai/dsh-*` packages and cannot patch them independently.

## Known non-goals

Image generation is not exposed through DSH's `LlmAdapter` stream, which carries
text, reasoning, and tool calls only. A gateway's image endpoint must be reached
by a separate tool/plugin that saves the result as a file.
