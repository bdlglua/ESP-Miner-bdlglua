# Correctif AxeOS 2.13.2 — dashboard Peercoin / PPLNS

## Correctif firmware `v2.13.2-ppc` — 17 novembre 2026

Cette version corrige aussi le firmware : les transactions Peercoin v1/v2
contiennent un horodatage absent des transactions Bitcoin. Le décodeur tient
compte du réseau de l'adresse de paiement vérifiée, du format de transaction,
des limites des buffers et des données tronquées. Peercoin v3 est pris en charge.
La difficulté issue de `nBits` reste disponible même si la coinbase est invalide.

Le décodeur reconnaît également les sorties P2PK à clé publique compressée ou
non compressée. Il affiche l'adresse associée à cette clé au lieu de `UNKNOWN:`.
Ce support utilise SHA256/RIPEMD160 ; `CONFIG_MBEDTLS_RIPEMD160_C=y` est activé
dans `sdkconfig.defaults` et dans la configuration locale. Cette évolution ne
change pas l'API ni l'interface : seul `esp-miner.bin` doit être remplacé si les
deux fichiers de la version `v2.13.2-ppc` ont déjà été installés.

L'API indique la devise et les décimales des valeurs décodées. AxeOS affiche les
montants PPC avec 6 décimales et n'applique pas les avertissements Bitcoin de
récompense solo à une coinbase Peercoin. Le montant représente la coinbase du
bloc, pas le solde PPLNS personnel.

Les deux fichiers de cette version sont `build/esp-miner.bin` (firmware) et
`build/www.bin` (interface). Le correctif complet nécessite les deux. Aucun
flash n'est exécuté par la compilation. Les paramètres du Gamma 601 sont lus
dans la configuration NVS existante.

Compilation : activer ESP-IDF 5.5.2 puis lancer à la racine :

```bash
AXEOS_WEB_VERSION=v2.13.2-ppc idf.py build
```

Validation : `python3 tools/test_coinbase_decoder.py` exécute le décodeur réel
avec ASan/UBSan, une notification BCMonster capturée sans soumettre de share,
des transactions Bitcoin/Peercoin et des entrées tronquées ou altérées.
Les tests Angular s'exécutent avec `npm test` depuis `main/http_server/axe-os`.
Ces vérifications ne constituent pas un essai du nouveau firmware sur le mineur.

Les sections suivantes décrivent le correctif web initial, avant cette évolution
du firmware. Leurs instructions de mise à jour limitée à `www.bin` concernent
uniquement cette ancienne version.

## Symptôme

Avec certains pools Stratum non-BTC (par exemple Peercoin sur BCMonster),
le dashboard AxeOS reste vide et la console Firefox affiche :

`TypeError: can't access property "length", e.coinbaseOutputs is undefined`

## Cause démontrée dans le code source

* `main/http_server/http_server.c` ne renvoie la propriété JSON `coinbaseOutputs`
  que lorsque `GLOBAL_STATE->block_height > 0`.
* Le frontend Angular `home.component.html` et `home.component.ts` accédaient
  systématiquement à `info.coinbaseOutputs.length`.
* En absence de cette propriété, une exception JavaScript casse les mises à jour.

## Modifications

* `home.component.ts` : normalisation du champ absent, nul ou mal typé en `[]`
  dès la réception de `/api/system/info` ; protection du gestionnaire de messages.
* `home.component.html` : accès optionnels au champ et itération sécurisée.
* `home.component.spec.ts` : tests de non-régression pour `undefined` et `null`.
* `generate-version.js` : construction possible depuis une archive ZIP sans métadonnées Git ;
  variable facultative `AXEOS_WEB_VERSION` (ex. `v2.13.2`).

**Aucun fichier du firmware C / de l'ASIC / du Stratum n'a été modifié.**
Le correctif ne change ni l'overclocking ni le hashrate du BM1370.
Il n'assure pas que les shares sont acceptées par BCMonster ; vérifier les logs
Stratum et les shares sur le site du pool. Une erreur séparée
`Failed to process mining notification` peut encore se produire.

## Compilation (CachyOS / Arch Linux)

Prérequis : Node.js >= 22, npm, ESP-IDF 5.5.2 pour la création de `www.bin`.

```bash
cd ESP-Miner-2.13.2/main/http_server/axe-os
npm ci
AXEOS_WEB_VERSION=v2.13.2 npm run build
```

L'étape ci-dessus produit les fichiers Angular compressés dans `dist/axe-os/`.
Pour produire le véritable `www.bin` SPIFFS, utiliser le système de build ESP-IDF du dépôt :

```bash
# Dans un shell où idf.py est disponible et ESP-IDF 5.5.2 activé :
cd ESP-Miner-2.13.2
export AXEOS_WEB_VERSION=v2.13.2
idf.py set-target esp32s3  # seulement si la cible du projet n'est pas configurée
idf.py build
ls -lh build/www.bin
```

La CI GitHub du dépôt (`.github/workflows/build.yml`) exécute déjà les deux étapes
Node.js + ESP-IDF et produit `build/www.bin` en artefact.
Depuis un fork GitHub, configurer `AXEOS_WEB_VERSION=v2.13.2` dans l'environnement
de la CI pour que la version web reste affichée `v2.13.2`.

Flasher **uniquement** le fichier `www.bin` obtenu après compilation via
l'onglet **Update** d'AxeOS ; ne pas flasher l'archive ZIP.
Ne pas remplacer `esp-miner.bin` pour ce correctif purement web.
Sauvegarder les paramètres avant tout flash et vérifier que `www.bin`
correspond bien au code source de ce firmware 2.13.2.

Après mise à jour : vider le cache Firefox (Ctrl+Shift+R) et vérifier
`/api/system/info` et le tableau de bord. Le 404 sur
`/api/system/statistics/dashboard` est sans rapport : cette route n'existe pas ici.

## Validation

* [ ] Interface Angular compilée sans erreur.
* [ ] `www.bin` SPIFFS créé avec succès.
* [ ] AxeOS 2.13.2 continue de fonctionner et d'afficher les capteurs.
* [ ] Aucune erreur `coinbaseOutputs is undefined` dans la console.
* [ ] Les shares sont acceptées par BCMonster en mode PPLNS.

**Ce paquet est une correction du code source, pas un binaire précompilé.**

## Second correctif — erreurs `_rawValidators`

Un formulaire Angular peut échouer sur `t is null` / `_rawValidators` si un champ
`formControlName` n'existe pas dans le FormGroup. Sur la page d'accueil, les
contrôles `chartY1Data` / `chartY2Data` étaient créés directement à partir du
`localStorage` sans valider la présence de ces deux clés.

Le nouveau correctif garantit les deux contrôles, même si les préférences
locales sont partielles, mal formées ou ont un format inattendu.

Test sans recompilation : dans la console Firefox du tableau de bord :

```js
localStorage.removeItem('HOME_CHART_DATA_SOURCES');
location.reload();
```

**Diagnostic conditionnel** : si l'erreur se produit dans une autre page
(Pool, System, Network, Logs), elle peut avoir une autre cause. Ce correctif
ne prétend pas réparer tous les formulaires Angular.
