/**
 * PURSTREAM — Nuvio local scraper (movies + series) — v1.0.0 « fast »
 *
 * Public API used (base https://api.purstream.tech/api/v1) :
 *   recherche : /search-bar/search/{titre}      -> id interne + titre
 *   fiche     : /media/{idInterne}/sheet        -> tmdbId + urls (m3u8)
 *
 * Particularités par rapport à NAKIOS :
 *   - l'API Purstream n'accepte PAS l'ID TMDB, seulement son propre id interne
 *     (ex. tmdb 45790 -> id 3515). On retrouve donc l'id interne en cherchant le
 *     titre, puis on CONFIRME la fiche en comparant son champ `tmdbId`.
 *   - une seule fiche de série contient TOUS les épisodes de toutes les saisons :
 *     le premier épisode demandé paie les requêtes, tous les suivants sont
 *     instantanés (cache 30 min).
 *   - les flux sont des playlists HLS (master.m3u8). Le CDN refuse les clients
 *     non-navigateur (403 avec un User-Agent curl, 200 avec un User-Agent de
 *     navigateur) : le User-Agent est donc attaché à chaque stream, avec
 *     Referer + Origin du site (demandés, et inoffensifs).
 *
 * Vitesse : cache (titres TMDB 6 h, id interne 6 h, fiches 30 min), dédup des
 * appels simultanés, bascule de domaine en parallèle (hedged) avec cooldown des
 * hôtes morts, préchauffage au démarrage, vérification des candidats
 * séquentielle puis parallèle seulement si nécessaire.
 *
 * Written with promise chains only (Hermes-safe, no async/await).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DOMAIN = "purstream.tech";
const DEFAULT_API_BASE = "https://api." + DEFAULT_DOMAIN;
const API_PREFIX = "/api/v1";
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const PREWARM_MOVIE_ID = "969681";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT = 4000;
const MAX_CANDIDATES = 6;
const MAX_SHEET_CANDIDATES = 3; // candidats vérifiés quand le tmdbId ne colle pas

const HEDGE_MIN = 300;
const HEDGE_MAX = 1200;
const HEDGE_FACTOR = 1.6;

const TITLE_TTL = 6 * 60 * 60 * 1000; // titre TMDB : quasiment immuable
const ID_TTL = 6 * 60 * 60 * 1000; // tmdbId -> id interne
const SHEET_TTL = 30 * 60 * 1000; // fiche (toute la série)
const MISS_TTL = 60 * 1000;

const DEAD_HOST_COOLDOWN = 90 * 1000;
const PREWARM_DELAY = 1200;

const TLD_FALLBACKS = ["tech", "to", "com", "net", "is", "xyz", "st", "live", "tv", "app"];

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let cachedApiBase = null;
let lastLatency = 0;
let prewarmed = false;

const deadHosts = {};
const apiCache = {}; // path -> { at, json }  (réponses JSON du domaine actif)
const titleCache = {}; // "movie:123" -> { at, title, originalTitle, year }
const idCache = {}; // "tv:45790" -> { at, internalId }
const sheetCache = {}; // internalId -> { at, items }
const streamsCache = {}; // path -> { at, streams }
const pending = {}; // path -> Promise<streams>

// ---------------------------------------------------------------------------
// Settings (Nuvio: Settings > Scrapers > PURSTREAM)
// ---------------------------------------------------------------------------

function onSettings() {
    try {
        setTimeout(prewarm, 0);
    } catch (e) {
        /* ignore */
    }

    return Promise.resolve([
        { type: "header", label: "Domaine Purstream" },
        {
            type: "text",
            key: "domain",
            label: "Domaine actuel",
            placeholder: DEFAULT_DOMAIN,
            description:
                "Purstream peut changer de domaine. Mets ici le nouveau (sans https://, ex: purstream.to) dès que l'ancien ne répond plus.",
            defaultValue: DEFAULT_DOMAIN
        },
        {
            type: "toggle",
            key: "autoFallback",
            label: "Chercher automatiquement un domaine qui répond",
            description:
                "Si le domaine principal ne répond pas, les autres sont interrogés en parallèle (le plus rapide gagne) : api.purstream.tech puis purstream.to, .com, .net...",
            defaultValue: true
        },
        {
            type: "toggle",
            key: "prewarm",
            label: "Préchauffer la connexion au démarrage",
            description: "Ouvre la connexion et découvre le bon domaine avant la première lecture.",
            defaultValue: true
        },
        { type: "header", label: "Sources" },
        {
            type: "select",
            key: "lang",
            label: "Version préférée",
            options: [
                { label: "Toutes", value: "all" },
                { label: "MULTI / VF", value: "MULTI" },
                { label: "VOSTFR", value: "VOSTFR" }
            ],
            defaultValue: "all"
        },
        {
            type: "toggle",
            key: "showLang",
            label: "Afficher la version dans le titre du lien",
            defaultValue: true
        }
    ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSettings() {
    try {
        if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) return globalThis.SCRAPER_SETTINGS;
        if (typeof global !== "undefined" && global.SCRAPER_SETTINGS) return global.SCRAPER_SETTINGS;
        if (typeof window !== "undefined" && window.SCRAPER_SETTINGS) return window.SCRAPER_SETTINGS;
    } catch (e) {
        /* ignore */
    }
    return {};
}

// "https://Purstream.TECH/" -> "purstream.tech"
function normalizeDomain(raw) {
    let value = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
    if (!value) return "";
    value = value.replace(/^[a-z]+:\/\//, "");
    value = value.replace(/^api\./, "");
    value = value.replace(/^www\./, "");
    value = value.replace(/\/.*$/, "");
    value = value.replace(/\s+/g, "");
    return value.replace(/\.+$/, "");
}

function apiBaseFor(domain) {
    return domain ? "https://api." + domain : DEFAULT_API_BASE;
}

function siteBaseFromApiBase(apiBase) {
    return apiBase.replace(/^https?:\/\/api\./, "https://");
}

function tldSiblings(domain) {
    const dot = domain.lastIndexOf(".");
    if (dot <= 0) return [];
    const label = domain.slice(0, dot);
    const found = [];
    for (let i = 0; i < TLD_FALLBACKS.length; i++) {
        const candidate = label + "." + TLD_FALLBACKS[i];
        if (candidate !== domain) found.push(candidate);
    }
    return found;
}

function unique(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && out.indexOf(list[i]) === -1) out.push(list[i]);
    }
    return out;
}

