# DigiByte SHA-256d — v2.13.2-multi-rust3

Cette release conserve Bitcoin, Peercoin, le codec BM1370 Rust et les buffers fixes.
Elle ajoute le réseau DigiByte **mainnet SHA-256d**, son décodage coinbase et son
affichage. Le matériel BM1370 ne traite pas les autres algorithmes DigiByte.

## Réglage des pools

Le champ **Coin** est indépendant pour le pool principal et le secours :

| Valeur API | Choix | Utilisation |
| --- | --- | --- |
| 0 | Auto | Reconnaissance d'une adresse de paiement avec checksum valide ; BTC par défaut pour les noms de compte |
| 1 | Bitcoin | BTC, 8 décimales |
| 2 | Peercoin | PPC, 6 décimales et ancien nTime transactionnel pour les versions 1/2 |
| 3 | DigiByte | DGB mainnet, 8 décimales, algorithme SHA-256d |

Les champs API sont `stratumCoin` et `fallbackStratumCoin`. Les firmwares plus
anciens qui ne fournissent pas ces champs apparaissent avec Auto dans le formulaire.
Les nouveaux réglages suivent le fonctionnement existant : enregistrer puis
redémarrer pour les appliquer. Les valeurs non entières, hors de 0..3 ou de type
incorrect sont refusées avant toute modification de réglages.

Auto reconnaît les adresses DigiByte `D…`, `S…` et `dgb1…`, y compris un suffixe
`.worker`. Une adresse Bech32 valide en majuscules est normalisée avant comparaison
avec les sorties. Une adresse invalide n'est pas reconnue simplement à son préfixe.
Les anciens P2SH DigiByte commençant par `3` partagent le préfixe Bitcoin : choisir
DigiByte explicitement. Choisir aussi la monnaie explicitement pour un nom de
compte, ou si la monnaie du paiement diffère de celle réellement minée.

Le choix de monnaie ne change ni le serveur, ni le port, ni le portefeuille.
Les paramètres DigiByte n'activent pas automatiquement le décodage des adresses.
Le montant et la monnaie du bloc restent disponibles avec `Decode Coinbase Tx`
désactivé ; activer ce réglage affiche les sorties décodées. Le montant coinbase
est la récompense totale du bloc, pas le solde PPLNS du compte du pool. Les
avertissements de paiement solo propres à Bitcoin ne sont pas affichés pour DGB.

## Formats et protection des travaux

Le décodeur accepte P2PK, P2PKH, P2SH, P2WPKH, P2WSH et P2TR. Pour DGB, P2PKH
utilise la version Base58 30, P2SH la version 63 (ancienne version 5), et Segwit le
HRP `dgb`. Les montants sont divisés par 100 000 000. L'ancien P2SH est comparé
à son équivalent moderne pour identifier correctement une sortie de l'utilisateur.
Le parseur de transaction C/Rust garde le format Bitcoin pour DGB ; le décalage
nTime spécifique à Peercoin n'est pas appliqué.

Les bits 8..11 de l'en-tête DigiByte sélectionnent l'algorithme. La valeur 2
correspond à SHA-256d. Les travaux d'autres algorithmes sont refusés, la session
est invalidée puis reconnectée. Ces bits sont exclus du masque de version rolling.
Le diff1 et l'en-tête SHA-256d de 80 octets conservent leurs conventions existantes.

Référence amont figée au commit `c5449487c59e09171847255213d2d7b90122207b` :

