# ngp — préprocesseur Angular modifié, compilé avec TypeScript 7

AxeOS est compilé (`scripts/build-ts7.mjs`) et testé (`scripts/test-ts7.mjs`)
**sans l'API de TypeScript 6** ; les étapes communes sont dans `scripts/ts7-common.mjs` :

1. `ngp` compile les composants à l'avance (AOT), compile leurs styles Sass et
   génère les blocs de vérification des templates (`*.ngtypecheck.ts`). Ses
   diagnostics Angular (template invalide, élément inconnu, feuille de style
   manquante ou invalide…) arrêtent la compilation ;
2. **TypeScript 7** vérifie tout le code, templates compris ; une erreur arrête
   la compilation ;
3. esbuild assemble l'application, avec le linker Angular pour les
   bibliothèques partiellement compilées.

Le projet n'utilise plus que **TypeScript 7** : ni TypeScript 6 ni l'Angular CLI ne sont
installés. Commandes : `npm start` (serveur de développement, `scripts/serve-ts7.mjs`),
`npm run build`, `npm test`, `npm run watch`, `npm run bundle-report` (voir le
[README d'AxeOS](../../README.md)). La configuration d'`angular.json` est appliquée
comme par `ng build` : remplacements de fichiers, optimisation, source maps, empreintes,
licences et **budgets** (mesurés comme l'Angular CLI). `@angular/compiler-cli` ne sert
qu'à son linker, qui n'utilise pas TypeScript ; `.npmrc` (`legacy-peer-deps`) ignore sa
dépendance « pair » TypeScript 6 déclarée, les dépendances « pair » utiles étant listées
explicitement.

## Provenance

| Élément | Origine |
| --- | --- |
| `*.js` | `packages/compiler-cli/preprocessor` d'Angular **22.3.0**, **modifié** (`patches/`), compilé par **TypeScript 7.0.2** |
| `ng_analyze.node` | crate Rust `ng-analyze` (oxc) du même dépôt, non modifié, `cargo build --features napi`, module N-API |
| Archive source | étiquette GitHub `v22.3.0` (`https://github.com/angular/angular/archive/refs/tags/v22.3.0.zip`), SHA-256 `ff9010cfda765fc2731152b1eebe9047e0365382553c7180c9d9e26390c33f6a` |
| Licence | MIT (`LICENSE`, Google LLC) |

Reconstruction : `tools/ngp/rebuild.sh <archive v22.3.0.zip>`
(Node, npm, git, Rust/cargo). Le script applique `patches/*.patch` dans l'ordre ;
le résultat est reproductible au bit près.

## Modifications d'Angular

### 1. Styles Sass des composants

[`patches/0001-ngp-compile-sass-component-styles.patch`](patches/0001-ngp-compile-sass-component-styles.patch)
(6 fichiers, +269/−4 lignes). Avec ngtsc, le prétraitement des styles revient à
l'Angular CLI (`transformResource`) ; `ngp` n'en avait pas et intégrait le Sass
tel quel. Il applique maintenant les mêmes règles que l'Angular CLI :

- `styleUrl(s)` et `<link rel="stylesheet">` des templates selon l'extension
  (`.scss`, `.sass` ; les autres fichiers sont inchangés) ;
- `styles` intégrés au composant selon `inlineStyleLanguage` de `angular.json`
  (ou `--inline-style-language css|scss|sass`) ;
- chemins Sass : `stylePreprocessorOptions.includePaths` et `node_modules` ;
- `sass` est pris dans l'espace de travail, et chargé seulement si nécessaire ;
- une feuille de style qui ne compile pas produit l'erreur **NG2008**, avec le
  message de Sass et la position de son `styleUrl`.

Tests (mini-projet dédié) : fichier `.scss` avec variables, mixin et `@use` via
`includePaths` ; `.sass` en syntaxe indentée ; styles intégrés en SCSS ; `.css`
inchangé ; `<link>` vers un `.scss` ; SCSS invalide → NG2008.

### 2. Minification des styles des composants

[`patches/0002-ngp-minify-component-styles.patch`](patches/0002-ngp-minify-component-styles.patch)
(2 fichiers, +33/−6 lignes). Option `--minify-styles`, utilisée pour les compilations
optimisées (production) : comme l'Angular CLI avec `optimization.styles`, les styles des
composants sont minifiés avant l'encapsulation (Sass en style compressé ; CSS simple via
la syntaxe CSS de Sass, laissé intact si Sass ne peut pas le lire). Sans elle, le CSS des
composants arrivait non minifié dans `main.js`.

### Marqueurs d'autocomplétion

Aucune modification pour les marqueurs d'autocomplétion `this. /*T:COMPCOMP*/` :
ils n'apparaissent qu'avec `--enable-template-type-checker`, le mode éditeur,
que la compilation n'utilise pas (ngtsc ne l'active pas non plus pour `ng build`).

## Limites

- **Prototype de l'équipe Angular**, non publié sur npm. Il exige la même
  version de `@angular/compiler` que l'application (22.3.0) : une mise à jour
  d'Angular demande de reconstruire `ngp` depuis la même version (`rebuild.sh`).
  Les patches s'appliquent sur 22.3.0-rc.0 et 22.3.0.
- `ng_analyze.node` est un binaire **Linux x86-64** : à recompiler avec
  `rebuild.sh` sur une autre plateforme.
- Les tests unitaires passent aussi par TypeScript 7 (`npm test`,
  `scripts/test-ts7.mjs`) : ngp compile l'application et les tests, TypeScript 7
  les vérifie, Vitest les exécute dans jsdom avec le même environnement `TestBed`
  que `ng test`. Seule différence : les bibliothèques Angular de `node_modules`
  sont liées à l'exécution (JIT linking via `@angular/compiler`) au lieu de
  l'être pendant l'assemblage.
- `ng generate` n'est plus disponible (pas d'Angular CLI).
- `angular.json` garde les noms de builders `@angular/build:*` : il ne sert plus que de
  fichier de configuration, lu par `ngp` et par les scripts.

