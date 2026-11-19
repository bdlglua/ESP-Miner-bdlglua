# Buffers de travaux BM1370 — intégration du 17 novembre 2026

## Intégration au firmware

Le prototype est devenu le module de production
[`jobbook.rs`](../components/stratum/rust/src/jobbook.rs). Le harnais
`jobbook-study` réutilise ce même fichier, sans copie divergente.
`CONFIG_BM1370_FIXED_JOBS` lie le stockage à l'archive Rust existante et l'active
uniquement pour BM1370. Les autres familles conservent leur stockage C.

Le parcours BM1370 utilise désormais un `bm_job` temporaire sur la pile, puis
copie son en-tête et son contexte dans **16 slots Rust statiques, 6 212 octets**.
Aucun `malloc`, `strdup` ou `free` n'est nécessaire par job ASIC. Les notifications
Stratum et leurs coinbases restent dynamiques ; leur contexte d'extranonce1 est
copié une fois par notification, pas à chaque extranonce2 générée.

Le lecteur reçoit une copie autonome, convertie en `bm_job` local avec ses propres
chaînes. Le hash et les logs s'exécutent sans verrou. La publication et l'envoi UART,
les invalidations, ainsi que la dernière vérification du token et l'écriture d'une
share partagent un mutex. Cette dernière section inclut l'écriture réseau pour
empêcher qu'une reconnexion ne change de session entre vérification et soumission.

Un `clean_jobs` invalide les slots **même si la queue est vide**. Déconnexion,
nouvelle connexion et changement d'extranonce invalident aussi le contexte. Un
producteur qui avait déjà retiré une ancienne notification ne peut pas la publier
dans la nouvelle époque. Chaque notification conserve son extranonce, sa difficulté
et son masque de version ; le masque ASIC est appliqué avec le job sous le verrou.
Le tampon de réception JSON est réinitialisé à chaque connexion pour ne pas conserver
de lignes de l'ancien pool. Les transports terminés sont détruits après la sortie
de la boucle de lecture.

Les identifiants de **plus de 256 octets** et extranonces2 de plus de 32 octets sont
refusés avec diagnostic ; ils ne sont jamais tronqués. Le protocole matériel garde
ses identifiants courts : une réponse ASIC très tardive après réutilisation du même
slot ne peut toujours pas être distinguée par un token logiciel seul. Aucun gain de
hashrate n'est revendiqué ; le bénéfice est la propriété des données et l'absence
d'allocations répétitives.

Le self-test matériel et la détection de blocs utilisent aussi les copies locales.
Le self-test a été adapté et compilé, sans lancer son cycle thermique sur le mineur.

## Vérifications reproductibles

```bash
python3 tools/test_bm1370_jobs.py
python3 tools/test_bm1370_protocol.py
python3 tools/test_coinbase_decoder.py --compare-rust
cargo clippy --manifest-path components/stratum/rust/Cargo.toml \
    --features fixed-jobs,asic-protocol --all-targets --locked -- -D warnings
```

Le nouveau test exécute le générateur C, le pilote BM1370, le codec et le stockage
Rust réellement liés au firmware, avec UART simulé. Il vérifie zéro allocation de
job, les en-têtes et difficultés de 1 000 nonces, les octets JSON de soumission,
les jobs non nettoyants, les changements de masque, les époques clean/reconnexion,
les capacités 0/32 d'extranonce, 256/257 d'identifiant, ainsi que 30 000 publications
et lectures concurrentes avec 1 000 invalidations. ASan et UBSan couvrent le code C ;
les tests Rust couvrent également le livre de jobs.

Une régression d'essai a été détectée puis corrigée : `esp_transport_read` renvoie
zéro pour un délai expiré. Le test du récepteur JSON vérifie désormais plusieurs
délais sans déconnexion, puis une FIN et la remise à zéro du tampon de session.
Il a aussi exposé deux comportements indéfinis C corrigés : copie de mots vers des
midstates non alignés et VLA de taille zéro pour extranonce2 vide.

`CONFIG_BM1370_JOBSTORE_TEST`, réservé aux images de diagnostic, force deux
reconnexions après 120/240 secondes suivant le démarrage de la tâche Stratum.
Il doit rester désactivé en production. Le rapport de l'essai sur carte est dans
`build/jobstore-integration/final-report.json`.

## Mesures et étude antérieures à l'intégration