function candidateApiBases(settings) {
    const domain = normalizeDomain(settings.domain) || DEFAULT_DOMAIN;
    const all = [];

    if (cachedApiBase) all.push(cachedApiBase);
    all.push(apiBaseFor(domain));

    if (settings.autoFallback !== false) {
        all.push(DEFAULT_API_BASE);
        const siblings = tldSiblings(domain);
        for (let i = 0; i < siblings.length; i++) all.push(apiBaseFor(siblings[i]));
    }

    const list = unique(all);
    const now = Date.now();
    const alive = [];
    for (let i = 0; i < list.length; i++) {
        const until = deadHosts[list[i]];
        if (!until || until <= now) alive.push(list[i]);
    }

    return (alive.length > 0 ? alive : list).slice(0, MAX_CANDIDATES);
}

function buildHeaders(siteBase, accept) {
    return {
        "User-Agent": USER_AGENT,
        Accept: accept || "application/json, text/plain, */*",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: siteBase + "/",
        Origin: siteBase,
        Connection: "keep-alive"
    };
}

function hedgeDelay() {
    if (!lastLatency) return HEDGE_MIN;
    return Math.min(HEDGE_MAX, Math.max(HEDGE_MIN, Math.round(lastLatency * HEDGE_FACTOR)));
}

function markDead(apiBase) {
    deadHosts[apiBase] = Date.now() + DEAD_HOST_COOLDOWN;
}

// é / è / à ... sans dépendre de String.normalize
const ACCENTS = {
    "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a",
    "ç": "c",
    "è": "e", "é": "e", "ê": "e", "ë": "e",
    "ì": "i", "í": "i", "î": "i", "ï": "i",
    "ñ": "n",
    "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o",
    "ù": "u", "ú": "u", "û": "u", "ü": "u",
    "ý": "y", "ÿ": "y",
    "œ": "oe", "æ": "ae", "ß": "ss"
};

function normalizeTitle(title) {
    if (!title) return "";
    let value = String(title).toLowerCase();
    let out = "";
    for (let i = 0; i < value.length; i++) {
        const char = value.charAt(i);
        out += ACCENTS[char] !== undefined ? ACCENTS[char] : char;
    }
    return out
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function titleScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 3;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 2;
    const wordsA = a.split(" ");
    const wordsB = b.split(" ");
    let common = 0;
    for (let i = 0; i < wordsA.length; i++) {
        if (wordsB.indexOf(wordsA[i]) !== -1) common++;
    }
    if (common === 0) return 0;
    return (common / Math.max(wordsA.length, wordsB.length)) * 2;
}

