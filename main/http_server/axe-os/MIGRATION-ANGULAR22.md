# AxeOS Angular 22 / PrimeNG 22 – migration expérimentale (16 novembre 2026)

**NON VALIDÉE pour téléversement sur un Bitaxe.** Ce dossier est une **branche de travail**, pas un `www.bin` fonctionnel. La compilation npm n’a pas pu être exécutée dans l’environnement de préparation (registre npm inaccessible). Ne flashez rien tant que la compilation et les écrans Pool/Settings/Update n’ont pas été testés.

## Versions visées
- Angular 22.2.6 et Angular CLI / build-angular 22.2.7
- TypeScript 6.0.x, Node >= 22.22.3 (ou >=24.15.0)
- PrimeNG 22.1.5 et @primeuix/themes 3.1.1, ngx-toastr 20.0.5
- ESP-IDF et code C/ASIC **inchangés**.

## Modifications déjà faites
- Protection `coinbaseOutputs` et formulaires conservée du correctif V2.
- Angular 22: tous les composants/directives/pipes déclarés par NgModule sont explicitement `standalone: false`.
- Imports/tags PrimeNG `Dropdown`→`Select`, `InputSwitch`→`ToggleSwitch`, `Sidebar`→`Drawer`, `InputTextarea`→`Textarea`.
- PrimeNG passe au système de thèmes à jetons avec Aura. Les styles PrimeNG 17 embarqués dans `styles.scss` ne sont plus chargés. La présentation historique peut changer.
- Dépendances Angular alignées, `package-lock.json` supprimé car celui de la version 18 serait incohérent. Il faut en produire un nouveau via npm.

## Installation/test sous CachyOS Fish
1. Copiez le projet dans un répertoire d'essai (ne remplacez pas l'AxeOS fonctionnel).
2. Vérifiez `node --version`: >=22.22.3 ou >=24.15.0 ; si vous utilisez nvm: `nvm install 22.22.3` puis `nvm use 22.22.3` (dans un shell où nvm est disponible).
3. Dans `main/http_server/axe-os` : `rm -rf node_modules` puis `npm install` pour générer un nouveau verrou de dépendances (ne pas utiliser npm ci avant).
4. `npm ls @angular/core @angular/cli @angular/compiler-cli @angular-devkit/build-angular primeng typescript`.
5. `env AXEOS_WEB_VERSION=v2.13.2 npm run build:no-api-gen`.
6. Examinez les erreurs de compilation TypeScript, PrimeNG et les éventuels écarts de styles ; ne passez à l'étape suivante qu'après une compilation réussie.
7. `npm audit --omit=dev`, puis `npm audit` pour inventorier les failles restantes et distinguer dépendances de build et de production. Ne pas lancer `npm audit fix --force`.
8. Si le frontend fonctionne, activez ESP-IDF (`source ~/esp/esp-idf/export.fish`), depuis la racine `idf.py build` ; vérifier `build/www.bin`.
9. **Validez d'abord en environnement de test** avant d'installer uniquement `www.bin` dans AxeOS. Le firmware `esp-miner.bin` doit rester intact.

## Points restant à valider manuellement
- Compilation complète et génération réelle d'un `www.bin` ; validation TypeScript/Angular et mise à jour des imports supplémentaires éventuellement supprimés.
- PrimeNG 22 change les propriétés et templates de certaines vues. Tester Pool, Dashboard, Update, Settings, réseau, thème sombre, menus, dialogues.
- Les variables CSS, couleurs et composants hérités du thème PrimeNG 17 devront être ajustés.
- L'endpoint Peercoin BCMonster et les shares PPLNS **ne sont pas corrigés** par la mise à jour web ; vérifier leur acceptation sur la pool.
- Le builder webpack `@angular-devkit/build-angular:browser` est conservé temporairement pour assurer `dist/axe-os`. Il est obsolète et pourra être remplacé par le builder moderne après une première validation.

## Retour arrière
Conservez le `www.bin` du correctif V2 déjà opérationnel et le firmware 2.13.2. Si la migration ne compile pas ou affiche des dysfonctionnements, restez sur votre version V2.