Les sections suivantes décrivent l'ancien stockage et l'étude initiale ; elles
ne décrivent pas le parcours BM1370 fixe activé dans la nouvelle release.

## État actuel mesuré dans les sources

`create_jobs_task.c` alloue pour chaque travail un `bm_job`, un `jobid` et une
chaîne d'extranonce2 : **trois allocations par travail**, puis trois libérations
lors du remplacement. Sur le Gamma testé, l'intervalle est d'environ 500 ms,
soit environ six allocations et six libérations par seconde en régime établi.

Le pilote BM1370 utilise les slots bruts 0, 8, …, 120, dans l'ordre `+24 modulo
128` : 16 slots réels. La table générique actuelle conserve 128 pointeurs et
128 octets de validité pour prendre en charge plusieurs familles d'ASIC.

Un petit programme compilé avec le GCC Xtensa d'ESP-IDF confirme :

| Structure actuelle sur ESP32-S3 | Taille |
| --- | ---: |
| `bm_job` | 228 octets |
| Un pointeur | 4 octets |
| Table générique de 128 pointeurs + validité | 640 octets |

Pour 16 jobs actifs, identifiants de L octets et extranonce2 de E octets binaires,
le stockage actuel représente approximativement
`640 + 16 × (228 + L + 1 + 2E + 1)` octets, **hors métadonnées et fragmentation
de l'allocateur**. Les longueurs réelles sont variables ; cette formule ne doit
pas être présentée comme un pic mesuré. Résultat du programme de layout :
`build/bm1370-optimization/job-layout.json`.

## Pourquoi le simple remplacement de malloc ne suffit pas

Le producteur remplace/libère le pointeur dans `BM1370_send_work`, tandis que
`ASIC_result_task` le lit, calcule la difficulté et utilise ses chaînes pour
soumettre une share. Le mutex actuel protège principalement le tableau de
validité ; il ne couvre pas toute la durée d'utilisation du `bm_job`.
Un tableau réutilisé sur place laisserait aussi un lecteur voir des données
modifiées pendant son calcul. Il faut établir une règle d'ownership et de
synchronisation pour le producteur, le lecteur et `cleanQueue`.

Le prototype impose un verrou externe commun autour de
`insert/snapshot/clear/is_current`, puis fournit une copie autonome. Le hash et
l'écriture réseau se font après libération du verrou, sans conserver de référence
vers un slot réutilisable. Un token d'époque/génération peut invalider une copie
lors d'un `clean_jobs` ou remplacement connu.

Ce token **n'ajoute pas de bits au protocole ASIC**. Une réponse matérielle très
tardive après réutilisation du même identifiant ne devient pas identifiable
magiquement. Un changement de pool peut également survenir entre la dernière
vérification et la soumission ; une share stale reste possible. Le prototype
ne modifie ni la politique de version rolling ni les conventions de nonce.

## Budget fixe et limites explicites

Le prototype stocke l'en-tête canonique de 80 octets, le masque de version,
la difficulté du pool, un identifiant borné et jusqu'à 32 octets d'extranonce2.
Les chaînes C de soumission sont générées dans des buffers fournis par l'appelant,
sans troncature et avec NUL final. Les métadonnées et générations sont incluses
dans les tailles suivantes :

| Capacité d'identifiant | Taille totale, 16 slots |
| --- | ---: |
| 128 octets | **4 164 octets** |
| 256 octets | **6 212 octets** |

Les assertions de taille sont vérifiées à la compilation, sur PC et Xtensa.
Un snapshot de lecture nécessite en plus une copie sur la pile ou dans un buffer
d'appelant. Une allocation unique en PSRAM au démarrage serait possible dans
une intégration future ; aucune allocation par travail n'est nécessaire.

Le profil 256 octets paraît raisonnable pour ce Gamma, dont la PSRAM libre est
de l'ordre de 8 Mo, mais **ce n'est pas une économie de mémoire garantie** : une
capacité maximale réservée peut dépasser la mémoire dynamique réellement utilisée.
Le gain attendu porte surtout sur la prévisibilité des allocations et la durée
de vie des données ; aucun gain de hashrate n'a été mesuré pour ce prototype.

Le parseur Stratum C accepte actuellement des identifiants de longueur variable,
sans limite spécifique de 128 ou 256 octets. Une intégration doit choisir une
politique explicite au-delà de cette capacité : rejet du nouveau travail avec
diagnostic, ou chemin de compatibilité dynamique. Le prototype renvoie une erreur
**sans remplacer le travail précédent**, sans tronquer l'identifiant. La capacité
est exprimée en octets UTF-8, pas en nombre de caractères. Une extranonce de plus
de 32 octets, un NUL intégré ou un slot invalide sont également refusés.

Pendant l'essai du codec sur une heure, 3 729 identifiants ont été observés dans
les logs de résultats, avec une longueur maximale de **8 octets**. Seules les
longueurs sont conservées, pas les identifiants. Cette observation sur le pool
actuel ne définit pas une limite du protocole et ne justifie pas de tronquer les
identifiants d'un autre pool.

## Validation du prototype

```bash
cargo test --manifest-path tools/jobbook-study/Cargo.toml
cargo clippy --manifest-path tools/jobbook-study/Cargo.toml --all-targets -- -D warnings
cargo +axeos-esp build --manifest-path tools/jobbook-study/Cargo.toml \
    --target xtensa-esp32s3-espidf --release -Zbuild-std=core
