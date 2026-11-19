/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
/**
 * Component stylesheet preprocessing (Sass) for ngp.
 *
 * ngtsc leaves this to its resource host (`ResourceHost.transformResource`, implemented by the
 * Angular CLI). ngp runs without the CLI, so it applies the same rules itself:
 * - a stylesheet file is compiled according to its extension (`.scss`, `.sass`);
 * - inline `styles` use the `inlineStyleLanguage` build option of `angular.json`;
 * - `stylePreprocessorOptions.includePaths` extend the Sass load paths;
 * - with `minify` (production builds), component styles are minified, as the Angular CLI does
 *   when `optimization.styles` is on. Plain CSS is minified through Sass's CSS syntax; a
 *   stylesheet Sass cannot parse as plain CSS is kept unminified rather than rejected.
 *
 * `sass` is resolved from the workspace and only loaded once a Sass stylesheet is found, so
 * CSS-only applications do not need it.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
/** A stylesheet that could not be compiled; `file` is null for inline styles. */
export class StylePreprocessError extends Error {
    file;
    constructor(message, file) {
        super(message);
        this.file = file;
    }
}
const STYLE_LANGUAGES = new Set(['css', 'scss', 'sass', 'less']);
export function isStyleLanguage(value) {
    return typeof value === 'string' && STYLE_LANGUAGES.has(value);
}
export class StylePreprocessor {
    options;
    inlineStyleLanguage;
    loadPaths;
    sass = null;
    constructor(options) {
        this.options = options;
        this.inlineStyleLanguage = options.inlineStyleLanguage ?? 'css';
        this.loadPaths = [
            ...(options.includePaths ?? []).map((p) => path.resolve(options.workspaceRoot, p)),
            path.join(options.workspaceRoot, 'node_modules'),
        ];
    }
    /** The language of a stylesheet file, from its extension (CSS when unknown). */
    static languageOf(file) {
        switch (path.extname(file).toLowerCase()) {
            case '.scss':
                return 'scss';
            case '.sass':
                return 'sass';
            case '.less':
                return 'less';
            default:
                return 'css';
        }
    }
    /** Compiles a stylesheet file's content to CSS. */
    processFile(content, file) {
        return this.compile(content, StylePreprocessor.languageOf(file), file, file);
    }
    /**
     * Compiles an inline style of the component declared in `componentFile`. Relative imports
     * resolve from the component's directory, as with the Angular CLI.
     */
    processInline(content, componentFile) {
        return this.compile(content, this.inlineStyleLanguage, componentFile, null);
    }
    compile(content, language, containingFile, reportedFile) {
        if (language === 'css') {
            return this.options.minify ? this.minifyCss(content, containingFile) : content;
        }
        if (language === 'less') {
            throw new StylePreprocessError('Less stylesheets are not supported by ngp.', reportedFile);
        }
        const sass = this.loadSass(reportedFile);
        try {
            return sass.compileString(content, {
                syntax: language === 'sass' ? 'indented' : 'scss',
                url: pathToFileURL(containingFile),
                loadPaths: [path.dirname(containingFile), ...this.loadPaths],
                style: this.options.minify ? 'compressed' : 'expanded',
            }).css;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new StylePreprocessError(message, reportedFile);
        }
    }
    /** Plain CSS minified by Sass; unchanged when Sass is absent or cannot parse it. */
    minifyCss(content, containingFile) {
        let sass;
        try {
            sass = this.loadSass(null);
        }
        catch {
            return content;
        }
        try {
            return sass.compileString(content, {
                syntax: 'css',
                url: pathToFileURL(containingFile),
                loadPaths: [],
                style: 'compressed',
            }).css;
        }
        catch {
            return content;
        }
    }
    loadSass(file) {
        if (this.sass === null) {
            const workspaceRequire = createRequire(path.join(this.options.workspaceRoot, 'package.json'));
            try {
                this.sass = workspaceRequire('sass');
            }
            catch {
                throw new StylePreprocessError(`Compiling Sass stylesheets requires the 'sass' package in the workspace ` +
                    `(${this.options.workspaceRoot}).`, file);
            }
        }
        return this.sass;
    }
}
