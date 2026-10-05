# Plugins Nuvio — NAKIOS + PURSTREAM

Dépôt de **local scrapers** pour Nuvio : deux sources de streams indépendantes, activables
séparément, avec la même architecture de vitesse (cache, bascule de domaine en parallèle,
cooldown des hôtes morts, préchauffage).

| Scraper | Contenu | Format | Particularité |
|---|---|---|---|
| **NAKIOS (NK)** | films, séries, VF/VOSTFR | MP4 | API qui prend directement l'ID TMDB |
| **PURSTREAM** | films, séries, MULTI/VOSTFR | HLS (m3u8) | l'API ne prend **pas** l'ID TMDB : résolution par titre + vérification |

```
manifest.json            # registre du dépôt (à coller dans Nuvio)
providers/nakios.js      # scraper NAKIOS  (v1.1.0)
providers/purstream.js   # scraper PURSTREAM (v1.0.0)
test/test-nakios.js      # 22 tests
test/test-purstream.js   # 20 tests
test/bench.js            # mesure du temps de recherche (tous les providers)
```

## Installation dans Nuvio

1. Pousse ce dossier dans un dépôt (GitHub, Gitea…).
2. Dans Nuvio : **Réglages → Plugins / Local Scrapers → Ajouter un dépôt**.
3. Colle l'URL brute du manifeste, par exemple :

   ```
   https://raw.githubusercontent.com/<TON_PSEUDO>/<TON_REPO>/main/manifest.json
   ```

4. Actualise la liste, active **NAKIOS** et/ou **PURSTREAM**, puis lance un film ou un épisode.

Pour tester en local : `Réglages → Developer → Plugin Tester`, en pointant l'URL du manifeste
vers ton serveur local (`http://<ip-locale>:3000/manifest.json`).

---

## NAKIOS (NK)

| Type | Endpoint |
|---|---|
| Film | `{api}/api/sources/movie/{tmdbId}` |
| Série | `{api}/api/sources/tv/{tmdbId}/{saison}/{épisode}` |

- **Les en-têtes du site sont obligatoires** : l'API renvoie **404** sans
  `Referer: https://nakios.rent/` et `Origin: https://nakios.rent` (vérifié). Ils sont donc
  envoyés à l'API **et** attachés à chaque stream (`stream.headers`) pour la lecture.
- Les MP4 passent par une chaîne de redirections (`cdn79…` → proxy → URL signée `?ff=…`) que le
  lecteur suit tout seul ; le proxy ne renvoie pas de `Content-Type`, les URLs se terminent
  par `.mp4` (octets vérifiés : signature `ftypisom`).

| Réglage | Rôle |
|---|---|
| **Domaine actuel** | `nakios.rent` par défaut. Formats acceptés : `nakios.to`, `https://nakios.to/`, `api.nakios.to`. |
| **Chercher automatiquement un domaine qui répond** | Interroge les autres hôtes en parallèle (le plus rapide gagne). |
| **Préchauffer la connexion au démarrage** | Ouvre la connexion et découvre le bon domaine avant la première lecture. |
| **Précharger l'épisode suivant** | Récupère la fiche de l'épisode suivant en arrière-plan (5 s après le lancement). |
| **Langue préférée** | Toutes / VF / VOSTFR. |
| **Afficher la langue dans le titre** | `NAKIOS (NK) • VF • HD • Premium`. |

---

## PURSTREAM

| Type | Endpoint |
|---|---|
| Recherche | `{api}/api/v1/search-bar/search/{titre}` |
| Fiche | `{api}/api/v1/media/{idInterne}/sheet` |

### Pourquoi il faut une résolution d'identifiant

Nuvio fournit un **ID TMDB**, mais l'API Purstream ne connaît que son **id interne**
(`tmdb 45790 → id 3515`, `tmdb 969681 → id 16989`). Les résultats de recherche ne contiennent
pas le `tmdbId`, seule la fiche l'expose. Le scraper enchaîne donc :

