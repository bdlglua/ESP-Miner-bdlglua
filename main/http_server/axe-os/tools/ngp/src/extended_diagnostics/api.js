/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { CombinedRecursiveAstVisitor, isNgTemplate, KeyedRead, NonNullAssert, ParenthesizedExpression, SafeCall, SafeKeyedRead, SafePropertyRead, VERSION, } from '@angular/compiler';
const versionSubDomain = VERSION.major !== '0' ? `v${VERSION.major}.` : '';
export const EXTENDED_ERROR_DETAILS_PAGE_BASE_URL = `https://${versionSubDomain}angular.dev/extended-diagnostics`;
/**
 * Mirrors `formatExtendedError` in `ngtsc/typecheck/extended/api/format-extended-error.ts`.
 */
export function formatExtendedError(code, message) {
    const fullCode = `NG${Math.abs(code)}`;
    const details = `Find more at ${EXTENDED_ERROR_DETAILS_PAGE_BASE_URL}/${fullCode}`;
    // The code isn't repeated in the message, because tools already print it from `Diagnostic.code`.
    if (!message) {
        return details;
    }
    const separator = /[.,;!?\n]$/.test(message) ? '' : '.';
    return `${message}${separator} ${details}`;
}
/**
 * This abstract class provides a base implementation for the run method, visiting all nodes in
 * the template and calling `visitNode()` for each one.
 *
 * Mirrors `TemplateCheckWithVisitor` in `ngtsc/typecheck/extended/api/api.ts`.
 */
export class TemplateCheckWithVisitor {
    /**
     * Base implementation for run function, visits all nodes in template and calls
     * `visitNode()` for each one.
     */
    run(ctx, component, template) {
        const visitor = new TemplateVisitor(ctx, component, this);
        return visitor.getDiagnostics(template);
    }
}
/**
 * Visits all nodes in a template (TmplAstNode and AST) and calls `visitNode` for each one.
 *
 * Mirrors `TemplateVisitor` in `ngtsc/typecheck/extended/api/api.ts`.
 */
class TemplateVisitor extends CombinedRecursiveAstVisitor {
    ctx;
    component;
    check;
    diagnostics = [];
    constructor(ctx, component, check) {
        super();
        this.ctx = ctx;
        this.component = component;
        this.check = check;
    }
    visit(node) {
        this.diagnostics.push(...this.check.visitNode(this.ctx, this.component, node));
        super.visit(node);
    }
    visitTemplate(template) {
        const isInlineTemplate = template.tagName && isNgTemplate(template.tagName);
        this.visitAllTemplateNodes(template.attributes);
        if (isInlineTemplate) {
            // Only visit input/outputs if this isn't an inline template node generated for a structural
            // directive (like `<div *ngIf></div>`). These nodes would be visited when the underlying
            // element of an inline template node is processed.
            this.visitAllTemplateNodes(template.inputs);
            this.visitAllTemplateNodes(template.outputs);
        }
        // `templateAttrs` aren't transferred over to the inner element so we always have to visit them.
        this.visitAllTemplateNodes(template.templateAttrs);
        this.visitAllTemplateNodes(template.variables);
        this.visitAllTemplateNodes(template.references);
        this.visitAllTemplateNodes(template.children);
    }
    getDiagnostics(template) {
        this.diagnostics = [];
        this.visitAllTemplateNodes(template);
        return this.diagnostics;
    }
}
/**
 * Checks if the given AST node originates from a KeyedRead (indexed access)
 * by unwrapping parentheses, non-null assertions, and traversing the receivers
 * of safe navigation operations (?. property access, ?.[] keyed access, ?.() calls).
 *
 * Mirrors `isAccessFromUncheckedIndex` in `ngtsc/typecheck/extended/api/api.ts`.
 */
export function isAccessFromUncheckedIndex(node) {
    if (node instanceof KeyedRead) {
        return true;
    }
    else if (node instanceof SafePropertyRead ||
        node instanceof SafeKeyedRead ||
        node instanceof SafeCall) {
        return isAccessFromUncheckedIndex(node.receiver);
    }
    else if (node instanceof ParenthesizedExpression || node instanceof NonNullAssert) {
        return isAccessFromUncheckedIndex(node.expression);
    }
    return false;
}
