# AxeOS 2.13.2 — correction des erreurs Angular 22 (expérimental)

## Changements

- `tsconfig.json`: `moduleResolution` = `bundler`, `module` = `ESNext`. Sans cela, Angular 22 et PrimeNG 22 exposant leurs modules via `exports` déclenchent plusieurs TS2307, puis NG8001/NG8002 en cascade.
- Le générateur OpenAPI reste **version 7.17.0** mais est exécuté directement avec `java -jar`; suppression du package npm `@openapitools/openapi-generator-cli` qui tirait `proxy-agent > pac-proxy-agent > get-uri > basic-ftp` (5 alertes `npm audit`). Le JAR officiel est téléchargé et mis en cache à la première génération.
- `main/CMakeLists.txt` surveille le script de génération.

## Sur CachyOS / Fish

Depuis `main/http_server/axe-os` :

```fish
# Après extraction de cette archive dans un NOUVEAU répertoire de travail
rm -rf node_modules package-lock.json .angular
npm install
npm audit
npm run generate:api
# Tester la compilation AVANT ESP-IDF
env AXEOS_WEB_VERSION=v2.13.2 npm run build:no-api-gen
```

En cas de succès :

```fish
cd ../../..
source ~/esp/esp-idf/export.fish
idf.py build
ls -lh build/www.bin
```

## Important

- Cette archive est une **correction structurelle non compilée**. Un registre npm n'était pas accessible lors de sa préparation.
- Le compilateur peut révéler **d'autres erreurs source** après résolution des modules ; corrigez-les à partir du nouveau journal plutôt que d'ajouter `NO_ERRORS_SCHEMA`.
- Ne pas mettre `typescript@7` : Angular 22 requiert TypeScript 6.0.x.
- Ne pas flasher `www.bin` avant validation du dashboard, des formulaires Pool/Settings et de l'onglet Update.
- Le firmware ASIC `esp-miner.bin` n'est pas modifié et doit être conservé.
- Si un `package-lock.json` a été généré dans l'ancien dossier, le régénérer après suppression de `@openapitools/openapi-generator-cli`.
- Les alertes npm restantes sont à vérifier par `npm audit` **après une nouvelle installation**.
