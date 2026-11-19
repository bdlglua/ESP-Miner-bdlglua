/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { AST, ASTWithSource, TmplAstLetDeclaration } from '@angular/compiler';
import { ErrorCode } from '../../error_code.js';
import { formatExtendedError, TemplateCheckWithVisitor, } from '../api.js';
/**
 * Ensures that all `@let` declarations in a template are used.
 *
 * Mirrors `UnusedLetDeclarationCheck` in
 * `ngtsc/typecheck/extended/checks/unused_let_declaration/index.ts`.
 */
class UnusedLetDeclarationCheck extends TemplateCheckWithVisitor {
    code = ErrorCode.UNUSED_LET_DECLARATION;
    analysis = new Map();
    run(ctx, component, template) {
        super.run(ctx, component, template);
        const diagnostics = [];
        const { allLetDeclarations, usedLetDeclarations } = this.getAnalysis(component);
        for (const decl of allLetDeclarations) {
            if (!usedLetDeclarations.has(decl)) {
                diagnostics.push(ctx.makeTemplateDiagnostic(decl.sourceSpan, formatExtendedError(ErrorCode.UNUSED_LET_DECLARATION, `@let ${decl.name} is declared but its value is never read.`)));
            }
        }
        this.analysis.clear();
        return diagnostics;
    }
    visitNode(ctx, component, node) {
        if (node instanceof TmplAstLetDeclaration) {
            this.getAnalysis(component).allLetDeclarations.add(node);
        }
        else if (node instanceof AST) {
            const unwrappedNode = node instanceof ASTWithSource ? node.ast : node;
            const target = ctx.boundTarget.getExpressionTarget(unwrappedNode);
            if (target !== null && target instanceof TmplAstLetDeclaration) {
                this.getAnalysis(component).usedLetDeclarations.add(target);
            }
        }
        return [];
    }
    getAnalysis(component) {
        if (!this.analysis.has(component)) {
            this.analysis.set(component, {
                allLetDeclarations: new Set(),
                usedLetDeclarations: new Set(),
            });
        }
        return this.analysis.get(component);
    }
}
export const factory = {
    code: ErrorCode.UNUSED_LET_DECLARATION,
    name: 'unusedLetDeclaration',
    create: () => new UnusedLetDeclarationCheck(),
};
