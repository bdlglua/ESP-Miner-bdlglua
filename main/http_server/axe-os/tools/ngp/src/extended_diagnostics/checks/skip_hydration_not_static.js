/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { TmplAstBoundAttribute, TmplAstTextAttribute } from '@angular/compiler';
import { ErrorCode } from '../../error_code.js';
import { formatExtendedError, TemplateCheckWithVisitor, } from '../api.js';
const NG_SKIP_HYDRATION_ATTR_NAME = 'ngSkipHydration';
/**
 * Ensures that the special attribute `ngSkipHydration` is not a binding and has no other
 * value than `"true"` or an empty value.
 *
 * Mirrors `NgSkipHydrationSpec` in
 * `ngtsc/typecheck/extended/checks/skip_hydration_not_static/index.ts`.
 */
class NgSkipHydrationSpec extends TemplateCheckWithVisitor {
    code = ErrorCode.SKIP_HYDRATION_NOT_STATIC;
    visitNode(ctx, _component, node) {
        if (node instanceof TmplAstBoundAttribute && node.name === NG_SKIP_HYDRATION_ATTR_NAME) {
            const errorString = formatExtendedError(ErrorCode.SKIP_HYDRATION_NOT_STATIC, `ngSkipHydration should not be used as a binding`);
            return [ctx.makeTemplateDiagnostic(node.sourceSpan, errorString)];
        }
        const acceptedValues = ['true', ''];
        if (node instanceof TmplAstTextAttribute &&
            node.name === NG_SKIP_HYDRATION_ATTR_NAME &&
            !acceptedValues.includes(node.value) &&
            node.value !== undefined) {
            const errorString = formatExtendedError(ErrorCode.SKIP_HYDRATION_NOT_STATIC, `ngSkipHydration only accepts "true" or "" as value or no value at all. For example 'ngSkipHydration="true"' or 'ngSkipHydration'`);
            return [ctx.makeTemplateDiagnostic(node.sourceSpan, errorString)];
        }
        return [];
    }
}
export const factory = {
    code: ErrorCode.SKIP_HYDRATION_NOT_STATIC,
    name: 'skipHydrationNotStatic',
    create: () => new NgSkipHydrationSpec(),
};
