# Premier prototype Rust : décodeur coinbase

Le firmware normal utilise toujours le lecteur C. Le lecteur Rust est une option
expérimentale, désactivée par défaut. Aucun flash ni réglage du mineur n'est effectué
par les outils ci-dessous.

## Périmètre

- `components/stratum/rust` lit la transaction binaire : version Bitcoin/Peercoin,
  CompactSize canonique, entrée coinbase, hauteur, limites des extranonces,
  sorties/montants, témoin et locktime.
- Le module est `no_std`, sans dépendance applicative et sans allocation. Il
  emprunte les octets C et appelle une fonction C pour chaque sortie. Aucun
  pointeur alloué ne change de propriétaire à cette frontière.
- La conversion hexadécimale, la reconnaissance du réseau, les adresses,
  SHA256/RIPEMD160, Stratum, les pilotes et le calcul des travaux restent en C.
  Le décodeur complet conserve ses allocations C pour la transaction et le tag.
- Les erreurs effacent les résultats partiels, comme dans la version C. Un défaut
  interne Rust provoque `abort()` ; il n'y a pas de déroulement de pile à travers C.

Ce lecteur extrait les informations affichées au dashboard. La préparation
répétée des travaux utilise un autre chemin, dans `create_jobs_task.c` : convertir
ce lecteur ne permet donc pas de supposer un gain de hashrate.

## Tests et mesure sur PC

```bash
python3 tools/test_coinbase_decoder.py --compare-rust --benchmark \
    --report build/coinbase-host-report.json
cargo clippy --manifest-path components/stratum/rust/Cargo.toml --all-targets -- -D warnings
```

Prérequis : compilateur C, Rust/Cargo, bibliothèque système `libmbedcrypto` et
en-têtes mbedTLS d'ESP-IDF (`IDF_PATH`, sinon `~/esp/esp-idf`). Le test C seul reste
disponible sans Rust : `python3 tools/test_coinbase_decoder.py`.

Les mêmes notifications sont traitées par les deux versions dans le même
exécutable : statut, hauteur, tag, réseau, sorties, total et montant utilisateur
doivent correspondre. Le corpus couvre Bitcoin, Segwit, Peercoin v1/v3, une vraie
notification BCMonster, les sorties au-delà de la limite d'affichage, les adresses
P2PK, les troncatures et 10 000 mutations déterministes. ASan/UBSan instrumentent
le C et la frontière C/Rust ; le code Rust est compilé normalement, avec ses
vérifications de bornes. Ce n'est pas une preuve exhaustive de sûreté.

Le benchmark séparé est compilé sans sanitizers, avec optimisation de niveau 2
des deux côtés. Il mesure le **décodeur complet sur le PC**, crypto C comprise :
5 séries de 50 000 transactions par mode, ordre alterné, préchauffage, médiane et
échantillons bruts dans le rapport JSON. Le rapport enregistre les versions des
compilateurs et les empreintes des sources. Ces temps ne décrivent pas l'ESP32.

Exécution du 17 novembre 2026, 00:43 UTC, médianes sur cette machine :

| Décodage complet | C | Lecteur Rust + enveloppe C |
| --- | ---: | ---: |
| Sans adresses de sortie | 1,027 µs | 1,011 µs |
| Avec adresses de sortie | 2,612 µs | 2,580 µs |

L'écart est faible et ne suffit pas à conclure pour le mineur. Rapport brut :
`build/coinbase-host-report.json`.

## Compiler les deux firmwares de diagnostic

