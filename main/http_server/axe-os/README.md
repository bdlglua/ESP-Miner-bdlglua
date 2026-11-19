# AxeOS

AxeOS is built and tested with **TypeScript 7** only. The Angular CLI and TypeScript 6
are not installed: an Angular preprocessor (`ngp`, Angular 22.3.0 with local
patches, see [tools/ngp/README.md](tools/ngp/README.md)) compiles the components, and
TypeScript 7 type-checks the code and the templates.

## Development server

Run `npm start` (`scripts/serve-ts7.mjs`) for a dev server on `http://localhost:4200/`
(`--port`, `--host` to change it). It uses the `development` configuration of
`angular.json`, rebuilds when a source file changes and reloads open pages. A failed
rebuild is reported and the last good build stays served.

`npm run watch` rebuilds `dist/axe-os` on change, without a server.

## Build

Run `npm run build` (`scripts/build-ts7.mjs`, then gzip). The build artifacts are stored
in `dist/axe-os`; the firmware build (`idf.py build`) runs it and packs `www.bin`.
The `angular.json` production configuration applies: file replacements, optimization,
output hashing, licenses and budgets. `npm run bundle-report` also writes
`dist/axe-os/stats.json` (esbuild metafile).

A build stops on any Angular diagnostic (template, unknown element, stylesheet), any
TypeScript 7 error, an exceeded error budget, or a component left for JIT compilation.

## Running unit tests

Run `npm test` (`scripts/test-ts7.mjs`): the application and the tests are compiled by
`ngp`, type-checked by TypeScript 7, then run by Vitest in jsdom with the same `TestBed`
environment as `ng test`. Arguments are passed to Vitest as filters, e.g.
`npm test -- sats`.

`npm run typecheck` type-checks the sources (`tsconfig.app.json`, `tsconfig.spec.json`)
with TypeScript 7.

## Code scaffolding

`ng generate` is not available (no Angular CLI). Add components, services and pipes by
hand; any decorated class is compiled by `ngp`.