1. **TMDb** (`/movie|tv/{tmdbId}?language=fr-FR`) pour obtenir le titre et l'année ;
2. **recherche Purstream** sur ce titre, candidats filtrés par type (film/série) et triés par
   ressemblance de titre + proximité d'année ;
3. **fiche du meilleur candidat** puis **vérification de `tmdbId`** : si la fiche ne correspond
   pas, les autres candidats sont vérifiés en parallèle et la première correspondance exacte gagne.
   Un candidat au bon titre mais au mauvais `tmdbId` est donc écarté (testé) ;
4. si le titre français ne donne rien, deuxième essai automatique en anglais.

Validé sur 10 titres réels (Fight Club, Inception, Matrix, Forrest Gump, Breaking Bad,
L'Attaque des Titans, Arcane, House of the Dragon, The Mandalorian, Game of Thrones) : **10/10
résolus**, entre 250 et 450 ms chacun (le premier de chaque titre).

### Une fiche = toute la série

La fiche d'une série contient **tous les épisodes de toutes les saisons** (JoJo : 187 URLs,
Breaking Bad : 62, Game of Thrones : 73). Le scraper la met en cache 30 min et filtre
saison/épisode par expression régulière sur l'URL (`/S1/E15/…`). Conséquence : le premier
épisode paie la résolution (~150-450 ms), **tous les suivants sont instantanés** (0-1 ms).

Les épisodes absents du catalogue (JoJo en propose 187 sur 202) renvoient simplement une liste
vide — aucune erreur.

### En-têtes

Les en-têtes du site (`Referer: https://purstream.tech/`, `Origin: https://purstream.tech`)
sont envoyés à l'API et attachés à chaque stream. Mesures au curl sur les playlists HLS :

| Requête | Réponse |
|---|---|
| User-Agent navigateur + Referer + Origin | **200** |
| User-Agent navigateur seul | 200 |
| `Referer` + `Origin` mais User-Agent `curl` | **403** |
| Mauvais `Referer`/`Origin` + User-Agent navigateur | 200 |

Autrement dit : **c'est le User-Agent qui est filtré par le CDN, pas le Referer** (contrairement
à l'API Nakios où le Referer est obligatoire). Le scraper envoie donc un User-Agent navigateur
dans `stream.headers`, en plus du Referer/Origin demandés.

| Réglage | Rôle |
|---|---|
| **Domaine actuel** | `purstream.tech` par défaut. |
| **Chercher automatiquement un domaine qui répond** | Idem Nakios, sur `api.purstream.tech` et les TLD voisins. |
| **Préchauffer la connexion au démarrage** | Ouvre la connexion Purstream **et** TMDb (utilisée à chaque nouvelle résolution). |
| **Version préférée** | Toutes / MULTI-VF / VOSTFR. |
| **Afficher la version dans le titre** | `S1E15 • PURSTREAM • MULTI • 1080p`. |

---

## Vitesse

Mécanismes communs aux deux scrapers :

1. **Cache de résultats** — NAKIOS 30 min (et 6 h pour les titres TMDb / ids internes de
   PURSTREAM) ; un « aucune source » est réessayé au bout de 60 s pour ne pas masquer les nouveautés.
2. **Déduplication** — deux appels simultanés pour le même titre partagent une seule requête.
3. **Bascule de domaine en parallèle (hedged)** — l'hôte principal part seul ; s'il n'a pas
   répondu après ~1,6 × la dernière latence mesurée (300–1200 ms), tous les autres hôtes sont
   interrogés simultanément, le premier qui répond gagne, les autres sont annulés
   (`AbortController`). Si l'appel principal échoue tout de suite, la rafale part immédiatement.