```

Les cinq tests couvrent : 100 000 remplacements, conservation d'une ancienne
copie après réutilisation, débordements atomiques sans troncature, tous les
identifiants de slot, nettoyage/changement d'époque, UTF-8 et budgets mémoire,
puis producteur/lecteur/nettoyeur concurrents avec snapshots possédés.
Les trois commandes passent. La synchronisation du test utilise `std::Mutex`
sur PC ; elle ne remplace pas une validation des tâches FreeRTOS sur carte.

## Plan initial (réalisé dans l'intégration ci-dessus)

1. Introduire un stockage BM1370 propre à ces 16 slots et ses limites d'identifiant.
2. Partager le même verrou entre remplacement, snapshot de résultat et nettoyage.
3. Faire calculer/soumettre les shares à partir d'un snapshot autonome, en
   préservant exactement les chaînes, l'en-tête et le version rolling actuels.
4. Comparer les soumissions C/prototype sur des vecteurs Bitcoin et Peercoin,
   puis tester les changements de jobs/pool et les buffers saturés sur carte.
5. Mesurer allocations, pile et latence avant d'activer ce stockage dans une release.

Une autre piste est visible dans `construct_bm_job` : les midstates logiciels
sont calculés alors que le paquet BM1370 envoie l'en-tête complet. Cette
observation mérite une étude séparée ; elle n'est pas incluse dans les gains
annoncés du codec et n'a pas été modifiée pendant les comparaisons.

## Premier essai sur carte, stockage fixe

La version de diagnostic a été mesurée pendant **420,049 secondes**, avec deux
reconnexions provoquées et une reprise de shares acceptées après chacune.
La collecte observe 40 nettoyages `clean_jobs`, trois sessions connectées et trois
contextes d’extranonce. Résultat : **5 shares acceptées supplémentaires, 0 rejet**,
médiane **1 116,745 GH/s** pour 1 122 GH/s attendus, aucun redémarrage inattendu
ni erreur HTTP/WebSocket/UART/CRC. Six réponses d’anciens slots ont été ignorées.
Les identifiants de jobs observés mesurent au maximum 8 octets.

La première lecture de température avant initialisation vaut -1 ; les lectures
valides ne dépassent pas 57 °C pendant cet essai. Ce test de sept minutes vérifie
les transitions de jobs et sessions ; il ne remplace pas une stabilité de plusieurs
heures ou jours pour ce nouveau stockage. L’heure mesurée précédemment concernait
le codec Rust avec le stockage C.

Les binaires de production `v2.13.2-ppc-rust2` activent le stockage fixe et compilent
la tâche de coupures diagnostiques hors du firmware. Leur installation OTA conserve
les réglages NVS ; firmware et AxeOS utilisent le même identifiant de version.

Le contrôle après installation a ensuite mesuré **300.051
secondes** en production après 30 secondes de chauffe : **13 shares
acceptées supplémentaires, 0 rejet**, médiane **1127.029 GH/s**.
Aucune coupure diagnostique, erreur de transport/CRC ou reprise inattendue.
Le dashboard a chargé 11 cartes sans erreur JavaScript ni licence invalide ;
les versions firmware et AxeOS concordent. Les réglages ont été comparés à ceux
immédiatement avant l'OTA de production : aucun changement.
Le décodage coinbase était déjà désactivé avant cette OTA et pendant les essais
enregistrés. Le relevé initial l'avait observé activé ; cet écart est conservé
dans le rapport, sans réécrire ce réglage.
