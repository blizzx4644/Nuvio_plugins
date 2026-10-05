/**
 * NAKIOS (NK) — Nuvio local scraper (movies + series)
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
 * Nakios rotates its domain often, so the scraper:
 *   1. uses the domain configured in the plugin settings,
 *   2. remembers the API host that answered during the session,
 *   3. otherwise tries api.<domain> then the known default and the common
 *      TLD siblings (nakios.rent / .to / .com / ...).
 *
 * Written with promise chains only (Hermes-safe, no async/await).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DOMAIN = "nakios.rent";
const DEFAULT_API_BASE = "https://api." + DEFAULT_DOMAIN;

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT = 9000; // per candidate host
const MAX_CANDIDATES = 6; // avoid long scans on a dead domain

// Tried only when the configured domain does not answer.
const TLD_FALLBACKS = ["rent", "to", "com", "net", "is", "xyz", "st", "live", "tv", "app"];

// API host that answered during this app session (domain rotation cache).
let cachedApiBase = null;

// ---------------------------------------------------------------------------
// Settings (Nuvio: Settings > Scrapers > NAKIOS)
// ---------------------------------------------------------------------------

function onSettings() {
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
                "Si le domaine saisi est hors ligne, teste api.nakios.rent puis les domaines voisins (nakios.to, .com, .net...).",
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
// Helpers
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

function candidateApiBases(settings) {
    const domain = normalizeDomain(settings.domain) || DEFAULT_DOMAIN;
    const bases = [];

    if (cachedApiBase) bases.push(cachedApiBase);
    bases.push(apiBaseFor(domain));

    if (settings.autoFallback !== false) {
        bases.push(DEFAULT_API_BASE);
        const siblings = tldSiblings(domain);
        for (let i = 0; i < siblings.length; i++) {
            bases.push(apiBaseFor(siblings[i]));
        }
    }

    return unique(bases).slice(0, MAX_CANDIDATES);
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

function fetchWithTimeout(url, options, timeoutMs) {
    if (typeof AbortController !== "undefined") {
        const controller = new AbortController();
        const timer = setTimeout(function () {
            controller.abort();
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

// Tries every candidate API host in order, returns { apiBase, json } or null.
function requestSources(apiBases, path) {
    return new Promise(function (resolve) {
        let index = 0;

        function attempt() {
            if (index >= apiBases.length) return resolve(null);
            const apiBase = apiBases[index++];
            const siteBase = siteBaseFromApiBase(apiBase);

            console.log("[NAKIOS] Requete " + apiBase + path);

            fetchWithTimeout(
                apiBase + path,
                { method: "GET", headers: buildHeaders(siteBase), redirect: "follow" },
                REQUEST_TIMEOUT
            )
                .then(function (res) {
                    if (!isOk(res)) throw new Error("HTTP " + res.status);
                    return res.json();
                })
                .then(function (json) {
                    if (!json || typeof json !== "object") throw new Error("reponse invalide");
                    cachedApiBase = apiBase;
                    resolve({ apiBase: apiBase, json: json });
                })
                .catch(function (error) {
                    console.log("[NAKIOS] " + apiBase + " indisponible: " + error.message);
                    attempt();
                });
        }

        attempt();
    });
}

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

function mapSources(json, settings) {
    const sources = json && Array.isArray(json.sources) ? json.sources : [];
    const streams = [];
    const seen = {};

    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
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

        const siteBase = cachedApiBase ? siteBaseFromApiBase(cachedApiBase) : "https://" + DEFAULT_DOMAIN;

        streams.push({
            name: "NAKIOS",
            title: parts.join(" • "),
            url: url,
            quality: quality,
            lang: lang,
            type: source.isM3U8 ? "m3u8" : "video",
            provider: "nakios",
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

// ---------------------------------------------------------------------------
// Entry point called by Nuvio
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    const settings = getSettings();
    const path = buildPath(tmdbId, mediaType, season, episode);
    const type = String(mediaType || "movie").toLowerCase();

    console.log("[NAKIOS] tmdbId=" + tmdbId + " type=" + type + " path=" + path);

    return requestSources(candidateApiBases(settings), path)
        .then(function (result) {
            if (!result) {
                console.error("[NAKIOS] Aucun domaine Nakios ne repond. Mets a jour le domaine dans les reglages du scraper.");
                return [];
            }

            const json = result.json;
            if (json.success === false) {
                console.log("[NAKIOS] success=false: " + (json.message || json.error || "pas de details"));
                return [];
            }

            let streams = mapSources(json, settings);

            const wanted = settings.lang && settings.lang !== "all" ? String(settings.lang).toUpperCase() : null;
            if (wanted) {
                const filtered = streams.filter(function (stream) {
                    return stream.lang === wanted;
                });
                // Never hide everything when the API labels differ from the filter.
                if (filtered.length > 0) streams = filtered;
            }

            console.log("[NAKIOS] " + streams.length + " source(s) via " + result.apiBase);
            return streams;
        })
        .catch(function (error) {
            console.error("[NAKIOS] Erreur: " + error.message);
            return [];
        });
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams, onSettings };
} else {
    global.getStreams = getStreams;
    global.onSettings = onSettings;
}
