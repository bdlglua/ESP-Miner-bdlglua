/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { BindingType, ParseSourceSpan, TmplAstBoundAttribute, TmplAstElement, OutOfBandDiagnosticCategory, } from '@angular/compiler';
import { ErrorCode } from './error_code.js';
/** Fallback code for generic template errors that do not have a dedicated `ErrorCode` member. */
const GENERIC_TEMPLATE_ERROR_CODE = 8000;
export class OutOfBandDiagnosticRecorderImpl {
    _diagnostics = [];
    /**
     * Tracks which `BindingPipe` nodes have already been recorded as invalid, so only one diagnostic
     * is ever produced per node.
     */
    recordedPipes = new Set();
    get diagnostics() {
        return this._diagnostics;
    }
    pushDiagnostic(typeCheckId, message, span, category = OutOfBandDiagnosticCategory.Error, code, relatedInformation) {
        let start;
        let end;
        if (span instanceof ParseSourceSpan) {
            start = span.start.offset;
            end = span.end.offset;
        }
        else {
            start = span.start;
            end = span.end;
        }
        this._diagnostics.push({
            typeCheckId,
            message,
            start,
            end,
            category,
            code: code !== undefined ? Math.abs(code) : undefined,
            ...(relatedInformation && relatedInformation.length > 0 ? { relatedInformation } : {}),
        });
    }
    error(id, message, span) {
        this.pushDiagnostic(id, message, span, OutOfBandDiagnosticCategory.Error, GENERIC_TEMPLATE_ERROR_CODE);
    }
    missingReferenceTarget(id, ref) {
        this.pushDiagnostic(id, `No directive found with exportAs '${ref.value.trim()}'.`, ref.valueSpan || ref.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.MISSING_REFERENCE_TARGET);
    }
    missingPipe(id, ast) {
        if (this.recordedPipes.has(ast)) {
            return;
        }
        this.pushDiagnostic(id, `No pipe found with name '${ast.name}'.`, ast.nameSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.MISSING_PIPE);
        this.recordedPipes.add(ast);
    }
    deferredPipeUsedEagerly(id, ast, currentBlockName = null, declaredBlocks = null) {
        if (this.recordedPipes.has(ast)) {
            return;
        }
        let errorMsg;
        if (currentBlockName !== null && declaredBlocks !== null && declaredBlocks.length > 0) {
            errorMsg =
                `Pipe '${ast.name}' was imported via \`@Component.deferredImports\` under block '${declaredBlocks.join(', ')}', ` +
                    `but is used in a \`@defer\` block configured for '${currentBlockName}'. ` +
                    `To fix this, add '${ast.name}' to 'deferredImports.${currentBlockName}'.`;
        }
        else {
            errorMsg =
                `Pipe '${ast.name}' was imported via \`@Component.deferredImports\`, ` +
                    `but was used outside of a \`@defer\` block in a template. To fix this, either ` +
                    `use the '${ast.name}' pipe inside of a \`@defer\` block or import this dependency ` +
                    `using the \`@Component.imports\` field.`;
        }
        this.pushDiagnostic(id, errorMsg, ast.nameSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.DEFERRED_PIPE_USED_EAGERLY);
        this.recordedPipes.add(ast);
    }
    deferredComponentUsedEagerly(id, element, dirMeta, currentBlockName = null, declaredBlocks = null) {
        const elementName = element instanceof TmplAstElement ? element.name : (element.tagName ?? 'ng-template');
        const kind = dirMeta?.isComponent ? 'Component' : 'Directive';
        const name = dirMeta?.name ?? elementName;
        const usage = dirMeta?.isComponent
            ? `used as element '${elementName}'`
            : `used on element '${elementName}'`;
        let errorMsg;
        if (currentBlockName !== null && declaredBlocks !== null && declaredBlocks.length > 0) {
            errorMsg =
                `${kind} '${name}' (${usage}) was imported via \`@Component.deferredImports\` ` +
                    `under block '${declaredBlocks.join(', ')}', but is used in a \`@defer\` block configured for '${currentBlockName}'. ` +
                    `To fix this, add '${name}' to 'deferredImports.${currentBlockName}'.`;
        }
        else {
            errorMsg =
                `${kind} '${name}' (${usage}) was imported via \`@Component.deferredImports\`, ` +
                    `but was used outside of a \`@defer\` block in a template. To fix this, either ` +
                    `use the '${elementName}' element inside of a \`@defer\` block or ` +
                    `import '${name}' using the \`@Component.imports\` field.`;
        }
        const startSourceSpan = element.startSourceSpan ?? element.sourceSpan;
        this.pushDiagnostic(id, errorMsg, startSourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.DEFERRED_DIRECTIVE_USED_EAGERLY);
    }
    duplicateTemplateVar(id, variable, firstDecl) {
        this.pushDiagnostic(id, `Cannot redeclare variable '${variable.name}' as it was previously declared elsewhere for the same template.`, variable.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.DUPLICATE_VARIABLE_DECLARATION, [
            {
                message: `The variable '${firstDecl.name}' was first declared here.`,
                start: firstDecl.sourceSpan.start.offset,
                end: firstDecl.sourceSpan.end.offset,
            },
        ]);
    }
    suboptimalTypeInference(id, variables) {
        let diagnosticVar = null;
        for (const variable of variables) {
            if (diagnosticVar === null || variable.value === '' || variable.value === '$implicit') {
                diagnosticVar = variable;
            }
        }
        if (diagnosticVar === null)
            return;
        let varIdentification = `'${diagnosticVar.name}'`;
        if (variables.length === 2) {
            varIdentification += ` (and 1 other)`;
        }
        else if (variables.length > 2) {
            varIdentification += ` (and ${variables.length - 1} others)`;
        }
        this.pushDiagnostic(id, `This structural directive supports advanced type inference, but the current compiler ` +
            `configuration prevents its usage. The variable ${varIdentification} will have type ` +
            `'any' as a result.\n\nConsider enabling the 'strictTemplates' option in your ` +
            `tsconfig.json for better type inference within this template.`, diagnosticVar.keySpan, OutOfBandDiagnosticCategory.Warning, ErrorCode.SUGGEST_SUBOPTIMAL_TYPE_INFERENCE);
    }
    splitTwoWayBinding(id, input, output, inputConsumer, outputConsumer) {
        const relatedInformation = [];
        if (inputConsumer.ref.nodeNameSpan && inputConsumer.ref.nodeFilePath) {
            relatedInformation.push({
                message: `The property half of the binding is to the '${inputConsumer.name}' ${inputConsumer.isComponent ? 'component' : 'directive'}.`,
                start: inputConsumer.ref.nodeNameSpan.start,
                end: inputConsumer.ref.nodeNameSpan.end,
                sourceFilePath: inputConsumer.ref.nodeFilePath,
            });
        }
        if (outputConsumer instanceof TmplAstElement) {
            let message = `The event half of the binding is to a native event called '${input.name}' on the <${outputConsumer.name}> DOM element.`;
            if (!inputConsumer.ref.nodeFilePath?.endsWith('.d.ts')) {
                message += `\n \n Are you missing an output declaration called '${output.name}'?`;
            }
            relatedInformation.push({
                message,
                start: outputConsumer.sourceSpan.start.offset + 1,
                end: outputConsumer.sourceSpan.start.offset + outputConsumer.name.length + 1,
            });
        }
        else if (outputConsumer.ref.nodeNameSpan && outputConsumer.ref.nodeFilePath) {
            relatedInformation.push({
                message: `The event half of the binding is to the '${outputConsumer.name}' ${outputConsumer.isComponent ? 'component' : 'directive'}.`,
                start: outputConsumer.ref.nodeNameSpan.start,
                end: outputConsumer.ref.nodeNameSpan.end,
                sourceFilePath: outputConsumer.ref.nodeFilePath,
            });
        }
        this.pushDiagnostic(id, `The property and event halves of the two-way binding '${input.name}' are not bound ` +
            `to the same target.\n            ` +
            `Find more at https://angular.dev/guide/templates/two-way-binding`, input.keySpan, OutOfBandDiagnosticCategory.Error, ErrorCode.SPLIT_TWO_WAY_BINDING, relatedInformation);
    }
    missingRequiredInputs(id, element, directiveName, isComponent, inputAliases) {
        const aliasString = inputAliases.map((n) => `'${n}'`).join(', ');
        const type = isComponent ? 'component' : 'directive';
        this.pushDiagnostic(id, `Required input${inputAliases.length === 1 ? '' : 's'} ${aliasString} from ${type} ${directiveName} must be specified.`, this.getTagNameSpan(element), OutOfBandDiagnosticCategory.Error, ErrorCode.MISSING_REQUIRED_INPUTS);
    }
    illegalForLoopTrackAccess(id, block, access) {
        const messageVars = [
            block.item,
            ...(block.contextVariables || []).filter((v) => v.value === '$index'),
        ]
            .map((v) => `'${v.name}'`)
            .join(', ');
        this.pushDiagnostic(id, `Cannot access '${access.name}' inside of a track expression. ` +
            `Only ${messageVars} and properties on the containing component are available to this expression.`, access.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.ILLEGAL_FOR_LOOP_TRACK_ACCESS);
    }
    inaccessibleDeferredTriggerElement(id, trigger) {
        if (trigger.reference === null) {
            this.pushDiagnostic(id, `Trigger cannot find reference. Make sure that the @defer block has a @placeholder with at least one root element node.`, trigger.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.INACCESSIBLE_DEFERRED_TRIGGER_ELEMENT);
        }
        else {
            this.pushDiagnostic(id, `Trigger cannot find reference "${trigger.reference}".\nCheck that an element ` +
                `with #${trigger.reference} exists in the same template and it's accessible ` +
                `from the @defer block.\nDeferred blocks can only access triggers in same view, ` +
                `a parent embedded view or the root view of the @placeholder block.`, trigger.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.INACCESSIBLE_DEFERRED_TRIGGER_ELEMENT);
        }
    }
    controlFlowPreventingContentProjection(id, category, node, componentName, selector, controlFlowNode, preservesWhitespaces) {
        const blockName = controlFlowNode?.nameSpan?.toString().trim() || 'block';
        let msg = `Node matches the "${selector}" slot of the "${componentName}" component, but will not be projected into the specific slot because the surrounding ${blockName} has more than one node at its root. To project the node in the right slot, you can:\n\n` +
            `1. Wrap the content of the ${blockName} block in an <ng-container ngProjectAs="${selector}"> to explicitly target the "${selector}" slot. Use this when all nodes in the block should be projected into the same slot.\n` +
            `2. Split the content of the ${blockName} block across multiple ${blockName} blocks such that each one only has a single projectable node at its root. Use this when nodes in the block target different slots.\n` +
            `3. Remove all content from the ${blockName} block, except for the node being projected.\n`;
        if (preservesWhitespaces) {
            msg +=
                '\nNote: the host component has `preserveWhitespaces: true` which may cause whitespace to affect content projection.\n';
        }
        msg +=
            '\nThis check can be disabled using the `extendedDiagnostics.checks.controlFlowPreventingContentProjection = "suppress"` compiler option.';
        this.pushDiagnostic(id, msg, node.startSourceSpan, category, ErrorCode.CONTROL_FLOW_PREVENTING_CONTENT_PROJECTION);
    }
    illegalWriteToLetDeclaration(id, node, target) {
        this.pushDiagnostic(id, `Cannot assign to @let declaration '${target.name}'.`, node.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.ILLEGAL_LET_WRITE);
    }
    letUsedBeforeDefinition(id, node, target) {
        this.pushDiagnostic(id, `Cannot read @let declaration '${target.name}' before it has been defined.`, node.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.LET_USED_BEFORE_DEFINITION);
    }
    conflictingDeclaration(id, decl) {
        this.pushDiagnostic(id, `Cannot declare @let called '${decl.name}' as there is another symbol in the template with the same name.`, decl.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.CONFLICTING_LET_DECLARATION);
    }
    deferImplicitTriggerMissingPlaceholder(id, trigger) {
        this.pushDiagnostic(id, 'Trigger with no target can only be placed on an @defer that has a @placeholder block', trigger.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.DEFER_IMPLICIT_TRIGGER_MISSING_PLACEHOLDER);
    }
    deferImplicitTriggerInvalidPlaceholder(id, trigger) {
        this.pushDiagnostic(id, 'Trigger with no target can only be placed on an @defer that has a ' +
            '@placeholder block with exactly one root element node', trigger.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.DEFER_IMPLICIT_TRIGGER_INVALID_PLACEHOLDER);
    }
    formFieldUnsupportedBinding(id, node) {
        let message;
        if (node instanceof TmplAstBoundAttribute) {
            let name;
            if (node.type === BindingType.Property) {
                name = `[${node.name}]`;
            }
            else if (node.type === BindingType.Attribute) {
                name = `[attr.${node.name}]`;
            }
            else if (node.type === BindingType.TwoWay) {
                name = `[(${node.name})]`;
            }
            else {
                // We shouldn't hit this, but we have this logic as a fallback.
                name = node.name;
            }
            message = `Binding to '${name}' is not allowed on nodes using the '[formField]' directive`;
        }
        else {
            message = `Setting the '${node.name}' attribute is not allowed on nodes using the '[formField]' directive`;
        }
        this.pushDiagnostic(id, message, node.sourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.FORM_FIELD_UNSUPPORTED_BINDING);
    }
    multipleMatchingComponents(id, element, componentNames) {
        const names = componentNames.map((n) => `'${n}'`).join(', ');
        this.pushDiagnostic(id, `Multiple components match node with tagname ${element.name}: ${names}.`, element.startSourceSpan, OutOfBandDiagnosticCategory.Error, ErrorCode.MULTIPLE_MATCHING_COMPONENTS);
    }
    conflictingHostDirectiveBinding(id, node, directiveName, kind, classPropertyName, aliases) {
        const message = `${kind === 'input' ? 'Input' : 'Output'} declared in ${directiveName}.${classPropertyName} ` +
            `is exposed under the following conflicting names: ${aliases.map((a) => `"${a}"`).join(', ')}. ` +
            `An ${kind} can only be exposed under a single name.`;
        this.pushDiagnostic(id, message, this.getTagNameSpan(node), OutOfBandDiagnosticCategory.Error, ErrorCode.CONFLICTING_HOST_DIRECTIVE_BINDING);
    }
    /**
     * Span covering only the tag name of a node, since highlighting the entire start tag can be
     * noisy. Falls back to the whole start tag for nodes without a name (e.g. `<ng-template>`).
     */
    getTagNameSpan(node) {
        let name;
        if (node instanceof TmplAstElement) {
            name = node.name;
        }
        else {
            name = null;
        }
        if (name === null) {
            return node.startSourceSpan;
        }
        const start = node.startSourceSpan.start.moveBy(1);
        const end = node.startSourceSpan.end.moveBy(start.offset + name.length - node.startSourceSpan.end.offset);
        return new ParseSourceSpan(start, end);
    }
}
