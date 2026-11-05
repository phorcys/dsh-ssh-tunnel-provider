# Contributing

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- npm (the test script uses npm; pnpm works for the same commands)
- A DSH checkout or installed `dsh` for manual verification

## Development

```sh
npm ci
npm run build
npm test
```

`npm test` compiles the Host half, copies the hand-written browser bundle, and
runs the unit, integration, web-route, and client-bundle suites. The integration
suite starts an in-process `ssh2.Server` and an HTTP mock; it never contacts a
real NAS.

After changing `src/`, rebuild `lib/` before committing:

```sh
npm run build
```

`lib/` is committed because a link install and the packaged tarball run it
directly. `npm pack --dry-run` should list only the package `files`.

## Privacy rules

- Never commit real SSH host names/IPs, user names, API keys, private keys, or
  `known_hosts` contents.
- Use documentation placeholders such as `nas.example`, `deploy`, and
  `SUB2API_API_KEY`.
- Tests must generate throwaway keys at runtime or use synthetic key material;
  no private key fixtures belong in the repository.
- Do not put credentials in examples, logs, or test names.

## Pull requests

- Keep behavior changes covered by a focused test.
- Preserve the English/Chinese README parity when changing user-facing docs.
- Explain any change to protocol selection, model aliases, host-key handling, or
  credential storage in the PR description.
- Run `npm test` and `npm pack --dry-run` before opening the PR.

## Release checklist

1. Bump `package.json` and update the tarball filename in both READMEs.
2. Add a `CHANGELOG.md` entry.
3. `npm test` and `npm pack --dry-run`.
4. Confirm the packed tree contains no private host/key material.
5. Tag the release after CI is green.