## Validation (18 novembre 2026)

- Angular 22.3.0 (définitive, sortie le 18 novembre) : patches appliqués sans conflit,
  `ngp` reconstruit, 65/65 tests, et 9 pages identiques à `ng build` (CLI 22.3.0-rc.0,
  le CLI 22.3.0 n'étant pas encore publié) dans Chrome ; interface installée sur le mineur.

- 82 blocs de vérification ; TypeScript 7 : 0 erreur ; ngp : 0 diagnostic.
- La compilation s'arrête sur du SCSS invalide (NG2008), un élément inconnu
  (NG8001) et une erreur de type dans un template (TS2322).
- 80 sources assemblées, dont 52 compilées à l'avance ; aucune ne nécessite le JIT.
- Application identique au bit près avec et sans la modification (anciens
  contournements dans le script de compilation).
- Tests unitaires sous TypeScript 7 : 30 fichiers, 65 tests réussis (comme
  `ng test`), 111 blocs de vérification ; deux défauts injectés (calcul d'un pipe,
  exception dans un composant) font échouer les 6 tests concernés.
- TypeScript 6 retiré : compilation, tests (65/65) et vérification des types sous
  TypeScript 7.0.2 seul ; le script refuse une autre version.
- Styles minifiés : plus gros style de composant 1,52 Ko (`PoolComponent`), comme
  `ng build` ; un budget d'erreur dépassé arrête la compilation.
- Serveur de développement : recompilation et rechargement après modification ; une
  erreur est signalée et la dernière version correcte reste servie.
- Chrome, données réelles du mineur, comparé à `ng build` : les 9 pages identiques
  (même texte, aucune erreur JavaScript, 7 pages identiques au pixel près, les autres
  ne diffèrent que par les valeurs en direct).
