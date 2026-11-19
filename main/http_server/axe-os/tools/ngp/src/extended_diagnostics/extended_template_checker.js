/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { OutOfBandDiagnosticCategory, ParseSourceSpan, } from '@angular/compiler';
/**
 * Mirrors `ExtendedTemplateCheckerImpl` in `ngtsc/typecheck/extended/src/extended_template_checker.ts`.
 */
export class ExtendedTemplateCheckerImpl {
    templateChecks;
    constructor(templateCheckFactories, options) {
        this.templateChecks = new Map();
        for (const factory of templateCheckFactories) {
            // Read the diagnostic category from compiler options.
            const category = diagnosticLabelToCategory(options?.extendedDiagnostics?.checks?.[factory.name] ??
                options?.extendedDiagnostics?.defaultCategory ??
                'warning');
            // Skip the diagnostic if suppressed via compiler options.
            if (category === null) {
                continue;
            }
            // Try to create the check.
            const check = factory.create(options);
            // Skip the diagnostic if it was disabled due to unsupported options.
            if (check === null) {
                continue;
            }
            // Use the check.
            this.templateChecks.set(check, category);
        }
    }
    getDiagnosticsForComponent(typeCheckId, component, boundTarget) {
        const template = component.templateNodes;
        const diagnostics = [];
        for (const [check, category] of this.templateChecks.entries()) {
            const ctx = {
                boundTarget,
                makeTemplateDiagnostic: (span, message, relatedInformation) => {
                    const start = span instanceof ParseSourceSpan ? span.start.offset : span.start;
                    const end = span instanceof ParseSourceSpan ? span.end.offset : span.end;
                    return {
                        typeCheckId,
                        category,
                        code: Math.abs(check.code),
                        message,
                        start,
                        end,
                        ...(relatedInformation ? { relatedInformation } : {}),
                    };
                },
            };
            diagnostics.push(...deduplicateDiagnostics(check.run(ctx, component, template)));
        }
        return diagnostics;
    }
}
/**
 * Filter out duplicated diagnostics, this is possible due to the way the compiler handles
 * structural directives (like `*ngIf`), where the compiler creates two nodes (`TmplAstTemplate`
 * and `TmplAstElement`) for the host element and binds the directive inputs to both of them.
 */
function deduplicateDiagnostics(diagnostics) {
    const seen = new Set();
    return diagnostics.filter((diag) => {
        const key = JSON.stringify([
            diag.typeCheckId,
            diag.sourceFilePath,
            diag.start,
            diag.end,
            diag.code,
            diag.category,
            diag.message,
        ]);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
/**
 * Converts a `DiagnosticCategoryLabel` to its equivalent `OutOfBandDiagnosticCategory` or `null` if
 * the label is `'suppress'`.
 */
export function diagnosticLabelToCategory(label) {
    switch (label) {
        case 'warning':
            return OutOfBandDiagnosticCategory.Warning;
        case 'error':
            return OutOfBandDiagnosticCategory.Error;
        case 'suppress':
            return null;
        default:
            return assertNever(label);
    }
}
function assertNever(value) {
    throw new Error(`Unexpected call to 'assertNever()' with value:\n${value}`);
}
