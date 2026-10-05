/**
 * NAKIOS (NK) — Nuvio local scraper (movies + series) — v1.1.0 « fast »
 *
 * Public API used:
 *   movie : {apiBase}/api/sources/movie/{tmdbId}
 *   tv    : {apiBase}/api/sources/tv/{tmdbId}/{season}/{episode}
 *
 * The API and the CDN MP4s only answer when the request carries the site
 * headers (Referer: https://nakios.rent/ , Origin: https://nakios.rent).
 * Both are attached to the returned stream objects so the player can send
 * them during playback too.
 *
 * Speed model (all measured against the live API, see README):
 *   0. warm-up at load: one tiny request primes DNS/TLS and pre-discovers the
 *      working domain, so the first user lookup never pays for discovery;
 *   1. result cache (5 min) -> a title already looked up answers in ~0 ms;
 *   2. in-flight dedupe -> two concurrent identical lookups share one request;
 *   3. hedged fallback -> if the primary host has not answered after
 *      ~1.6x the last successful latency, every other candidate host is
 *      queried in parallel and the first answer wins (losers are aborted);
 *   4. dead-host cooldown -> a host that just failed is skipped for 90 s;
 *   5. next-episode prefetch -> after S01E15, S01E16 is fetched in the
 *      background so "next episode" is instant.
 *
 * Written with promise chains only (Hermes-safe, no async/await).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DOMAIN = "nakios.rent";
const DEFAULT_API_BASE = "https://api." + DEFAULT_DOMAIN;
const PREWARM_MOVIE_ID = "969681";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT = 4000; // per candidate host
const MAX_CANDIDATES = 6; // hosts queried at most in the parallel burst

// Hedged fallback: wait at most this long before querying the other hosts.
const HEDGE_MIN = 300;
const HEDGE_MAX = 1200;
const HEDGE_FACTOR = 1.6;

const CACHE_TTL = 30 * 60 * 1000; // a found title is reused for 30 min (CDN paths are stable)
const MISS_TTL = 60 * 1000; // "no source" is retried after 1 min
const DEAD_HOST_COOLDOWN = 90 * 1000;
const PREFETCH_DELAY = 5000; // let playback start before the next-episode request
const PREWARM_DELAY = 1200; // let the app hand its settings over first

// Tried only when the configured domain does not answer.
const TLD_FALLBACKS = ["rent", "to", "com", "net", "is", "xyz", "st", "live", "tv", "app"];

const QUALITY_RANK = { "4K": 4, "2160p": 4, "1080p": 3, "1440p": 3, HD: 2, "720p": 2, "480p": 1, SD: 1, CAM: 0 };

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let cachedApiBase = null; // host that answered during this session
let lastLatency = 0; // ms of the last successful request (drives the hedge delay)
let prewarmed = false;

const deadHosts = {}; // apiBase -> timestamp until which it is skipped
const sourceCache = {}; // path -> { at: number, sources: array }
const pending = {}; // path -> Promise<streams> (in-flight dedupe)

// ---------------------------------------------------------------------------
// Settings (Nuvio: Settings > Scrapers > NAKIOS)
// ---------------------------------------------------------------------------

function onSettings() {
    // Opening the settings screen is a good moment to warm the connection.
    try {
        setTimeout(prewarm, 0);
    } catch (e) {
        /* ignore */
    }

    return Promise.resolve([
        { type: "header", label: "Domaine Nakios" },
        {
            type: "text",
            key: "domain",
            label: "Domaine actuel",
            placeholder: DEFAULT_DOMAIN,
            description:
                "Nakios change souvent de domaine. Mets ici le nouveau domaine (sans https://, ex: nakios.to) dès que l'ancien ne répond plus.",
            defaultValue: DEFAULT_DOMAIN
        },
        {
            type: "toggle",
            key: "autoFallback",
            label: "Chercher automatiquement un domaine qui répond",
            description:
                "Si le domaine principal ne répond pas, interroge les autres en parallèle (le plus rapide gagne) : api.nakios.rent puis nakios.to, .com, .net...",
            defaultValue: true
        },
        { type: "header", label: "Vitesse" },
        {
            type: "toggle",
            key: "prewarm",
            label: "Préchauffer la connexion au démarrage",
            description:
                "Une petite requête en arrière-plan pour avoir le bon domaine et la connexion déjà ouverts avant la première lecture.",
            defaultValue: true
        },
        {
            type: "toggle",
            key: "prefetch",
            label: "Précharger l'épisode suivant",
            description: "Après un épisode, la fiche de l'épisode suivant est récupérée en arrière-plan (lecture instantanée).",
            defaultValue: true
        },
        { type: "header", label: "Sources" },
        {
            type: "select",
            key: "lang",
            label: "Langue préférée",
            options: [
                { label: "Toutes", value: "all" },
                { label: "VF", value: "VF" },
                { label: "VOSTFR", value: "VOSTFR" }
            ],
            defaultValue: "all"
        },
        {
            type: "toggle",
            key: "showLang",
            label: "Afficher la langue dans le titre du lien",
            defaultValue: true
        }
    ]);
}

