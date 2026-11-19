/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { ErrorCode } from './error_code.js';
/** In the order `DiagnosticCategoryLabel` declares its members, which the diagnostics list. */
const DIAGNOSTIC_CATEGORY_LABELS = ['warning', 'error', 'suppress'];
/**
 * Mirrors `SUPPORTED_DIAGNOSTIC_NAMES` in `ngtsc/typecheck/extended/index.ts`, in its iteration
 * order (the two option-only checks, then `ALL_DIAGNOSTIC_FACTORIES`), since the diagnostic
 * lists them. Keep in sync when a check is added upstream.
 */
export const SUPPORTED_DIAGNOSTIC_NAMES = new Set([
    'controlFlowPreventingContentProjection',
    'unusedStandaloneImports',
    'invalidBananaInBox',
    'nullishCoalescingNotNullable',
    'numericCssPropertyRequiresUnit',
    'optionalChainNotNullable',
    'missingControlFlowDirective',
    'textAttributeNotBinding',
    'missingNgForOfLet',
    'missingStructuralDirective',
    'suffixNotSupported',
    'interpolatedSignalNotInvoked',
    'uninvokedFunctionInEventBinding',
    'unusedLetDeclaration',
    'skipHydrationNotStatic',
    'unparenthesizedNullishCoalescing',
    'uninvokedTrackFunction',
    'uninvokedFunctionInTextInterpolation',
    'deferTriggerMisconfiguration',
]);
/**
 * Validates `extendedDiagnostics` compiler options, mirroring `verifyCompatibleTypeCheckOptions`
 * in `ngtsc/core/src/compiler.ts`.
 */
export function verifyExtendedDiagnosticsOptions(options) {
    if (!options.extendedDiagnostics) {
        return [];
    }
    const diagnostics = [];
    const configError = (code, messageText) => diagnostics.push({ category: 1, code: Math.abs(code), messageText });
    if (options.strictTemplates === false) {
        configError(ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_IMPLIES_STRICT_TEMPLATES, `
Angular compiler option "extendedDiagnostics" is configured, however "strictTemplates" is disabled.

Using "extendedDiagnostics" requires that "strictTemplates" is also enabled.

One of the following actions is required:
1. Remove "strictTemplates: false" to enable it.
2. Remove "extendedDiagnostics" configuration to disable them.
      `.trim());
    }
    const defaultCategory = options.extendedDiagnostics.defaultCategory;
    if (defaultCategory !== undefined && !DIAGNOSTIC_CATEGORY_LABELS.includes(defaultCategory)) {
        configError(ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CATEGORY_LABEL, `
Angular compiler option "extendedDiagnostics.defaultCategory" has an unknown diagnostic category: "${defaultCategory}".

Allowed diagnostic categories are:
${DIAGNOSTIC_CATEGORY_LABELS.join('\n')}
      `.trim());
    }
    for (const [checkName, category] of Object.entries(options.extendedDiagnostics.checks ?? {})) {
        if (!SUPPORTED_DIAGNOSTIC_NAMES.has(checkName)) {
            configError(ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CHECK, `
Angular compiler option "extendedDiagnostics.checks" has an unknown check: "${checkName}".

Allowed check names are:
${Array.from(SUPPORTED_DIAGNOSTIC_NAMES).join('\n')}
        `.trim());
        }
        if (!DIAGNOSTIC_CATEGORY_LABELS.includes(category)) {
            configError(ErrorCode.CONFIG_EXTENDED_DIAGNOSTICS_UNKNOWN_CATEGORY_LABEL, `
Angular compiler option "extendedDiagnostics.checks['${checkName}']" has an unknown diagnostic category: "${category}".

Allowed diagnostic categories are:
${DIAGNOSTIC_CATEGORY_LABELS.join('\n')}
        `.trim());
        }
    }
    return diagnostics;
}
/**
 * Validates the compiler options up front, the way `NgCompiler`'s constructor does
 * (`constructionDiagnostics`). These diagnostics have no file: they describe the tsconfig, not a
 * source location. ngtsc reports them before any other diagnostic and, if any is an error, skips
 * the rest of the compilation, so callers should check them first.
 * https://github.com/angular/angular/blob/e3ac727/packages/compiler-cli/src/ngtsc/core/src/compiler.ts#L1800-L1874
 */
export function verifyCompilerOptions(options) {
    const diagnostics = verifyExtendedDiagnosticsOptions(options);
    // `verifyEmitDeclarationOnly`
    if (options.emitDeclarationOnly && !options._experimentalAllowEmitDeclarationOnly) {
        diagnostics.push({
            category: 1,
            code: ErrorCode.CONFIG_EMIT_DECLARATION_ONLY_UNSUPPORTED,
            messageText: 'TS compiler option "emitDeclarationOnly" is not supported.',
        });
    }
    return diagnostics;
}
