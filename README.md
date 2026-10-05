# NAKIOS pour Nuvio (plugin / local scraper)

> **v1.1.0 — version optimisée vitesse** : cache de résultats, bascule de domaine en
> parallèle, déduplication, préchargement de l'épisode suivant et préchauffage au
> démarrage. Mesures avant/après dans la section [Vitesse](#vitesse).

Scraper Nuvio qui ajoute **NAKIOS (NK)** — films et séries en VF/VOSTFR — comme source de
streams, à partir de l'API publique de Nakios :

| Type  | Endpoint                                          |
|-------|---------------------------------------------------|
| Film  | `{api}/api/sources/movie/{tmdbId}`                |
| Série | `{api}/api/sources/tv/{tmdbId}/{saison}/{episode}`|

Exemples réels : `movie/969681`, `tv/45790/1/15`.

```
manifest.json            # registre du dépôt (à coller dans Nuvio)
providers/nakios.js      # le scraper (getStreams + onSettings)
test/test-nakios.js      # tests hors ligne + live
test/bench-nakios.js     # mesure du temps de recherche d'un stream
```

## Installation dans Nuvio

1. Pousse ce dossier dans un dépôt (GitHub, Gitea…).
2. Dans Nuvio : **Réglages → Plugins / Local Scrapers → Ajouter un dépôt**.
3. Colle l'URL brute du manifeste, par exemple :

   ```
   https://raw.githubusercontent.com/<TON_PSEUDO>/<TON_REPO>/main/manifest.json
   ```

4. Actualise la liste, active **NAKIOS**, puis lance un film ou un épisode.

Pour tester en local : `Réglages → Developer → Plugin Tester`, et pointe l'URL du manifeste
vers ton serveur local (`http://<ip-locale>:3000/manifest.json`) ou colle directement
l'URL d'un provider.

## Réglages du scraper

Réglages Nuvio → NAKIOS :

| Réglage | Rôle |
|---|---|
| **Domaine actuel** | Domaine utilisé (`nakios.rent` par défaut). Format accepté : `nakios.to`, `https://nakios.to/`, `api.nakios.to`. |
| **Chercher automatiquement un domaine qui répond** | Si le domaine principal ne répond pas, les autres sont interrogés **en parallèle** (`api.nakios.rent` puis `nakios.to`, `.com`, `.net`…), le plus rapide gagne. |
| **Préchauffer la connexion au démarrage** | Une petite requête en arrière-plan ouvre la connexion et découvre le bon domaine avant ta première lecture. |
| **Précharger l'épisode suivant** | Après un épisode, la fiche du suivant est récupérée en arrière-plan : « épisode suivant » est instantané. |
| **Langue préférée** | Toutes / VF / VOSTFR (filtre sur le champ `lang` de l'API). |
| **Afficher la langue dans le titre** | Affiche `NAKIOS (NK) • VF • HD • Premium` au lieu de `NAKIOS (NK) • HD • Premium`. |

## Le domaine change souvent

C'est prévu à trois niveaux :

1. **Cache de session** — dès qu'un hôte API a répondu, c'est lui qui est réutilisé pour
   les appels suivants (aucune requête perdue).
2. **Chaîne de secours** — si l'hôte échoue (erreur réseau, HTTP 4xx/5xx), le scraper teste
   dans l'ordre : le domaine configuré → `api.nakios.rent` → les TLD voisins de `nakios.*`
   (6 hôtes maximum, 9 s de timeout chacun, un seul appel en cas de succès).
3. **Réglage manuel** — si Nakios part sur un domaine inattendu (`nakios-nouveau.com`),
   mets simplement le nouveau domaine dans **Domaine actuel**, sans attendre une mise à jour.

Le `Referer`/`Origin` envoyés sont toujours recalculés depuis le domaine qui répond
(`api.nakios.to` → `Referer: https://nakios.to/`).

## Vitesse

Mesuré sur l'API réelle avec `npm run bench` (Node 26, même machine, réseau identique) :

| Scénario | Avant (v1.0.0) | Après (v1.1.0) |
|---|---|---|
| 8 films différents (aucun cache possible) | p50 **246 ms**, total 2077 ms | p50 **250 ms**, total 2128 ms |
| Même titre demandé 2 fois | 239 ms puis **245 ms** | 246 ms puis **1 ms** |
| Épisode S1E15 puis S1E16 | 240 ms puis **269 ms** | 246 ms puis **0 ms** (préchargé) |
| Domaine principal qui pend | **9289 ms** | **568 ms** |
| 1er appel après préchauffage | — (pas de warm-up) | **gain non mesurable** sur ce réseau (240 ms vs 243 ms : dans le bruit) |

À lire honnêtement : **le tout premier appel d'un titre ne peut pas descendre sous ~240 ms**, c'est
le temps de réponse du serveur Nakios (TTFB ~230 ms mesuré au curl : DNS 1,4 ms, TLS 25 ms, le reste
côté serveur). Une fois ce plancher atteint, les gains viennent de tout ce qu'on évite de refaire :

1. **Cache de résultats (30 min)** — un titre déjà demandé répond en ~1 ms, en réutilisant les URLs
   brutes de l'API (stables, le jeton `?ff=` n'est ajouté qu'à la redirection de lecture).
   Un « aucune source » est réessayé au bout de 60 s pour ne pas masquer les nouveautés.
2. **Déduplication** — si l'application demande deux fois le même épisode en même temps, une seule
   requête réseau part, les deux appels partagent la réponse.
3. **Bascule de domaine en parallèle (hedged request)** — l'hôte principal part seul ; s'il n'a rien
   répondu après ~1,6 × la dernière latence mesurée (300–1200 ms), tous les autres hôtes sont
   interrogés simultanément et le premier qui répond gagne, les autres étant annulés (`AbortController`).
   Un hôte injoignable ne coûte donc plus 9 s mais ~0,5 s. Si la requête principale échoue
   immédiatement, la rafale part sans attendre.
4. **Cooldown des hôtes morts (90 s)** — un hôte qui vient d'échouer est ignoré pendant 90 s : les
   appels suivants ne perdent plus de temps à retenter un domaine HS.
5. **Préchargement de l'épisode suivant** — 5 s après le lancement d'un épisode, la fiche du suivant
   est récupérée en arrière-plan (réglage désactivable) : passer à l'épisode suivant ne coûte rien.
6. **Préchauffage au démarrage** — 1,2 s après le chargement du scraper (et à l'ouverture des
   réglages), une petite requête ouvre la connexion et découvre le domaine qui répond. Le gain en
   millisecondes est négligeable sur un réseau rapide (DNS 1,4 ms, TLS 25 ms ici, et le pool de
   connexions est de toute façon réutilisé) : l'intérêt réel est d'**absorber une rotation de domaine
   en arrière-plan**, pendant que l'utilisateur navigue, au lieu de la payer au moment du clic.

Timeout : 4 s par hôte (au lieu de 9 s) — au-delà, la réponse vient de la rafale parallèle de toute façon.
Le tri final met la langue préférée et les liens directs en tête, les liens `embed` en dernier.

```bash
npm run bench                                  # la version courante
node test/bench-nakios.js /tmp/nakios-v1.js    # comparer avec une ancienne version
```

## Notes techniques

- **Headers obligatoires** : l'API renvoie `404` sans `Referer: https://nakios.rent/` et
  `Origin: https://nakios.rent`. Ils sont envoyés à l'API **et** attachés à chaque stream
  (`stream.headers`) pour que le lecteur les renvoie pendant la lecture.
- **Chaîne CDN** : l'URL MP4 renvoyée par l'API redirige (`cdn…` → proxy → URL signée
  `?ff=…`). Le scraper laisse le lecteur suivre ces redirections ; les URLs se terminent
  par `.mp4`.
- **Pas de `Content-Type` sur le flux final** : le proxy CDN ne le renseigne pas
  (vérifié : octets MP4 valides avec signature `ftypisom`). Le lecteur s'appuie sur
  l'extension `.mp4`.
- **Champs renvoyés** : `name`, `title`, `url`, `quality`, `lang`, `type`, `provider` et
  `headers`. Les entrées sans `url` sont ignorées, les doublons d'URL dédupliqués.
- Le provider n'utilise **ni `async`/`await`, ni spread, ni optional chaining** dans son
  code exécuté (chaînes de promesses uniquement) pour rester compatible avec le moteur
  JS de l'application.
- L'état de session (cache, hôte retenu, hôtes en cooldown, `lastLatency`) vit en mémoire :
  il est perdu au redémarrage de l'application, ce qui est voulu (les URLs sont revalidées
  à chaque lancement).

## Tests

```bash
npm test          # ou : node test/test-nakios.js
```

- **Hors ligne** (fetch mocké) : construction des URLs film/série, présence des headers
  `Referer`/`Origin`, mapping des sources, tri, filtre de langue, fallback quand le domaine est
  mort, `onSettings()`, cache, déduplication, hôte qui pend (bascule parallèle + annulation),
  cooldown, prefetch, préchauffage.
- **Live** : appels réels sur `api.nakios.rent` pour `movie/969681` et `tv/45790/1/15`,
  bascule réelle depuis un domaine invalide (< 2,5 s), cache, prefetch, et téléchargement des
  premiers octets du MP4 pour vérifier qu'il est bien lisible avec les headers fournis.

## Avertissement

Ce dépôt n'héberge aucun contenu. Le scraper se contente d'interroger une API tierce et
d'exposer les liens qu'elle renvoie ; l'utilisateur reste responsable du respect des lois
et des conditions d'utilisation applicables dans son pays.