// ---------------------------------------------------------------------------
// Settings / URL helpers
// ---------------------------------------------------------------------------

function getSettings() {
    try {
        if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) {
            return globalThis.SCRAPER_SETTINGS;
        }
        if (typeof global !== "undefined" && global.SCRAPER_SETTINGS) {
            return global.SCRAPER_SETTINGS;
        }
        if (typeof window !== "undefined" && window.SCRAPER_SETTINGS) {
            return window.SCRAPER_SETTINGS;
        }
    } catch (e) {
        // ignore and use defaults
    }
    return {};
}

// "https://Nakios.RENT/" -> "nakios.rent"
function normalizeDomain(raw) {
    let value = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
    if (!value) return "";
    value = value.replace(/^[a-z]+:\/\//, ""); // strip scheme
    value = value.replace(/^api\./, ""); // api.nakios.rent -> nakios.rent
    value = value.replace(/^www\./, "");
    value = value.replace(/\/.*$/, ""); // strip path / query
    value = value.replace(/\s+/g, "");
    return value.replace(/\.+$/, "");
}

function apiBaseFor(domain) {
    return domain ? "https://api." + domain : DEFAULT_API_BASE;
}

function siteBaseFromApiBase(apiBase) {
    return apiBase.replace(/^https?:\/\/api\./, "https://");
}

// nakios.rent -> [nakios.to, nakios.com, ...]
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

// Ordered host list: last known good host first, then the configured one, then
// the default and the TLD siblings. Hosts in cooldown are skipped (unless that
// would leave nothing to try).
function candidateApiBases(settings) {
    const domain = normalizeDomain(settings.domain) || DEFAULT_DOMAIN;
    const all = [];

    if (cachedApiBase) all.push(cachedApiBase);
    all.push(apiBaseFor(domain));

    if (settings.autoFallback !== false) {
        all.push(DEFAULT_API_BASE);
        const siblings = tldSiblings(domain);
        for (let i = 0; i < siblings.length; i++) {
            all.push(apiBaseFor(siblings[i]));
        }
    }

    const uniqueList = unique(all);
    const now = Date.now();
    const alive = [];
    for (let i = 0; i < uniqueList.length; i++) {
        const until = deadHosts[uniqueList[i]];
        if (!until || until <= now) alive.push(uniqueList[i]);
    }

    return (alive.length > 0 ? alive : uniqueList).slice(0, MAX_CANDIDATES);
}

function buildPath(tmdbId, mediaType, season, episode) {
    const id = String(tmdbId === null || tmdbId === undefined ? "" : tmdbId).trim();
    const type = String(mediaType || "movie").toLowerCase();

    if (type === "tv" || type === "series" || type === "show") {
        const s = parseInt(season, 10) > 0 ? parseInt(season, 10) : 1;
        const e = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : 1;
        return "/api/sources/tv/" + encodeURIComponent(id) + "/" + s + "/" + e;
    }
    return "/api/sources/movie/" + encodeURIComponent(id);
}

function buildHeaders(siteBase) {
    return {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: siteBase + "/",
        Origin: siteBase,
        Connection: "keep-alive"
    };
}

function hedgeDelay() {
    if (!lastLatency) return HEDGE_MIN;
    const delay = Math.round(lastLatency * HEDGE_FACTOR);
    return Math.min(HEDGE_MAX, Math.max(HEDGE_MIN, delay));
}

function markDead(apiBase) {
    deadHosts[apiBase] = Date.now() + DEAD_HOST_COOLDOWN;
}

// ---------------------------------------------------------------------------
// HTTP
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

/**
 * Queries the candidate hosts and resolves with the FIRST usable answer.
 *
 * - the first candidate is requested immediately;
 * - if it has not answered after hedgeDelay(), all the other candidates are
 *   requested in parallel (the slow/dead host is simply left behind);
 * - if it fails early, the parallel burst starts immediately;
 * - when one host wins, the other in-flight requests are aborted.
 */
function requestSources(apiBases, path) {
    const startedAt = Date.now();

    return new Promise(function (resolve) {
        const inflight = [];
        const queue = apiBases.slice();
        let hedgeTimer = null;
        let settled = false;

        function allAttemptsDone() {
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
                const attempt = inflight[i];
                if (!attempt.done && attempt.controller) {
                    attempt.cancelled = true;
                    try {
                        attempt.controller.abort();
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

            if (typeof AbortController !== "undefined") {
                attempt.controller = new AbortController();
            }

            const siteBase = siteBaseFromApiBase(apiBase);
            console.log("[NAKIOS] Requete " + apiBase + path);

            fetchWithTimeout(
                apiBase + path,
                { method: "GET", headers: buildHeaders(siteBase), redirect: "follow" },
                REQUEST_TIMEOUT,
                attempt.controller
            )
                .then(function (res) {
                    if (!isOk(res)) throw new Error("HTTP " + res.status);
                    return res.json();
                })
                .then(function (json) {
                    if (!json || typeof json !== "object") throw new Error("reponse invalide");
                    attempt.done = true;
                    cachedApiBase = apiBase;
                    lastLatency = Date.now() - startedAt;
                    finish({
                        apiBase: apiBase,
                        sources: Array.isArray(json.sources) ? json.sources : [],
                        success: json.success !== false
                    });
                })
                .catch(function (error) {
                    if (attempt.done) return; // already resolved/aborted
                    attempt.done = true;
                    if (attempt.cancelled || settled) return;

                    markDead(apiBase);
                    console.log("[NAKIOS] " + apiBase + " indisponible: " + error.message);

                    if (!settled && allAttemptsDone()) {
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
            while (queue.length > 0) {
                launch(queue.shift());
            }
            if (inflight.length === 0) finish(null);
        }

        if (queue.length === 0) return finish(null);

        launch(queue.shift()); // primary host, right away
        hedgeTimer = setTimeout(burst, hedgeDelay());
    });
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheGet(path) {
    const entry = sourceCache[path];
    if (!entry) return null;
    const ttl = entry.sources.length > 0 ? CACHE_TTL : MISS_TTL;
    if (Date.now() - entry.at > ttl) {
        delete sourceCache[path];
        return null;
    }
    return entry.sources;
}

function cacheSet(path, sources) {
    const now = Date.now();
    sourceCache[path] = { at: now, sources: sources };

    // Drop expired entries so a long session does not grow forever.
    const keys = Object.keys(sourceCache);
    for (let i = 0; i < keys.length; i++) {
        const entry = sourceCache[keys[i]];
        const ttl = entry.sources.length > 0 ? CACHE_TTL : MISS_TTL;
        if (now - entry.at > ttl) delete sourceCache[keys[i]];
    }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function qualityLabel(source) {
    const raw = source && source.quality ? String(source.quality).trim() : "";
    if (!raw) return "HD";
    if (/^\d{3,4}p$/i.test(raw)) return raw.toLowerCase();
    if (/2160|4k/i.test(raw)) return "4K";
    if (/1440/i.test(raw)) return "1440p";
    if (/\bhd\b/i.test(raw)) return "HD";
    if (/full\s*hd|1080/i.test(raw)) return "1080p";
    if (/720/i.test(raw)) return "720p";
    if (/cam|ts\b/i.test(raw)) return "CAM";
    return raw;
}

function mapSources(sources, settings) {
    const streams = [];
    const seen = {};
    const list = Array.isArray(sources) ? sources : [];
    const siteBase = cachedApiBase ? siteBaseFromApiBase(cachedApiBase) : "https://" + DEFAULT_DOMAIN;

    for (let i = 0; i < list.length; i++) {
        const source = list[i];
        if (!source || !source.url) continue;

        const url = String(source.url).trim();
        if (!url || seen[url]) continue;
        seen[url] = true;

        const lang = source.lang ? String(source.lang).toUpperCase() : "";
        const quality = qualityLabel(source);
        const label = source.name ? String(source.name) : "NAKIOS (NK)";

        const parts = [label];
        if (settings.showLang !== false && lang) parts.push(lang);
        if (quality) parts.push(quality);
        if (source.isPremium) parts.push("Premium");
        if (source.isEmbed) parts.push("Embed");

        streams.push({
            name: "NAKIOS",
            title: parts.join(" • "),
            url: url,
            quality: quality,
            lang: lang,
            type: source.isM3U8 ? "m3u8" : "video",
            provider: "nakios",
            isEmbed: !!source.isEmbed,
            isPremium: !!source.isPremium,
            headers: {
                "User-Agent": USER_AGENT,
                Referer: siteBase + "/",
                Origin: siteBase,
                Accept: "*/*"
            }
        });
    }

    return streams;
}

// Best stream first: preferred language, then direct (non-embed), then quality.
function rankStreams(streams, settings) {
    const wanted = settings.lang && settings.lang !== "all" ? String(settings.lang).toUpperCase() : null;

    for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        let score = 0;
        if (wanted && stream.lang === wanted) score -= 100;
        if (!stream.isEmbed) score -= 10;
        score -= QUALITY_RANK[stream.quality] !== undefined ? QUALITY_RANK[stream.quality] : 1;
        stream.score = score;
    }

    streams.sort(function (a, b) {
        return a.score - b.score;
    });
    for (let i = 0; i < streams.length; i++) {
        delete streams[i].score;
    }
    return streams;
}

function finalize(sources, settings) {
    let streams = mapSources(sources, settings);

    const wanted = settings.lang && settings.lang !== "all" ? String(settings.lang).toUpperCase() : null;
    if (wanted) {
        const filtered = streams.filter(function (stream) {
            return stream.lang === wanted;
        });
        // Never hide everything when the API labels differ from the filter.
        if (filtered.length > 0) streams = filtered;
    }

    return rankStreams(streams, settings);
}

// ---------------------------------------------------------------------------
// Warm-up + prefetch (fire and forget, never blocks a lookup)
// ---------------------------------------------------------------------------

function prewarm() {
    if (prewarmed) return;
    prewarmed = true;

    const settings = getSettings();
    if (settings.prewarm === false) return;

    const path = buildPath(PREWARM_MOVIE_ID, "movie");
    if (cacheGet(path) || pending[path]) return;

    console.log("[NAKIOS] prewarm " + path);
    requestSources(candidateApiBases(settings), path)
        .then(function (result) {
            if (result) cacheSet(path, result.sources);
        })
        .catch(function () {
            /* prewarm is best-effort */
        });
}

function prefetchNextEpisode(tmdbId, season, episode, settings) {
    if (settings.prefetch === false) return;

    const s = parseInt(season, 10) > 0 ? parseInt(season, 10) : 1;
    const e = parseInt(episode, 10) > 0 ? parseInt(episode, 10) : 1;
    const path = buildPath(tmdbId, "tv", s, e + 1);
    if (cacheGet(path) || pending[path]) return;

    const delay = typeof settings.prefetchDelay === "number" ? settings.prefetchDelay : PREFETCH_DELAY;
    setTimeout(function () {
        if (cacheGet(path) || pending[path]) return;
        console.log("[NAKIOS] prefetch " + path);
        requestSources(candidateApiBases(settings), path)
            .then(function (result) {
                if (result) cacheSet(path, result.sources);
            })
            .catch(function () {
                /* prefetch is best-effort */
            });
    }, delay);
}

// ---------------------------------------------------------------------------
// Entry point called by Nuvio
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    const settings = getSettings();
    const type = String(mediaType || "movie").toLowerCase();
    const path = buildPath(tmdbId, type, season, episode);
    const isTv = type === "tv" || type === "series" || type === "show";

    // 1. Instant answer for a title already looked up.
    const cached = cacheGet(path);
    if (cached) {
        console.log("[NAKIOS] cache " + path + " (0 requete)");
        return Promise.resolve(finalize(cached, settings));
    }

    // 2. Same title asked twice at the same time -> a single request.
    if (pending[path]) {
        console.log("[NAKIOS] requete deja en cours, mutualisation: " + path);
        return pending[path];
    }

    const request = requestSources(candidateApiBases(settings), path)
        .then(function (result) {
            if (!result) {
                console.error("[NAKIOS] Aucun domaine Nakios ne repond. Mets a jour le domaine dans les reglages du scraper.");
                return [];
            }

            if (result.success === false) {
                console.log("[NAKIOS] success=false sur " + result.apiBase);
                return [];
            }

            cacheSet(path, result.sources);

            const streams = finalize(result.sources, settings);
            console.log("[NAKIOS] " + streams.length + " source(s) via " + result.apiBase + " en " + lastLatency + "ms");

            if (isTv) prefetchNextEpisode(tmdbId, season, episode, settings);
            return streams;
        })
        .catch(function (error) {
            console.error("[NAKIOS] Erreur: " + error.message);
            return [];
        })
        .then(function (streams) {
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
