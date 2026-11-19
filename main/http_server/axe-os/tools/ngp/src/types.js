/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
/** Which primitive a `ConstEnumMemberMetadata.value` encodes. */
export var ConstEnumMemberKind;
(function (ConstEnumMemberKind) {
    ConstEnumMemberKind["String"] = "string";
    ConstEnumMemberKind["Number"] = "number";
    ConstEnumMemberKind["Boolean"] = "boolean";
    ConstEnumMemberKind["Null"] = "null";
    ConstEnumMemberKind["Undefined"] = "undefined";
})(ConstEnumMemberKind || (ConstEnumMemberKind = {}));
export var ExpressionValueKindMetadata;
(function (ExpressionValueKindMetadata) {
    ExpressionValueKindMetadata["String"] = "string";
    ExpressionValueKindMetadata["Identifier"] = "identifier";
    ExpressionValueKindMetadata["Unspecified"] = "unspecified";
})(ExpressionValueKindMetadata || (ExpressionValueKindMetadata = {}));
export var FileUpdateType;
(function (FileUpdateType) {
    FileUpdateType[FileUpdateType["Created"] = 0] = "Created";
    FileUpdateType[FileUpdateType["Deleted"] = 1] = "Deleted";
    FileUpdateType[FileUpdateType["Changed"] = 2] = "Changed";
})(FileUpdateType || (FileUpdateType = {}));
export var IsolatedTypeElementKind;
(function (IsolatedTypeElementKind) {
    /**
     * `typeof <span|refs>`: an entity-name expression (`Foo`, `ns.Foo`), optionally
     * pre-evaluated to one or more references when it aliases a local const.
     */
    IsolatedTypeElementKind["Typeof"] = "typeof";
    /**
     * `ReturnType<typeof <span>>`: a call expression whose callee is an entity name
     * (`StoreModule.forFeature(...)`, `fn()`), where `span` covers the callee.
     */
    IsolatedTypeElementKind["CallReturnType"] = "callReturnType";
    /**
     * `[typeof A, typeof B, ...]`: an element that locally evaluates to an array of
     * references.
     */
    IsolatedTypeElementKind["ReferenceTuple"] = "referenceTuple";
    /** `never`: an expression that cannot be represented with `typeof`. */
    IsolatedTypeElementKind["Never"] = "never";
})(IsolatedTypeElementKind || (IsolatedTypeElementKind = {}));