- [Préfixes mainnet et HRP DigiByte Core](https://github.com/DigiByte-Core/digibyte/blob/c5449487c59e09171847255213d2d7b90122207b/src/kernel/chainparams.cpp)
- [Sélecteur d'algorithme et en-tête](https://github.com/DigiByte-Core/digibyte/blob/c5449487c59e09171847255213d2d7b90122207b/src/primitives/block.h)
- [Unité monétaire](https://github.com/DigiByte-Core/digibyte/blob/c5449487c59e09171847255213d2d7b90122207b/src/consensus/amount.h)
- [Calcul de difficulté RPC](https://github.com/DigiByte-Core/digibyte/blob/c5449487c59e09171847255213d2d7b90122207b/src/rpc/blockchain.cpp)

## Validation

Un travail public réel a été récupéré par une connexion `mining.subscribe` à
`stratum.bcmonster.com:4444`, sans authentification de worker et sans soumettre de
share sur cette connexion de capture. La fixture
[`digibyte_bcmonster.json`](tests/fixtures/digibyte_bcmonster.json) inclut les deux
parties coinbase, les extranonces, la version d'en-tête, les sorties et des valeurs
attendues calculées indépendamment en Python. Elle contient notamment les sorties
OP_RETURN de BCMonster et son paiement Segwit DGB.

```bash
python3 tools/test_coinbase_decoder.py --compare-rust
python3 tools/test_bm1370_jobs.py
python3 tools/test_bm1370_protocol.py
cd main/http_server/axe-os
npm test
```

Les tests natifs passent sous ASan/UBSan : parité C/Rust, vrais jobs PPC/DGB,
formats d'adresse DGB, anciens P2SH, majuscules Bech32, checksum incorrect, choix
explicite de réseau, en-têtes des 16 sélecteurs d'algorithme, troncatures et
10 000 mutations. Les tests de jobs fixes et des trois modes de codec BM1370
passent également. L'interface compte **61 tests passés dans 30 fichiers**.

La release a été installée sur le Gamma 601 du workspace. Sur BCMonster port 4444,
**300,044 secondes mesurées** après 30 secondes de chauffe ont donné **10 shares
acceptées supplémentaires, 0 rejet**, avec une médiane de **1 116,691 GH/s**.
Les 22 nettoyages `clean_jobs` observés ont conservé les métadonnées DGB à 8 décimales.
Aucune erreur HTTP/WebSocket/UART/CRC, aucun redémarrage inattendu ni erreur du
stockage fixe. Les réglages initiaux sont identiques après installation.

Le navigateur a vérifié l'affichage DGB, les versions firmware/AxeOS identiques
et les deux sélecteurs indépendants. Le choix effectué dans le formulaire de test
n'a pas été enregistré. Les requêtes API avec une monnaie invalide ont toutes
répondu 400 et n'ont modifié aucun réglage. Le décodage des adresses est resté
désactivé sur la carte comme avant l'essai ; sa validation utilise la fixture
réelle et les deux parseurs natifs.

Ce contrôle ciblé de cinq minutes n'est pas un nouvel essai prolongé de stabilité.
Rapports et images : `build/digibyte-integration/`. Les images de production sont
`esp-miner.bin` et `www.bin` ; charger l'interface puis le firmware par OTA, en
conservant les réglages NVS. Le paquet Rust2 précédent est conservé pour le retour
arrière.

## Correctif v2.13.2-multi-rust3-fix1

Les journaux utilisaient encore le booléen Peercoin pour choisir entre BTC/PPC,
alors que le décodeur et l'API identifiaient déjà correctement DGB. Le journal
utilise désormais le réseau résolu et des unités atomiques nommées par monnaie.

Le message jaune BTC était absent dans une nouvelle session de navigateur avec
le décodage DGB activé. Un onglet ouvert avant l'OTA peut continuer à exécuter
l'ancien JavaScript : le recharger avec Ctrl+Maj+R. Pour les prochaines visites,
HTML et version.txt portent maintenant Cache-Control: no-store ; les fichiers
JS/CSS à nom versionné conservent leur cache long. Les redirections de fichiers
inexistants ne sont pas mises en cache.

Le correctif et son interface ont été installés en conservant le décodage
coinbase activé par l'utilisateur. Contrôle réel : résumé des sorties marqué
DGB sur cinq nouveaux jobs, aucune erreur WebSocket, page fraîche sans avertissement
et avec sorties DGB. Les lignes de détail de sorties n'ont pas été réémises pendant
la fenêtre de collecte car elles ne sont journalisées qu'en cas de changement.
Les réglages sont inchangés et le pool a accepté de nouvelles shares après le
redémarrage. Rapport et images : build/digibyte-warning/.
