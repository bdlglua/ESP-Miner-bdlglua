# Intégration expérimentale du protocole BM1370 en Rust

Le codec BM1370 utilise maintenant une interface indépendante de l'UART, avec une
référence C et un adaptateur Rust optionnel. La régulation, les séquences
d'initialisation, le pilote UART, les autres ASIC et les paramètres du mineur
conservent leur implémentation actuelle. Aucun changement de fréquence/tension
n'est nécessaire pour ces essais.

## Source réutilisée et périmètre

L'adaptateur réutilise `Response::parse_version` de
[`bm13xx-protocol` 0.3.0](https://github.com/GPTechinno/bm13xx-rs/tree/422df6f1953d9fb95b5c4ab39d35b234c216d6de/bm13xx-protocol),
figé au commit `422df6f1953d9fb95b5c4ab39d35b234c216d6de` dans Cargo.toml et
Cargo.lock. Le CRC5 utilise `crc` 3.4.0, car le module CRC de la bibliothèque
amont est privé. Le CRC16-FALSE optimisé utilise une table de 512 octets calculée
à la compilation, avec traitement de quatre octets par itération. Il s'agit du
CRC5 polynomial 0x05, initialisé à 0x1f, et du CRC16-FALSE polynomial 0x1021,
initialisé à 0xffff. Le CRC16 initialisé à
zéro, également présent dans le firmware C, est différent et reste intact.

Le constructeur générique `Command` de l'amont est conservé dans le module
historique `bm1370_legacy.rs`, uniquement avec la feature de mesure `protocol-bench`.
L'émission optimisée écrit directement le format wire déjà fourni par le C :
une copie de la charge utile et un seul CRC, sans inverser puis réinverser les
hashes, sans trame temporaire à recopier. Les tests garantissent les mêmes octets.

Le code Rust n'alloue pas, emprunte les buffers C et restitue des octets/champs
dans des buffers appartenant au C. Le module réside dans le même crate/staticlib
que le lecteur coinbase afin de partager un seul runtime `core` et gestionnaire
de panique. Sa dépendance `asic-protocol` est optionnelle. Le nom historique du
crate reste `axeos-coinbase` pour conserver les outils existants.

La licence MIT amont est conservée dans
`components/stratum/rust/third-party/bm13xx-rs-LICENSE-MIT`.

## Compatibilité avec le firmware existant

- Une trame de travail comporte 88 octets, dont une charge utile de 82. Son octet
  de longueur est **0x56 (86)** dans ESP-Miner/BM1370, contre 0x36 dans le
  constructeur amont. L'adaptateur optimisé écrit 0x56 avant de calculer son CRC16.
- Le numéro de job envoyé reste le slot brut actuel, multiple de 8, avec la
  progression actuelle `+24 modulo 128`. Les conversions depuis/vers l'identifiant
  logique amont sont explicites ; aucun second décalage n'est appliqué au slot.
- L'ordre des octets des hashes, nonce initial, nBits, nTime et version est
  identique aux octets fournis par le C. Les adresses et bits de groupe des
  commandes sont conservés, même lorsque la bibliothèque amont les normalise.
- Les réponses de 11 octets conservent le nonce, les bits de version, les
  identifiants de job/core/ASIC et les valeurs des registres attendus par le C.
  La division par l'intervalle d'adressage reste dans le pilote.
- Le contrôle UART existant de longueur/préambule/CRC reste en place. Le codec
  valide également les réponses, ce qui ajoute un second contrôle de CRC.
- Le pilote vérifie désormais les bornes du tableau de registres et un intervalle
  d'adressage positif avant de l'utiliser. Les structs à bitfields des réponses
  sont remplacées par une lecture explicite des octets.

## Modes disponibles

| Mode | Options | Résultats utilisés |
| --- | --- | --- |
| C, mode de repli | `CONFIG_BM1370_PROTOCOL_RUST=n` | Codec C |
| Comparaison | `..._RUST=y`, `CONFIG_BM1370_PROTOCOL_SHADOW=y` | Trames/champs C, candidat Rust comparé |
| Rust actif | `..._RUST=y`, `..._SHADOW=n` | Trames/champs Rust |

Le profil initial sélectionnait la comparaison lors de l'activation de Rust.
Après le contrôle complet d'une heure décrit plus bas, les `sdkconfig` et
`sdkconfig.defaults` de ce workspace activent le codec Rust en mode actif pour
la release Gamma. Le mode C reste sélectionnable. Dans le mode comparaison, une
divergence ne remplace jamais les octets envoyés à l'ASIC ni les champs reçus
par le C. Les compteurs atomiques sont disponibles par
`bm1370_protocol_get_stats()` et journalisés toutes les 128 émissions :

```text
protocol_check mode=rust-shadow tx=256 rx=123 tx_mismatch=0 rx_mismatch=0
```

Ce sont des compteurs cumulés depuis le démarrage, incluant l'initialisation.
En Rust actif, `tx/rx` comptent les appels ; les compteurs de divergence n'ont
pas de valeur probante puisqu'il n'y a plus de comparaison avec C.

## Vérifications et compilation

```bash
python3 tools/test_bm1370_protocol.py
python3 tools/test_coinbase_decoder.py --compare-rust
cargo clippy --manifest-path components/stratum/rust/Cargo.toml \
    --features asic-protocol --all-targets -- -D warnings

source ~/esp/esp-idf/export.sh
bash tools/build_bm1370_profiles.sh
```

Le test du protocole compare les octets de l'ancien algorithme, du codec C et de
Rust : 20 000 charges utiles, tous les octets d'en-tête et longueurs jusqu'à 82,
20 000 réponses avec CRC valide suivies de corruptions d'un bit, vecteurs connus,
capacités insuffisantes, entrées nulles/tronquées et variantes CRC. Les trois
dispatchers sont exécutés sous ASan/UBSan pour le C ; Rust garde ses vérifications
de bornes mais n'est pas instrumenté par ces sanitizers. Une injection de faute
dans le candidat Rust vérifie le comptage des divergences et la conservation des
résultats C en mode comparaison.

Les trois images, configurations, ELF/MAP et SHA256SUMS sont isolés dans
`build/bm1370-profiles/` :

- `bm1370-c.bin`, version `v2.13.2-ppc-proto-c` ;
- `bm1370-shadow.bin`, version `v2.13.2-ppc-proto-shadow` ;
- `bm1370-rust.bin`, version `v2.13.2-ppc-proto-rust`.

Le script accepte aussi une liste de modes, par exemple `shadow rust`, et ne
flashe rien. Il conserve le sdkconfig racine, `build/esp-miner.bin` et `build/www.bin`.
Les images gardent le lecteur coinbase C pour isoler l'expérience du protocole ;
elles activent seulement les mesures de préparation/envoi des travaux. Le champ
`backend=c` de `work_profile` désigne le lecteur coinbase, et le nouveau champ
`protocol=c|rust-shadow|rust` désigne le codec ASIC.

Un quatrième mode optionnel, `bash tools/build_bm1370_profiles.sh dual`, compile
les lecteurs coinbase et protocole Rust simultanément (`bm1370-dual.bin`, version
`v2.13.2-ppc-proto-dual`). Ce mode vérifie aussi le lien des deux modules dans une
bibliothèque unique ; il n'est pas utilisé pour isoler les mesures du protocole.

Tailles constatées : C **1 508 800 octets**, comparaison **1 519 872 octets**,
Rust actif **1 519 200 octets**. Ces tailles de fichiers ne décrivent pas la RAM
dynamique ni la pile.

## Collecte sur le mineur

Après installation volontaire de l'image choisie :

```bash
node tools/capture_coinbase_profile.mjs http://192.168.1.135 \
    build/bm1370-profiles/device-test/shadow 120 30
python3 tools/analyze_coinbase_profile.py \
    build/bm1370-profiles/device-test/shadow/profile.log
```

Le collecteur conserve les lignes `protocol_check` et les compteurs dans
`collection.json`, avec les statistiques publiques et les shares. Une divergence
détectée arrête la collecte avec `aborted=protocol_mismatch` ; le collecteur ne
modifie pas le firmware. Aucune donnée d'identification des pools n'est exportée.
Utiliser un dossier distinct pour chaque mode. Un essai bref vérifie le
fonctionnement, sans établir une stabilité prolongée ni un gain de hashrate.

## Essai initial du 17 novembre 2026, avant optimisation

Essais successifs comparaison, Rust actif, puis C, sur le Gamma 601/BM1370 à
550 MHz / 1 200 mV, cible 60 °C, ventilation automatique et minimum 70 %.
Chaque passage comprend 30 secondes de chauffe puis 120 secondes mesurées.
Le lecteur coinbase reste en C pour ces trois essais. Aucun paramètre du pool,
de tension, de fréquence ou de ventilation n'a changé lors des installations.

Le mode comparaison a observé **640 émissions et 375 réponses cumulées depuis le
démarrage, sans divergence C/Rust**, au dernier relevé enregistré. Le mode Rust
actif a ensuite réellement émis/décodé les trames du mineur et soumis des shares
acceptées. Les compteurs sans divergence de ce second mode ne constituent pas
une comparaison C/Rust : cette comparaison appartient au mode précédent.

| Fenêtre mesurée | C | Comparaison C/Rust | Rust actif |
| --- | ---: | ---: | ---: |
| Tentatives de préparation/envoi | 239 | 239 | 239 |
| Durée médiane complète | 586 µs | 777 µs | 701 µs |
| p95 | 742 µs | 1 155 µs | 1 045 µs |
| Shares acceptées supplémentaires | 22 | 17 | 21 |
| Shares rejetées supplémentaires | 0 | 0 | 0 |
| Redémarrages inattendus / erreurs HTTP / erreurs WS | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Marge minimale de pile de la tâche de travaux | 6 092 octets | 6 012 octets | 5 792 octets |

Le protocole fonctionne dans ce contrôle court. **L'adaptateur Rust actuel
n'apporte pas de gain de vitesse observé pour la préparation complète des
travaux** : sa médiane est ici supérieure à celle de C. Il reste expérimental
et désactivé par défaut. Le mode comparaison exécute les deux codecs et son
surcoût ne doit pas être interprété comme celui du Rust seul.

L'essai n'isole pas le CPU du codec : les temps comprennent coinbase/Merkle,
allocations, préemptions et émission UART. Les travaux du pool et les états de
cache diffèrent entre passages ; il ne s'agit pas d'un benchmark contrôlé sur
des entrées identiques. L'adaptateur reconstruit notamment le CRC après
adaptation du constructeur amont : c'est une piste à profiler, pas une cause
mesurée du surcoût. Aucun gain de hashrate ni conclusion de stabilité prolongée
n'est établi.

Les compteurs de shares ne comparent pas la vitesse : la difficulté attribuée
par le pool a varié (2048 dans la fenêtre Rust ; 65536, 512 et 1024 dans la fenêtre
C). Le collecteur enregistre désormais `poolDifficulty` pour rendre cette limite
visible. Les paramètres configurés du pool sont restés identiques.

Résultats et logs filtrés : `build/bm1370-profiles/device-test/comparison.json`,
avec les dossiers `shadow`, `rust` et `c`. L'image combinant les lecteurs coinbase
et BM1370 Rust a aussi été compilée et liée ; elle n'a pas été flashée pour cet
essai. Le firmware habituel `v2.13.2-ppc` a été réinstallé à la fin ; la collecte
de reprise se trouve dans le dossier `restored`. Le contrôle final confirme le
minage repris, 15 shares acceptées supplémentaires en une minute, aucune rejetée,
aucun redémarrage inattendu et les paramètres inchangés (`configuration_check.json`).

## Profilage contrôlé et optimisation du 17 novembre 2026

L'essai initial mélangeait le coût du codec à celui de la préparation des travaux.
Une mesure distincte s'exécute maintenant sur l'ESP32-S3 : mêmes entrées fixes,
trois backends C / ancien Rust / Rust optimisé dans la même image, neuf séries
alternées de 500 appels pour chacun des quatre cas. Chaque backend est préchauffé
avant chaque série. Les sorties sont vérifiées avant la mesure et les sommes de
contrôle restent identiques pendant les boucles.

Les boucles ne font ni émission UART, ni allocation, ni journalisation. La tâche
est fixée au cœur 1 ; on mesure le temps écoulé et les cycles de ce cœur. Les
préemptions restent possibles : les médianes et les neuf échantillons sont gardés,
sans présenter ces mesures comme des cycles CPU exclusivement consommés par le codec.

| Cas, médiane par appel sur ESP32-S3 | C | Ancien Rust figé | Rust optimisé |
| --- | ---: | ---: | ---: |
| Émission d'un job, 88 octets | 3,862 µs | 18,622 µs | **5,066 µs** |
| Émission d'une commande d'écriture | 3,480 µs | 2,184 µs | **0,910 µs** |
| Décodage d'un résultat de job | 4,040 µs | 1,022 µs | **1,022 µs** |
| Décodage d'un registre | 3,984 µs | 0,750 µs | **0,750 µs** |

L'encodage Rust d'un job prend environ **73 % de temps en moins que l'ancien
adaptateur** dans cette mesure. Le C reste le plus rapide sur l'émission de job ;
Rust est plus rapide sur les commandes et le décodage. Aucun résultat de ce
tableau ne mesure le hashrate ni le coût complet de préparation des travaux.

Les modifications validées sont l'écriture directe dans le buffer appelant,
la suppression des conversions de hashes qui s'annulaient, un seul CRC par
trame et la spécialisation du CRC16. La même batterie native de parité, corruptions,
limites et injection de faute passe après ces modifications, ainsi que Clippy.

L'ancien adaptateur est conservé à l'identique pour la comparaison et exclu des
images normales. Les logs/résultats sont dans `build/bm1370-optimization/` :
`host-before.json`, `host-after.json`, `device-bench-v1.json` et
`device-bench-v2.json`. Le tableau utilise seulement la comparaison v2 dans une
même image, pas des chiffres pris dans des images différentes.

```bash
python3 tools/analyze_protocol_benchmark.py \
    build/bm1370-optimization/bench-v2-live/profile.log --scope esp32s3
```

La feature Cargo `protocol-bench` et `CONFIG_BM1370_PROTOCOL_BENCHMARK` ajoutent la
tâche diagnostique ; elle démarre 60 secondes après le premier job. Ces options
restent désactivées pour l'essai de stabilité et pour une release.

## Buffers fixes et validation prolongée

L'[étude des buffers fixes](JOB_BUFFERS_STUDY_FR.md) a d'abord fourni un prototype
`no_std` séparé pour la comparaison du codec ci-dessous. Le stockage est désormais
intégré sous `CONFIG_BM1370_FIXED_JOBS` ; son essai ciblé est distinct de l'heure
de stabilité du codec, qui utilisait encore les allocations C.

L'essai demandé est d'une **heure mesurée**, après deux minutes de chauffe, sur
le codec optimisé en mode actif. Il est collecté dans
`build/bm1370-optimization/stability-1h/`. Il ne comprend pas le benchmark ni le
prototype de stockage. La collecte utilise une horloge monotone pour sa durée,
contrôle les paramètres configurés et conserve les erreurs, compteurs et
statistiques publiques sans identifiants de pool.

```bash
python3 tools/analyze_stability_run.py build/bm1370-optimization/stability-1h
```

Un résumé incomplet reste marqué `measuring` ; il ne constitue pas un essai passé.
Le premier contrôle d'une heure exige notamment une durée complète, une collecte
terminée, des shares acceptées, aucune erreur de transport/CRC ni redémarrage
inattendu, pas de surchauffe, et pas de baisse persistante du tas de plus de 16 Ko
entre fenêtres médianes de cinq minutes. Les rejets stale sont distingués des
autres rejets ; le firmware de référence avait déjà un rejet stale sur plus de
4 800 shares avant l'essai. Ce contrôle ne prouve pas une stabilité sur plusieurs
jours et les compteurs de divergence en mode actif ne remplacent pas la parité C/Rust.

## Bilan de l'heure complète et activation du profil Gamma

Le 17 novembre 2026, la fenêtre mesurée a couvert **3 600,097 secondes** avec
361 échantillons HTTP, après deux minutes de chauffe. Elle a commencé vers
11 h 32 et s'est terminée vers 12 h 32, heure de Paris.

| Mesure pendant l'heure | Résultat |
| --- | ---: |
| Shares acceptées supplémentaires | **707** |
| Shares rejetées supplémentaires | **0** |
| Redémarrages inattendus | **0** |
| Erreurs HTTP / WebSocket / UART / CRC ASIC | **0 / 0 / 0 / 0** |
| Hashrate médian | **1 120,128 GH/s** pour 1 122 GH/s attendus |
| Température ASIC | 55,125–57,375 °C |
| Température VRM | 67–70 °C |
| Tas libre, médiane des cinq premières minutes | 8 213 996 octets |
| Tas libre, médiane des cinq dernières minutes | 8 213 916 octets |
| Écart entre ces fenêtres | **−80 octets** |
| Maximum du pourcentage d'erreurs matérielles remonté par le firmware | 0,3067501 % |
| Réponse signalée pour un job invalide et ignorée | 1 |

Tous les critères du premier contrôle d'une heure passent. Le pourcentage
d'erreurs matérielles de l'ASIC est distinct des erreurs de transport et de CRC ;
il n'est pas déclaré nul. Les paramètres configurés sont restés identiques.
L'écart de tas ne montre pas de baisse persistante notable sur cet essai, sans
constituer une preuve d'absence de toute fuite à long terme.

Le dernier relevé de compteurs cumulés depuis le démarrage donnait 11 904
émissions et 8 257 réponses. Ces compteurs incluent la chauffe et le mode était
actif : leurs valeurs de divergence nulles **ne prouvent pas une comparaison C/Rust**.
La parité repose sur les tests natifs et sur le benchmark de trames identiques.

Après ce contrôle seulement, le codec BM1370 Rust optimisé a été sélectionné
par défaut dans `sdkconfig` et `sdkconfig.defaults` de ce workspace pour la
release **v2.13.2-ppc-rust1**. Dans cette première release, le lecteur coinbase
restait en C et les buffers fixes étaient encore séparés. La version de production désactive le benchmark,
la mesure coinbase et les mesures par travail ; les compteurs périodiques du
protocole restent disponibles dans les logs. Les versions firmware et AxeOS
sont préparées avec le même identifiant.

Traces reproductibles :

- `build/bm1370-optimization/stability-1h/` : logs filtrés et télémétrie ;
- `build/bm1370-optimization/stability-final.json` : durée monotone et critères ;
- `build/bm1370-optimization/default-activation.json` : activation après le contrôle ;
- `build/bm1370-optimization/before-default-activation/` : fichiers source/config avant changement ;
- `build/bm1370-optimization/release-candidate/` : images de production et validation.

Un essai d'une heure valide ce premier palier sur ce Gamma, pas une stabilité
sur plusieurs jours ni un gain de hashrate. Le codec C est toujours disponible
en désactivant `CONFIG_BM1370_PROTOCOL_RUST`.

La release `v2.13.2-ppc-rust1` et son `www.bin` correspondant ont ensuite été
installés sur le mineur. Le contrôle après redémarrage a ajouté **21 shares
acceptées en deux minutes mesurées, sans rejet**, sans erreur de transport/CRC
ni redémarrage inattendu. Les paramètres ont été comparés à ceux d'avant l'essai :
aucun changement. Le dashboard réel, le bloc d'en-tête et l'affichage PPC ont
été vérifiés dans Chrome sans erreur de page, bannière de licence ni écart de
version. Les 56 tests de l'interface passent également.

Les fichiers sont conservés dans
`/home/bdlxs/Téléchargements/ESP-Miner-v2.13.2-ppc-Rust1-Gamma601/` avec leurs
empreintes SHA256. Le paquet C précédent est conservé séparément. Le rapport
complet de cette intervention est `build/bm1370-optimization/final-report.json`.

## Release suivante : v2.13.2-ppc-rust2, stockage fixe

Le stockage fixe BM1370 est intégré et activé dans les configurations du workspace,
avec 16 slots Rust statiques et des snapshots possédés côté résultat. Les travaux
ASIC ne nécessitent plus les trois allocations C par job. La [note d'intégration
et de validation](JOB_BUFFERS_STUDY_FR.md) décrit les époques, la synchronisation,
les capacités et les essais. Les notifications Stratum restent dynamiques.

L'essai ciblé a mesuré sept minutes avec deux reconnexions provoquées et reprise
des shares après chacune ; la version finale a ensuite passé cinq minutes de
contrôle. La tâche de coupures de test est compilée hors de la release.
Les rapports, images et empreintes sont dans `build/jobstore-integration/`.
Ce contrôle du stockage est distinct de l'heure de stabilité de la release Rust1.

## v2.13.2-multi-rust3 : DigiByte

La release suivante ajoute DigiByte SHA-256d tout en conservant le codec Rust et
le stockage fixe. Les paramètres, formats, tests et résultats sur BCMonster sont
décrits dans [la note DigiByte](DIGIBYTE_FR.md).
