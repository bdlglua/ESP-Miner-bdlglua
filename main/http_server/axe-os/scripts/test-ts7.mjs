#!/usr/bin/env node
/**
 * AxeOS unit tests on TypeScript 7, without the TypeScript 6 compiler API.
 *
 *   1. ngp (tools/ngp) AOT-compiles the application and the test files, test-host
 *      components included; its Angular diagnostics stop the run.
 *   2. TypeScript 7 type-checks everything, tests and their templates included.
 *   3. Vitest runs the compiled tests in jsdom with the same TestBed environment as
 *      `ng test` (@angular/build:unit-test): zone.js + zone.js/testing,
 *      errorOnUnknownElements/Properties and the dynamic DOM test renderer.
 *
 * Usage: node scripts/test-ts7.mjs [vitest filters...]
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {architect, prepareWorkspace, rel, require, root, runNgp, step, typecheckTs7, walk} from './ts7-common.mjs';

const work = path.join(root, '.ts7-test');
const testOptions = architect.test?.options ?? {};
// ng test builds with the test target's buildTarget configuration (development here).
const configuration = (testOptions.buildTarget ?? '').split(':')[2];

prepareWorkspace(work, {configuration});
const ngpOut = runNgp(work, testOptions.tsConfig ?? 'tsconfig.spec.json');
// tsconfig files are JSON with comments; strings never contain comment markers here.
const specConfig = fs.readFileSync(path.join(work, 'tsconfig.spec.json'), 'utf8')
  .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''));
const specTypes = JSON.parse(specConfig).compilerOptions?.types ?? [];
typecheckTs7(ngpOut, {specs: true, types: specTypes});

const specs = walk(path.join(ngpOut, 'src')).filter((f) => f.endsWith('.spec.ts'));
const notCompiled = specs.filter((f) => /^\s*@(Component|Directive|Pipe|NgModule)\(/m.test(fs.readFileSync(f, 'utf8')));
if (notCompiled.length) throw new Error(`Test files left for JIT: ${notCompiled.map(rel).join(', ')}`);

// Same TestBed environment as the virtual init file of @angular/build:unit-test (vitest).
const setup = path.join(ngpOut, 'angular-test-setup.ts');
fs.writeFileSync(setup, `
import 'zone.js';
import 'zone.js/testing';
// Angular libraries in node_modules are partially compiled (ɵɵngDeclare*). ng test links
// them while bundling; Vitest loads them as they are, so they are linked at runtime (JIT
// linking). The application and its tests themselves are AOT-compiled by ngp.
import '@angular/compiler';
import {NgModule, provideZoneChangeDetection} from '@angular/core';
import {getTestBed, ɵgetCleanupHook as getCleanupHook, TestComponentRenderer} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {ɵgetDOM} from '@angular/common';
import {afterEach, beforeEach} from 'vitest';

beforeEach(getCleanupHook(false));
afterEach(getCleanupHook(true));

class DynamicDOMTestComponentRenderer extends TestComponentRenderer {
  override insertRootElement(rootElId: string, tagName = 'div') {
    this.removeAllRootElements();
    const doc = ɵgetDOM().getDefaultDocument();
    if (doc?.body) {
      const rootElement = doc.createElement(tagName);
      rootElement.setAttribute('id', rootElId);
      doc.body.appendChild(rootElement);
    }
  }
  override removeAllRootElements() {
    const doc = ɵgetDOM().getDefaultDocument();
    for (const element of Array.from(doc?.querySelectorAll?.('[id^=root]') ?? [])) element.remove();
  }
}

const ANGULAR_TESTBED_SETUP = Symbol.for('@angular/cli/testbed-setup');
const globals = globalThis as unknown as Record<symbol, boolean>;
if (!globals[ANGULAR_TESTBED_SETUP]) {
  globals[ANGULAR_TESTBED_SETUP] = true;
  @NgModule({
    providers: [
      ...(typeof Zone !== 'undefined' ? [provideZoneChangeDetection()] : []),
      {provide: TestComponentRenderer, useClass: DynamicDOMTestComponentRenderer},
    ],
  })
  class TestModule {}
  getTestBed().initTestEnvironment([BrowserTestingModule, TestModule], platformBrowserTesting(), {
    errorOnUnknownElements: true,
    errorOnUnknownProperties: true,
  });
}
`);

step(`Vitest (${specs.length} test files, jsdom)`);
const {startVitest} = await import(pathToFileURL(require.resolve('vitest/node')).href);
const vitest = await startVitest('test', process.argv.slice(2), {
  root: ngpOut,
  watch: false,
  run: true,
  config: false,
  environment: 'jsdom',
  globals: true,
  setupFiles: [setup],
  include: ['src/**/*.spec.ts'],
}, {
  // The application imports `src/...` (tsconfig paths): resolve it to the ngp output.
  resolve: {alias: [{find: /^src\//, replacement: `${path.join(ngpOut, 'src')}/`}]},
});
const failed = !vitest || [...(vitest.state?.getFiles?.() ?? [])].some((file) => file.result?.state === 'fail');
await vitest?.close();
fs.rmSync(work, {recursive: true, force: true});
process.exit(failed || process.exitCode ? 1 : 0);
