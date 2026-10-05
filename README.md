# NAKIOS pour Nuvio (plugin / local scraper)

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
| **Chercher automatiquement un domaine qui répond** | Si le domaine saisi est hors ligne : teste `api.nakios.rent` puis les variantes voisines (`nakios.to`, `.com`, `.net`, `.is`, `.xyz`…). |
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

## Tests

```bash
npm test          # ou : node test/test-nakios.js
```

- **Hors ligne** (fetch mocké) : construction des URLs film/série, présence des headers
  `Referer`/`Origin`, mapping des sources, filtre de langue, fallback quand le domaine est
  mort, `onSettings()`.
- **Live** : appels réels sur `api.nakios.rent` pour `movie/969681` et `tv/45790/1/15`,
  bascule réelle depuis un domaine invalide, et téléchargement des premiers octets du MP4
  pour vérifier qu'il est bien lisible avec les headers fournis.

## Avertissement

Ce dépôt n'héberge aucun contenu. Le scraper se contente d'interroger une API tierce et
d'exposer les liens qu'elle renvoie ; l'utilisateur reste responsable du respect des lois
et des conditions d'utilisation applicables dans son pays.