L'ESP32-S3 nécessite la chaîne Xtensa d'Espressif. Elle est installée ici sous le
nom `axeos-esp`, sans modifier la chaîne Rust globale. Installation reproductible
avec [espup](https://github.com/esp-rs/espup) :

```bash
espup install --targets esp32s3 --std --name axeos-esp \
    --export-file /tmp/axeos-export-esp.sh
source /tmp/axeos-export-esp.sh
source ~/esp/esp-idf/export.sh
bash tools/build_coinbase_profiles.sh
```

L'option espup `--std` évite d'installer un second GCC Xtensa : le projet utilise
celui d'ESP-IDF. Le module compilé reste bien `no_std`. Chaînes vérifiées ici :
ESP-IDF 5.5.2, Rust hôte 1.99.1, Rust Xtensa 1.97.0-nightly (1.97.0.0).

Le script prépare les dépendances de compilation de `core`, puis CMake compile
le lecteur hors ligne. Les configurations et le répertoire de compilation sont
isolés dans `build/coinbase-lab`. Les résultats sont dans
`build/coinbase-profiles/` :

- `coinbase-c-profile.bin` : référence C, version `v2.13.2-ppc-cprof` ;
- `coinbase-rust-profile.bin` : lecteur Rust, version `v2.13.2-ppc-rprof` ;
- fichiers ELF/MAP, configurations et `SHA256SUMS` associés.

Le script conserve `sdkconfig`, `build/esp-miner.bin` et `build/www.bin` existants.
Il construit uniquement l'application et n'exécute aucune commande de flash.
Les deux images activent `CONFIG_COINBASE_PROFILE` et `CONFIG_MINING_WORK_PROFILE` ;
seule l'image Rust active `CONFIG_COINBASE_RUST`. Les trois options sont à `n`
par défaut dans un build normal.

Les images validées par esptool font respectivement **1 508 672 octets** (C) et
**1 508 800 octets** (Rust), soit +128 octets pour cette compilation Rust par
rapport à la référence C avec les mêmes diagnostics. Ce chiffre ne mesure pas
la mémoire dynamique ni la pile en fonctionnement. Le symbole `coinbase_rs_parse`
est présent dans l'ELF Rust, confirmant que ce lecteur est bien lié à l'image.

## Comparaison sur le mineur, après installation volontaire

Il reste à installer successivement les deux images de diagnostic et à recueillir
leurs logs, à fréquence/tension, pool et option de décodage identiques. Garder le
même dashboard pour les deux essais. Conserver séparément les logs C et Rust et
les ELF correspondants ; laisser passer le démarrage/reconnexion avant de comparer
plusieurs dizaines de notifications, puis refaire l'essai dans l'ordre inverse.

```bash
node tools/capture_coinbase_profile.mjs http://192.168.1.135 \
    build/coinbase-profiles/device-test/c 240 60
python3 tools/analyze_coinbase_profile.py build/coinbase-profiles/device-test/c/profile.log
python3 tools/analyze_coinbase_profile.py /chemin/mesures-c.log
python3 tools/analyze_coinbase_profile.py /chemin/mesures-rust.log
```

Le collecteur nécessite Node 22 ou plus. Il lit les logs par `/api/ws` et les
statistiques publiques par `/api/system/info`, sans installer de firmware ni
changer de configuration. Les deux derniers arguments sont la durée mesurée et
la chauffe, en secondes (ici 240 + 60). Utiliser un autre dossier pour Rust. Il
enregistre uniquement les lignes de profil et une liste limitée de statistiques,
sans identifiants de pool ni mots de passe. `collection.json` conserve les versions,
reconnexions, redémarrages détectés et différences de compteurs de shares ;
`telemetry.jsonl` garde les échantillons. Le nombre de tentatives de travail est
distinct du nombre de nouvelles coinbases. Un essai court avec peu de coinbases
est un contrôle de fonctionnement, pas un benchmark statistiquement concluant.

Les lignes `coinbase_profile` donnent le backend, l'activation du décodage des
sorties, le statut, la durée en microsecondes, le tas libre avant/après, son minimum
historique et la marge minimale de pile de la tâche Stratum. Les lignes
`work_profile` mesurent une tentative complète de préparation/envoi à l'ASIC,
y compris ses attentes et les retours anticipés. Le lecteur Rust ne remplace pas
ce chemin ; cette seconde mesure sert à repérer où passe réellement le temps.

Le résumé sépare les backends et modes de décodage, compte les erreurs et calcule
médiane/p95/maximum des décodages réussis. Mémoire et pile sont en octets. Le tas
est commun aux tâches : ses variations ne donnent pas les allocations exactes du
lecteur. Le minimum historique et la marge de pile ne sont pas une mesure du pic
mémoire d'un seul appel. Les durées sont des temps écoulés, avec préemptions,
et **pas un pourcentage d'utilisation CPU**. Les logs sont émis après la portion
chronométrée, mais perturbent tout de même l'ordonnancement.

Ces limites suivent les recommandations d'[Espressif pour les mesures de
performance](https://docs.espressif.com/projects/esp-idf/en/v5.5.2/esp32s3/api-guides/performance/speed.html).
Les statistiques CPU par tâche et un profil d'allocations précis pourront être
ajoutés ensuite si ces premières mesures désignent un problème. Aucune amélioration
de performances sur le mineur n'est établie à ce stade.

## Premier essai réel du 17 novembre 2026

Essai réalisé sur le Gamma/BM1370 à `192.168.1.135`, à 550 MHz / 1 200 mV,
cible ASIC 60 °C, ventilation automatique, minimum 70 %, décodage des sorties
activé. Les paramètres du pool, de l'ASIC et du ventilateur ont été comparés
avant/après chaque installation : aucun changement détecté. Le dashboard est
resté en version `v2.13.2-ppc`.

Chaque firmware a été observé pendant une minute de chauffe puis quatre minutes
mesurées, en commençant par C, puis Rust. Les logs ont été récupérés par WebSocket
et les statistiques par HTTP toutes les dix secondes.

| Mesure pendant les quatre minutes | C | Rust |
| --- | ---: | ---: |
| Nouvelles coinbases décodées | 5 | 5 |
| Échecs de décodage | 0 | 0 |
| Tentatives de préparation/envoi de travaux | 478 | 478 |
| Durée médiane d'une tentative de travail | 584 µs | 590 µs |
| p95 d'une tentative de travail | 637 µs | 674 µs |
| Durée médiane de décodage coinbase complet | 1 704 µs | 1 203 µs |
| p95 de décodage coinbase complet | 2 894 µs | 1 417 µs |
| Shares acceptées supplémentaires | 5 | 5 |
| Shares rejetées supplémentaires | 0 | 0 |
| Redémarrages inattendus / erreurs HTTP / erreurs WebSocket | 0 / 0 / 0 | 0 / 0 / 0 |
| Température ASIC, minimum–maximum | 60,375–61 °C | 60,25–61,25 °C |
| Température VRM, minimum–maximum | 74–76 °C | 74–76 °C |
| Tas libre médian, API | 8 214 360 octets | 8 213 988 octets |
| Marge minimale de pile Stratum | 4 896 octets | 4 908 octets |

Le lecteur Rust passe ce contrôle de fonctionnement sur de vraies notifications
Peercoin : hauteur, devise et montants renseignés, minage et shares fonctionnels.
Le compteur de travaux mesure des tentatives, y compris les retours anticipés ;
les shares acceptées confirment séparément le fonctionnement du minage.

La médiane coinbase observée est plus basse dans l'essai Rust, mais seulement
cinq notifications ont été mesurées par version, avec des transactions et des
états de cache différents. L'ordre C/Rust n'a pas encore été inversé. **Ces valeurs
ne démontrent donc pas un gain reproductible du lecteur Rust.** La préparation
des travaux reste comparable et ne montre pas d'amélioration. Les mesures ne
permettent pas non plus de conclure à un gain de hashrate, de mémoire ou à une
stabilité sur plusieurs jours. Le chemin de préparation des travaux reste en C.

Rapport détaillé : `build/coinbase-profiles/device-test/comparison.json`.
Les sous-dossiers `c` et `rust` contiennent `profile.log`, `analysis.json`,
`telemetry.jsonl` et `collection.json`. Les statistiques filtrées n'incluent pas
les identifiants ni mots de passe des pools. Le firmware habituel C a ensuite
été réinstallé ; le contrôle de reprise est conservé dans le sous-dossier
`restored`. La reprise a été confirmée par une share acceptée, aucune rejetée,
les données Peercoin renseignées et aucun changement des réglages. Le résultat
de la comparaison des paramètres est dans `configuration_check.json`, sans
leurs valeurs confidentielles. Rust reste disponible comme option expérimentale.

L'étape suivante, le codec de trames/CRC BM1370 issu de `bm13xx-protocol`, est
décrite dans [RUST_BM1370_FR.md](RUST_BM1370_FR.md). Les deux modules partagent
une bibliothèque Rust, avec une activation indépendante.
