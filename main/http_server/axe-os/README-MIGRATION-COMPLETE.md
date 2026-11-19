# AxeOS v2.13.2 — mise à niveau complète du frontend (EXPÉRIMENTALE)

Cette branche part du correctif Peercoin/PPLNS V2 et de la migration Angular 22/PrimeNG 22 avec `@openng/ngx-toastr`. Elle est **non compilée** et **non testée sur Bitaxe** (registre npm non accessible dans l’environnement de préparation). Conserver le `www.bin` V2 stable.

## Modifications préparées

- Angular 22 + PrimeNG 22 conservés ; `@angular-devkit/build-angular` (Webpack) remplacé par `@angular/build` (esbuild).
- `angular.json`: application builder ; sortie directe dans `dist/axe-os` (indispensable au partitionnement SPIFFS).
- `@angular/platform-browser-dynamic` remplacé par `platformBrowser` de `@angular/platform-browser`.
- `@angular/animations` retiré des imports de l’application ; sous-menus migrés vers une transition CSS. Les animations PrimeNG sont à tester à l’écran.
- Karma/Jasmine retirés au profit de Vitest et jsdom ; `.spec.ts` adaptés pour les assertions booléennes. Les suites de tests restent à exécuter et à éventuellement adapter.
- Dépendances inutilisées `chokidar` et `webpack-bundle-analyzer` retirées ; commande `bundle-report` produit les stats de build sans l’ancien analyzer Webpack.
- CMake utilise `npm ci` après génération du lockfile (nécessite la préparation ci-dessous).

## Préparation sous CachyOS/Fish

```fish
cd ~/ESP-Miner-2.13.2/main/http_server/axe-os
node --version  # Node 22.22.3+, 24.15+ ou 26+ (version prise en charge Angular 22)
rm -rf node_modules package-lock.json
npm install
npm install-scripts ls
# Après vérification du script, pour que l'exécutable esbuild soit disponible :
npm install-scripts approve esbuild
npm rebuild esbuild
npm ls @angular/build @angular/core @angular/compiler-cli primeng vitest jsdom
npm audit
npm explain inflight
npm explain rimraf
npm explain glob

# Vérifier la compilation frontend et les tests avant tout flash :
env AXEOS_WEB_VERSION=v2.13.2 npm run build:no-api-gen
npm test

# Ensuite, depuis la racine du projet, et après activation ESP-IDF :
cd ../../..
source ~/esp/esp-idf/export.fish
idf.py build
ls -lh build/www.bin
```

La compilation peut exiger Java pour OpenAPI Generator, car le projet génère le client `src/app/generated` à partir d’`openapi.yaml`. `idf.py build` inclut cette étape. Ne pas utiliser `npm audit fix --force`, ne pas ajouter des `overrides` glob/rimraf à l’aveugle : déterminer d’abord la chaîne exacte avec `npm explain`.

## À vérifier impérativement

1. `npm install`, `npm run generate:api`, `npm run build:no-api-gen`, `npm test` et `idf.py build` sans erreur.
2. `dist/axe-os/index.html` et fichiers `.gz` présents ; `build/www.bin` généré et taille adaptée à la partition.
3. Dashboard, menus imbriqués, formulaires, pages Pool/Settings/Update, et interface sombre.
4. Sur BCMonster : shares **acceptées par le pool** en mode PPC/PPLNS (host et port inchangés).
5. **Installer uniquement `www.bin` après validation**. Ne pas reflasher `esp-miner.bin` ni changer fréquence/tension.

Les avertissements `inflight`, `glob` et `rimraf` peuvent provenir de **dépendances transitives** conservées par OpenAPI ou d’autres outils. Sans `npm audit --json` et `npm explain` exécutés sur une installation réelle, aucune promesse de 0 vulnérabilité ou de 0 avertissement n’est possible.