function yearOf(value) {
    const match = String(value || "").match(/(\d{4})/);
    return match ? parseInt(match[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// HTTP (bascule de domaine en parallèle, identique au scraper NAKIOS)
// ---------------------------------------------------------------------------

function fetchWithTimeout(url, options, timeoutMs, controller) {
    if (controller) {
        const timer = setTimeout(function () {
            try {
                controller.abort();
            } catch (e) {
                /* ignore */
            }
        }, timeoutMs);
        const opts = Object.assign({}, options, { signal: controller.signal });
        return fetch(url, opts).then(
            function (res) {
                clearTimeout(timer);
                return res;
            },
            function (err) {
                clearTimeout(timer);
                throw err;
            }
        );
    }
    return Promise.race([
        fetch(url, options),
        new Promise(function (_, reject) {
            setTimeout(function () {
                reject(new Error("timeout"));
            }, timeoutMs);
        })
    ]);
}

function isOk(res) {
    const status = res && res.status ? res.status : 200;
    return status >= 200 && status < 400;
}

// Joue la même stratégie « hedged » sur un chemin de l'API Purstream.
function requestJson(apiBases, path) {
    const startedAt = Date.now();

    return new Promise(function (resolve) {
        const inflight = [];
        const queue = apiBases.slice();
        let hedgeTimer = null;
        let settled = false;

        function allDone() {
            for (let i = 0; i < inflight.length; i++) {
                if (!inflight[i].done) return false;
            }
            return true;
        }

        function finish(result) {
            if (settled) return;
            settled = true;
            if (hedgeTimer) {
                clearTimeout(hedgeTimer);
                hedgeTimer = null;
            }
            for (let i = 0; i < inflight.length; i++) {
                if (!inflight[i].done && inflight[i].controller) {
                    inflight[i].cancelled = true;
                    try {
                        inflight[i].controller.abort();
                    } catch (e) {
                        /* ignore */
                    }
                }
            }
            resolve(result);
        }

        function launch(apiBase) {
            const attempt = { done: false, cancelled: false, controller: null };
            inflight.push(attempt);
            if (typeof AbortController !== "undefined") attempt.controller = new AbortController();

            const siteBase = siteBaseFromApiBase(apiBase);
            const url = apiBase + API_PREFIX + path;
            console.log("[PURSTREAM] Requete " + url);

            fetchWithTimeout(url, { method: "GET", headers: buildHeaders(siteBase), redirect: "follow" }, REQUEST_TIMEOUT, attempt.controller)
                .then(function (res) {
                    if (!isOk(res)) throw new Error("HTTP " + res.status);
                    return res.json();
                })
                .then(function (json) {
                    if (!json || typeof json !== "object") throw new Error("reponse invalide");
                    attempt.done = true;
                    cachedApiBase = apiBase;
                    lastLatency = Date.now() - startedAt;
                    finish(json);
                })
                .catch(function (error) {
                    if (attempt.done) return;
                    attempt.done = true;
                    if (attempt.cancelled || settled) return;

                    markDead(apiBase);
                    console.log("[PURSTREAM] " + apiBase + " indisponible: " + error.message);

                    if (!settled && allDone()) {
                        if (queue.length > 0) burst();
                        else finish(null);
                    }
                });
        }

        function burst() {
            if (settled) return;
            if (hedgeTimer) {
                clearTimeout(hedgeTimer);
                hedgeTimer = null;
            }
            while (queue.length > 0) launch(queue.shift());
            if (inflight.length === 0) finish(null);
        }

        if (queue.length === 0) return finish(null);
        launch(queue.shift());
        hedgeTimer = setTimeout(burst, hedgeDelay());
    });
}

// Réponses JSON mises en cache (recherche, etc.)
function cachedJson(key, ttl, factory) {
    const entry = apiCache[key];
    if (entry && Date.now() - entry.at <= ttl) return Promise.resolve(entry.json);
    return factory().then(function (json) {
        if (json) apiCache[key] = { at: Date.now(), json: json };
        return json;
    });
}

// ---------------------------------------------------------------------------
// TMDB (titre + année à partir de l'ID TMDB fourni par Nuvio)
// ---------------------------------------------------------------------------

function fetchTmdbTitle(tmdbId, mediaType, language) {
    const key = String(mediaType) + ":" + String(tmdbId) + ":" + language;
    const cached = titleCache[key];
    if (cached && Date.now() - cached.at <= TITLE_TTL) return Promise.resolve(cached);

    const type = String(mediaType).toLowerCase() === "movie" ? "movie" : "tv";
    const url =
        "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_API_KEY + "&language=" + language;

    return fetch(url, { method: "GET", headers: { Accept: "application/json", "User-Agent": USER_AGENT } })
        .then(function (res) {
            if (!isOk(res)) throw new Error("TMDB HTTP " + res.status);
            return res.json();
        })
        .then(function (json) {
            const title = type === "movie" ? json.title : json.name;
            const original = type === "movie" ? json.original_title : json.original_name;
            const date = type === "movie" ? json.release_date : json.first_air_date;
            const info = { at: Date.now(), title: title || "", originalTitle: original || "", year: yearOf(date) };
            titleCache[key] = info;
            console.log("[PURSTREAM] TMDB " + key + " -> \"" + info.title + "\" (" + info.year + ")");
            return info;
        });
}

// ---------------------------------------------------------------------------
// Purstream : recherche + fiche
// ---------------------------------------------------------------------------

function searchMedia(query, settings) {
    const path = "/search-bar/search/" + encodeURIComponent(query);
    return cachedJson("search:" + normalizeTitle(query), MISS_TTL, function () {
        return requestJson(candidateApiBases(settings), path).then(function (json) {
            const items = json && json.data && json.data.items && json.data.items.movies ? json.data.items.movies.items : null;
            return { items: Array.isArray(items) ? items : [] };
        });
    }).then(function (json) {
        return (json && json.items) || [];
    });
}

function fetchSheet(internalId, settings) {
    const cached = sheetCache[internalId];
    if (cached && Date.now() - cached.at <= SHEET_TTL) {
        return Promise.resolve(cached.items);
    }
    return requestJson(candidateApiBases(settings), "/media/" + encodeURIComponent(internalId) + "/sheet").then(function (json) {
        const items = json && json.data ? json.data.items : null;
        if (!items) return null;
        sheetCache[internalId] = { at: Date.now(), items: items };
        console.log("[PURSTREAM] fiche " + internalId + " : " + (items.urls ? items.urls.length : 0) + " url(s), \"" + items.title + "\"");
        return items;
    });
}

function buildCandidates(items, mediaType, titleInfo) {
    const wantedType = String(mediaType).toLowerCase() === "movie" ? "movie" : "tv";
    const wanted = normalizeTitle(titleInfo.title);
    const original = normalizeTitle(titleInfo.originalTitle);
    const scored = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !item.id) continue;
        if (String(item.type).toLowerCase() !== wantedType) continue;

        const itemTitle = normalizeTitle(item.title);
        let score = titleScore(itemTitle, wanted);
        if (original && original !== wanted) score = Math.max(score, titleScore(itemTitle, original));
        if (score <= 0) continue;

        const year = yearOf(item.release_date) || yearOf(item.end_date);
        if (titleInfo.year && year && Math.abs(titleInfo.year - year) <= 1) score += 1.5;
        item.__score = score;
        scored.push(item);
    }

    scored.sort(function (a, b) {
        return b.__score - a.__score;
    });
    return scored.slice(0, MAX_SHEET_CANDIDATES);
}

/**
 * Trouve la fiche Purstream correspondant à l'ID TMDB :
 *   1. fiche la plus probable (meilleur titre) ;
 *   2. si son `tmdbId` ne correspond pas, les autres candidats sont vérifiés
 *      en parallèle et le premier tmdbId exact gagne.
 */
function resolveSheet(tmdbId, mediaType, settings) {
    const idKey = String(mediaType) + ":" + String(tmdbId);
    const known = idCache[idKey];
    if (known) {
        const cached = sheetCache[known.internalId];
        if (cached && Date.now() - cached.at <= SHEET_TTL) {
            console.log("[PURSTREAM] fiche en cache pour tmdb " + tmdbId);
            return Promise.resolve(cached.items);
        }
        return fetchSheet(known.internalId, settings);
    }

    return fetchTmdbTitle(tmdbId, mediaType, "fr-FR")
        .then(function (titleInfo) {
            return searchMedia(titleInfo.title, settings).then(function (items) {
                return { titleInfo: titleInfo, items: items, tried: ["fr-FR"] };
            });
        })
        .then(function (context) {
            if (context.items.length > 0) return context;
            // Titre français introuvable -> deuxième essai en anglais.
            console.log("[PURSTREAM] aucune correspondance en français, nouvel essai en anglais");
            return fetchTmdbTitle(tmdbId, mediaType, "en-US").then(function (titleInfo) {
                return searchMedia(titleInfo.title, settings).then(function (items) {
                    return { titleInfo: titleInfo, items: items, tried: context.tried.concat(["en-US"]) };
                });
            });
        })
        .then(function (context) {
            const candidates = buildCandidates(context.items, mediaType, context.titleInfo);
            if (candidates.length === 0) {
                console.log("[PURSTREAM] titre absent du catalogue: \"" + context.titleInfo.title + "\"");
                return null;
            }

            const wantedTmdb = parseInt(tmdbId, 10);
            const first = candidates.shift();

            return fetchSheet(first.id, settings).then(function (items) {
                if (items && items.tmdbId === wantedTmdb) {
                    idCache[idKey] = { at: Date.now(), internalId: first.id };
                    return items;
                }

                if (candidates.length === 0) {
                    if (items && normalizeTitle(items.title) === normalizeTitle(context.titleInfo.title)) {
                        console.log("[PURSTREAM] tmdbId non confirmé, titre identique: " + first.id);
                        idCache[idKey] = { at: Date.now(), internalId: first.id };
                        return items;
                    }
                    return null;
                }

                console.log("[PURSTREAM] tmdbId " + wantedTmdb + " != " + (items ? items.tmdbId : "?") + ", vérification parallèle de " + candidates.length + " autre(s) fiche(s)");

                return new Promise(function (resolve) {
                    let left = candidates.length;
                    let best = items;
                    candidates.forEach(function (candidate) {
                        fetchSheet(candidate.id, settings).then(function (other) {
                            if (other && other.tmdbId === wantedTmdb) {
                                idCache[idKey] = { at: Date.now(), internalId: candidate.id };
                                best = other;
                                left = 0;
                                resolve(other);
                                return;
                            }
                            left--;
                            if (left === 0) resolve(best);
                        }).catch(function () {
                            left--;
                            if (left === 0) resolve(best);
                        });
                    });
                });
            });
        })
        .catch(function (error) {
            console.error("[PURSTREAM] resolution impossible: " + error.message);
            return null;
        });
}

// ---------------------------------------------------------------------------
// Extraction des streams
// ---------------------------------------------------------------------------

function parseEpisode(url) {
    let match = String(url).match(/[/_-]S(\d{1,3})[/_-]?E(\d{1,4})/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    match = String(url).match(/season[/_-]?(\d{1,3})[/_-]*episode[/_-]?(\d{1,4})/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    match = String(url).match(/\/(\d{1,3})x(\d{1,4})[/_.-]/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    return null;
}

function qualityLabel(name) {
    const match = String(name || "").match(/(\d{3,4})\s*p/i);
    if (match) return match[1] + "p";
    if (/2160|4k/i.test(String(name))) return "4K";
    return "HD";
}

function versionLabel(name) {
    const value = String(name || "").toUpperCase();
    if (value.indexOf("VOSTFR") !== -1) return "VOSTFR";
    if (value.indexOf("MULTI") !== -1) return "MULTI";
    if (value.indexOf("VFI") !== -1 || value.indexOf("VFQ") !== -1 || /\bVF\b/.test(value)) return "VF";
    if (value.indexOf("VO") !== -1) return "VO";
    return "";
}

function buildStream(url, name, extra, settings) {
    const siteBase = cachedApiBase ? siteBaseFromApiBase(cachedApiBase) : "https://" + DEFAULT_DOMAIN;
    const version = versionLabel(name);
    const quality = qualityLabel(name);

    const parts = ["PURSTREAM"];
    if (extra) parts.unshift(extra);
    if (settings.showLang !== false && version) parts.push(version);
    parts.push(quality);

    return {
        name: "PURSTREAM",
        title: parts.join(" • "),
        url: url,
        quality: quality,
        lang: version,
        type: "m3u8",
        provider: "purstream",
        headers: {
            "User-Agent": USER_AGENT,
            Referer: siteBase + "/",
            Origin: siteBase,
            Accept: "*/*"
        }
    };
}

function extractStreams(items, mediaType, season, episode, settings) {
    const urls = items && Array.isArray(items.urls) ? items.urls : [];
    const wantedType = String(mediaType).toLowerCase() === "movie" ? "movie" : "tv";
    const streams = [];
    const seen = {};

    if (wantedType === "movie" || String(items.type).toLowerCase() === "movie") {
        for (let i = 0; i < urls.length; i++) {
            const item = urls[i];
            if (!item || !item.url) continue;
            if (seen[item.url]) continue;
            seen[item.url] = true;
            streams.push(buildStream(item.url, item.name, "", settings));
        }
        return rankStreams(streams, settings);
    }

    const wantedSeason = parseInt(season, 10) > 0 ? parseInt(season, 10) : 1;
    const wantedEpisode = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : 1;

    for (let i = 0; i < urls.length; i++) {
        const item = urls[i];
        if (!item || !item.url) continue;
        if (seen[item.url]) continue;

        const parsed = parseEpisode(item.url);
        if (!parsed) continue;
        if (parsed.season !== wantedSeason || parsed.episode !== wantedEpisode) continue;

        seen[item.url] = true;
        streams.push(buildStream(item.url, item.name, "S" + wantedSeason + "E" + wantedEpisode, settings));
    }

    return rankStreams(streams, settings);
}

function rankStreams(streams, settings) {
    const wanted = settings.lang && settings.lang !== "all" ? String(settings.lang).toUpperCase() : null;

    for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        let score = 0;
        if (wanted && stream.lang === wanted) score -= 100;
        const match = String(stream.quality).match(/^(\d{3,4})p$/);
        const height = match ? parseInt(match[1], 10) : stream.quality === "4K" ? 2160 : 720;
        score -= height / 100;
        stream.score = score;
    }

    streams.sort(function (a, b) {
        return a.score - b.score;
    });
    for (let i = 0; i < streams.length; i++) delete streams[i].score;
    return streams;
}

// ---------------------------------------------------------------------------
// Préchargement
// ---------------------------------------------------------------------------

function prewarm() {
    if (prewarmed) return;
    prewarmed = true;

    const settings = getSettings();
    if (settings.prewarm === false) return;

    console.log("[PURSTREAM] prewarm");
    // Ouvre le domaine de l'API (et découvre le bon si le domaine a tourné),
    // puis la connexion TMDB : deux petites requêtes en arrière-plan.
    requestJson(candidateApiBases(settings), "/search-bar/search/purstream").catch(function () {
        /* best-effort */
    });
    fetchTmdbTitle(PREWARM_MOVIE_ID, "movie", "fr-FR").catch(function () {
        /* best-effort */
    });
}

// ---------------------------------------------------------------------------
// Entry point called by Nuvio
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    const settings = getSettings();
    const type = String(mediaType || "movie").toLowerCase();
    const wantedType = type === "movie" ? "movie" : "tv";
    const wantedSeason = parseInt(season, 10) > 0 ? parseInt(season, 10) : 1;
    const wantedEpisode = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : 1;
    const path =
        wantedType === "movie"
            ? "movie:" + tmdbId
            : "tv:" + tmdbId + ":" + wantedSeason + ":" + wantedEpisode;

    const cached = streamsCache[path];
    if (cached && Date.now() - cached.at <= SHEET_TTL) {
        console.log("[PURSTREAM] cache " + path);
        return Promise.resolve(cached.streams);
    }

    if (pending[path]) {
        console.log("[PURSTREAM] requete deja en cours: " + path);
        return pending[path];
    }

    console.log("[PURSTREAM] tmdbId=" + tmdbId + " type=" + wantedType + " S" + wantedSeason + "E" + wantedEpisode);

    const request = resolveSheet(tmdbId, wantedType, settings)
        .then(function (items) {
            if (!items) return [];

            const streams = extractStreams(items, wantedType, wantedSeason, wantedEpisode, settings);
            if (streams.length === 0) {
                console.log("[PURSTREAM] aucune source pour S" + wantedSeason + "E" + wantedEpisode + " (fiche \"" + items.title + "\")");
            } else {
                console.log("[PURSTREAM] " + streams.length + " source(s) pour \"" + items.title + "\"");
            }
            return streams;
        })
        .catch(function (error) {
            console.error("[PURSTREAM] Erreur: " + error.message);
            return [];
        })
        .then(function (streams) {
            streamsCache[path] = { at: Date.now(), streams: streams };
            delete pending[path];
            return streams;
        });

    pending[path] = request;
    return request;
}

// Warm the connection shortly after the scraper is loaded by the app.
try {
    setTimeout(prewarm, PREWARM_DELAY);
} catch (e) {
    /* ignore */
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams, onSettings };
} else {
    global.getStreams = getStreams;
    global.onSettings = onSettings;
}