4. **Cooldown des hôtes morts (90 s)** — un hôte qui vient d'échouer n'est pas retenté à chaque appel.
5. **Temps mort borné** — timeout de 4 s par hôte au lieu de 9 s.
6. **Préchauffage au démarrage** — 1,2 s après le chargement du scraper, une petite requête ouvre
   la connexion et découvre le domaine qui répond (le gain en millisecondes est négligeable sur
   un réseau rapide ; l'intérêt est d'absorber une rotation de domaine en arrière-plan).

Mesures sur l'API réelle avec `npm run bench` (Node 26, même machine) :

| Scénario | NAKIOS | PURSTREAM |
|---|---|---|
| 8 films différents (aucun cache) | p50 **263 ms**, total 2211 ms | p50 **207 ms**, total 1626 ms |
| Même titre demandé 2 fois | 237 ms → **0 ms** | 156 ms → **0 ms** |
| S1E15 puis S1E16 | 237 ms → **0 ms** (prefetch) | 167 ms → **1 ms** (fiche unique) |
| Domaine principal qui pend | 570 ms *(9 295 ms avant optimisation)* | 523 ms |
| 1er appel après préchauffage | gain non mesurable (dans le bruit) | gain non mesurable (dans le bruit) |

À lire honnêtement :

- NAKIOS ne peut pas descendre sous ~240 ms : c'est le TTFB de son serveur (mesuré au curl :
  DNS 1,4 ms, TLS 25 ms, le reste côté serveur).
- PURSTREAM fait **trois** requêtes à froid (TMDb + recherche + fiche) mais reste plus rapide,
  parce que ses serveurs répondent en ~50-100 ms. Le vrai coût est payé **une seule fois** par
  titre (et une seule fois par **série entière** grâce à la fiche unique).
- Le préchauffage ne montre pas de gain mesurable en millisecondes sur ce réseau ; il sert à
  absorber une rotation de domaine sans que l'utilisateur l'attende.

```bash
npm run bench                          # tous les providers
node test/bench.js providers/purstream.js
node test/bench.js /tmp/nakios-v1.js   # comparer avec une ancienne version
```

## Notes techniques

- **Aucun `async`/`await`, spread ou optional chaining** dans le code exécuté des providers
  (chaînes de promesses uniquement) pour rester compatible avec le moteur JS de l'application.
- Headers envoyés : `User-Agent` navigateur, `Referer: {site}/`, `Origin: {site}`,
  `Accept`, `Accept-Language: fr-FR…`, `Connection: keep-alive`.
- **Le `Referer` suit le domaine qui répond** : si la bascule retient `api.nakios.to`, les
  streams portent `Referer: https://nakios.to/`.
- Tri des sources : version préférée d'abord, puis qualité décroissante ; les liens `embed`
  (NAKIOS) passent en dernier ; doublons d'URL filtrés.
- L'état de session (caches, hôte retenu, cooldowns, latence mesurée) vit en mémoire : il est
  perdu au redémarrage de l'application, ce qui est voulu.

## Tests

```bash
npm test     # les deux suites, ~50 s (appels réels inclus)
```

- **NAKIOS** (22 tests) : URLs film/série, en-têtes, mapping, tri, doublons, filtre de langue,
  bascule et cooldown, cache, dédup, hôte qui pend (annulation vérifiée), prefetch, préchauffage,
  plus les tests live (octets MP4 réels, rotation de domaine < 2,5 s).
- **PURSTREAM** (20 tests) : chaîne TMDb → recherche → fiche, **rejet d'un candidat au mauvais
  `tmdbId`**, filtre saison/épisode, épisode absent, fiche unique réutilisée pour toute la série,
  cache, dédup, bascule et cooldown, hôte qui pend, TMDb injoignable, plus les tests live
  (playlist HLS lue avec les headers, 403 avec User-Agent curl, rotation de domaine).

## Avertissement

Ce dépôt n'héberge aucun contenu. Les scrapers interrogent des API tierces et exposent les liens
qu'elles renvoient ; l'utilisateur reste responsable du respect des lois et des conditions
d'utilisation applicables dans son pays.
