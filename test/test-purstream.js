/**
 * Tests du scraper PURSTREAM pour Nuvio.
 *
 *   node test/test-purstream.js
 *
 * 1. Tests hors ligne : fetch mocké (TMDb + recherche + fiche), mapping
 *    tmdbId -> id interne, filtre saison/épisode, cache « une fiche = toute la
 *    série », bascule de domaine, cooldown, tri des versions.
 * 2. Tests live : vrais appels sur api.purstream.tech + lecture de la playlist
 *    HLS avec les en-têtes fournis par le scraper (403 sans eux).
 */

const assert = require("assert");
const path = require("path");

const PROVIDER_PATH = path.join(__dirname, "..", "providers", "purstream.js");
const REAL_FETCH = globalThis.fetch;

globalThis.SCRAPER_SETTINGS = { prewarm: false };

let failures = 0;
let passes = 0;

function settings(overrides) {
    const config = Object.assign({ domain: "purstream.tech", lang: "all", showLang: true, prewarm: false, autoFallback: true }, overrides);
    globalThis.SCRAPER_SETTINGS = config;
    return config;
}

function freshProvider() {
    delete require.cache[require.resolve(PROVIDER_PATH)];
    return require(PROVIDER_PATH);
}

async function test(name, fn) {
    try {
        await fn();
        passes++;
        console.log("  ok   " + name);
    } catch (error) {
        failures++;
        console.error("  FAIL " + name + "\n       " + error.message);
    }
}

function section(title) {
    console.log("\n" + title);
}

// ---------------------------------------------------------------------------
// Fixtures (formes réelles de l'API Purstream / TMDb)
// ---------------------------------------------------------------------------

const TMDB_MOVIE = { title: "Spider-Man : Brand New Day", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-29" };
const TMDB_TV = { name: "JoJo's Bizarre Adventure", original_name: "ジョジョの奇妙な冒険", first_air_date: "2012-10-06" };

const MOVIE_SHEET = {
    apiVersion: "241103",
    type: "success",
    data: {
        count: 1,
        items: {
            id: 16989,
            tmdbId: 969681,
            type: "movie",
            urls: [{ url: "https://cdn.pulse.test/movies/969681-fdka9/hd/master.m3u8", name: "Source 1" }],
            title: "Spider-Man : Brand New Day"
        }
    }
};

const TV_SHEET = {
    apiVersion: "241103",
    type: "success",
    data: {
        count: 1,
        items: {
            id: 3515,
            tmdbId: 45790,
            type: "tv",
            isAnime: true,
            continuousIncremental: 0,
            urls: [
                { url: "https://cdn.pulse.test/animes/tv/45790/S1/E15/premium-634sfh/master.m3u8", name: "pulse | 1080p | MULTI" },
                { url: "https://cdn.pulse.test/animes/tv/45790/S1/E16/premium-uwut48/master.m3u8", name: "pulse | 1080p | MULTI" },
                { url: "https://cdn.pulse.test/animes/tv/45790/S2/E1/premium-8gab4f/master.m3u8", name: "pulse | 1080p | VOSTFR" },
                { url: "https://cdn.pulse.test/animes/tv/45790/S2/E2/premium-bso1el/master.m3u8", name: "pulse | 1080p | VOSTFR" }
            ],
            title: "JoJo's Bizarre Adventure",
            seasons: 6,
            episodes: 202
        }
    }
};

const SEARCH_MOVIE = {
    data: {
        count: 1,
        items: {
            movies: {
                count: 1,
                items: [{ id: 16989, type: "movie", title: "Spider-Man : Brand New Day", release_date: "2026-07-29 00:00:00", isAnime: false }]
            }
        }
    }
};

const SEARCH_TV = {
    data: {
        count: 1,
        items: {
            movies: {
                count: 1,
                items: [{ id: 3515, type: "tv", title: "JoJo's Bizarre Adventure", release_date: "2012-10-06 00:00:00", isAnime: true }]
            }
        }
    }
};

// Le 1er résultat porte le bon titre et la bonne année mais PAS le bon tmdbId
// (piège classique) : il doit être écarté au profit du second.
const SEARCH_MOVIE_DECOY = {
    data: {
        count: 2,
        items: {
            movies: {
                count: 2,
                items: [
                    { id: 777, type: "movie", title: "Spider-Man : Brand New Day", release_date: "2026-05-05 00:00:00" },
                    { id: 16989, type: "movie", title: "Spider-Man : Brand New Day", release_date: "2026-07-29 00:00:00" }
                ]
            }
        }
    }
};

const DECOY_SHEET = {
    data: { count: 1, items: { id: 777, tmdbId: 111111, type: "movie", urls: [{ url: "https://cdn.pulse.test/movies/777/hd/master.m3u8", name: "Source 1" }], title: "Spider-Man : Brand New Day" } }
};

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockResponse(body, status) {
    const code = status === undefined ? 200 : status;
    return {
        status: code,
        ok: code < 400,
        json: function () {
            return Promise.resolve(body);
        }
    };
}

function hangUntilAborted(record) {
    return new Promise(function (_, reject) {
        const signal = record.options.signal;
        if (!signal) return;
        signal.addEventListener("abort", function () {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
        });
    });
}

/**
 * Router de test : répond selon le type d'appel (TMDB, recherche, fiche).
 * options : { search, sheets, tmdbFails, failing: [hôte], hanging: [hôte] }
 */
function installFetch(options) {
    const config = options || {};
    const calls = [];

    globalThis.fetch = function (url, opts) {
        const record = { url: String(url), options: opts || {} };
        calls.push(record);

        const matches = (needle) => record.url.indexOf(needle) !== -1;
        if (config.hanging && config.hanging.some(matches)) return hangUntilAborted(record);
        if (config.failing && config.failing.some(matches)) return Promise.reject(new Error("mock: host injoignable"));

        if (record.url.indexOf("api.themoviedb.org") !== -1) {
            if (config.tmdbFails) return Promise.reject(new Error("mock: tmdb down"));
            return Promise.resolve(mockResponse(config.tmdb || (record.url.indexOf("/tv/") !== -1 ? TMDB_TV : TMDB_MOVIE)));
        }

        if (record.url.indexOf("/search-bar/search/") !== -1) {
            if (config.searchFails) return Promise.reject(new Error("mock: recherche down"));
            return Promise.resolve(mockResponse(config.search || SEARCH_MOVIE));
        }

        const sheetMatch = record.url.match(/\/media\/(\d+)\/sheet/);
        if (sheetMatch) {
            const sheets = config.sheets || { "16989": MOVIE_SHEET, "3515": TV_SHEET };
            const body = sheets[sheetMatch[1]];
            if (!body) return Promise.resolve(mockResponse({ type: "error" }, 404));
            return Promise.resolve(mockResponse(body));
        }

        return Promise.resolve(mockResponse({}, 404));
    };

    return calls;
}

const hit = (calls, needle) =>
    calls.filter(function (call) {
        return call.url.indexOf(needle) !== -1;
    });

// ---------------------------------------------------------------------------
// 1. Tests hors ligne
// ---------------------------------------------------------------------------

async function offlineTests() {
    section("Hors ligne — mapping TMDb, fiche et extraction");

    await test("film : TMDb -> recherche -> fiche -> master.m3u8 + headers", async () => {
        settings({});
        const calls = installFetch({});
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.strictEqual(hit(calls, "api.themoviedb.org/3/movie/969681").length, 1, "titre TMDb attendu");
        assert.strictEqual(hit(calls, "/search-bar/search/").length, 1, "recherche Purstream attendue");
        assert.strictEqual(hit(calls, "/media/16989/sheet").length, 1, "fiche attendue");
        assert.strictEqual(streams.length, 1);
        assert.strictEqual(streams[0].url, "https://cdn.pulse.test/movies/969681-fdka9/hd/master.m3u8");
        assert.strictEqual(streams[0].name, "PURSTREAM");
        assert.strictEqual(streams[0].type, "m3u8");
        assert.strictEqual(streams[0].headers.Referer, "https://purstream.tech/");
        assert.strictEqual(streams[0].headers.Origin, "https://purstream.tech");
    });

    await test("série : seuls les épisodes demandés sont renvoyés", async () => {
        settings({});
        installFetch({ search: SEARCH_TV });
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 1, 15);

        assert.strictEqual(streams.length, 1);
        assert.ok(streams[0].url.indexOf("/S1/E15/") !== -1, "mauvais épisode: " + streams[0].url);
        assert.ok(streams[0].title.indexOf("S1E15") !== -1, "saison/épisode absent du titre: " + streams[0].title);
        assert.strictEqual(streams[0].lang, "MULTI");
    });

    await test("série : un épisode absent ne renvoie rien", async () => {
        settings({});
        installFetch({ search: SEARCH_TV });
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 9, 99);
        assert.deepStrictEqual(streams, []);
    });

    await test("une seule fiche sert toute la série (2e épisode sans requête)", async () => {
        settings({});
        const calls = installFetch({ search: SEARCH_TV });
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 1, 15);
        const sheets = hit(calls, "/sheet").length;

        const t = Date.now();
        const other = await provider.getStreams("45790", "tv", 2, 1);
        const elapsed = Date.now() - t;

        assert.strictEqual(hit(calls, "/sheet").length, sheets, "aucune nouvelle fiche attendue");
        assert.strictEqual(other.length, 1);
        assert.ok(other[0].url.indexOf("/S2/E1/") !== -1);
        assert.ok(elapsed < 50, "l'épisode suivant doit être instantané (mesuré " + elapsed + " ms)");
    });

    await test("cache : le même film demandé 2 fois ne fait rien la 2e fois", async () => {
        settings({});
        const calls = installFetch({});
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");
        const before = calls.length;

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(calls.length, before, "aucune requête supplémentaire attendue");
        assert.strictEqual(streams.length, 1);
        assert.ok(elapsed < 50, "cache trop lent: " + elapsed + " ms");
    });

    await test("dédup : deux appels simultanés partagent la résolution", async () => {
        settings({});
        const calls = installFetch({});
        const provider = freshProvider();

        const both = await Promise.all([provider.getStreams("969681", "movie"), provider.getStreams("969681", "movie")]);

        assert.strictEqual(hit(calls, "/media/16989/sheet").length, 1, "une seule fiche attendue");
        assert.strictEqual(both[0].length, 1);
        assert.strictEqual(both[1].length, 1);
    });

    await test("mapping : un candidat au mauvais tmdbId est écarté au profit du bon", async () => {
        settings({});
        const calls = installFetch({ search: SEARCH_MOVIE_DECOY, sheets: { "777": DECOY_SHEET, "16989": MOVIE_SHEET } });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.ok(hit(calls, "/media/777/sheet").length === 1, "le leurre doit être testé");
        assert.strictEqual(streams.length, 1);
        assert.ok(streams[0].url.indexOf("969681") !== -1, "mauvaise fiche retenue: " + streams[0].url);
    });

    await test("sélection d'id : une fois l'id connu, plus de recherche", async () => {
        settings({});
        const calls = installFetch({ search: SEARCH_TV });
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 1, 15);
        const searches = hit(calls, "/search-bar/search/").length;

        // épisode jamais demandé : la fiche est en cache, aucune recherche ni TMDb
        await provider.getStreams("45790", "tv", 1, 16);
        assert.strictEqual(hit(calls, "/search-bar/search/").length, searches);
        assert.strictEqual(hit(calls, "api.themoviedb.org").length, 1);
    });

    await test("tri : la version préférée passe en premier", async () => {
        settings({ lang: "VOSTFR" });
        installFetch({ search: SEARCH_TV });
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 2, 1);
        assert.strictEqual(streams.length, 1);
        assert.strictEqual(streams[0].lang, "VOSTFR");
    });

    await test("domaine mort : bascule sur un autre hôte", async () => {
        settings({ domain: "purstream.mort", autoFallback: true });
        const calls = installFetch({ failing: ["api.purstream.mort"] });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.ok(hit(calls, "api.purstream.mort").length === 1, "l'hôte principal doit être tenté");
        assert.ok(hit(calls, "api.purstream.tech").length >= 1, "le domaine par défaut doit être tenté");
        assert.strictEqual(streams.length, 1);
    });

    await test("fallback désactivé : un seul hôte Purstream tenté", async () => {
        settings({ domain: "purstream.mort", autoFallback: false });
        const calls = installFetch({});
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");

        const apiCalls = calls.filter(function (call) {
            return call.url.indexOf("api.purstream") !== -1;
        });
        // recherche + fiche, mais toujours sur le domaine configuré, sans secours.
        assert.ok(apiCalls.length >= 1, "aucune requête Purstream");
        apiCalls.forEach(function (call) {
            assert.ok(call.url.indexOf("api.purstream.mort") !== -1, "hôte de secours utilisé: " + call.url);
        });
        assert.strictEqual(hit(calls, "api.purstream.tech").length, 0, "aucun hôte de secours quand le fallback est désactivé");
    });

    await test("hôte qui pend : la rafale parallèle prend le relais et annule l'appel", async () => {
        settings({ domain: "purstream-pend.tld", autoFallback: true });
        const calls = installFetch({ hanging: ["purstream-pend.tld"] });
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(streams.length, 1);
        assert.ok(elapsed < 1500, "bascule trop lente: " + elapsed + " ms");
        const hangingCall = hit(calls, "api.purstream-pend.tld")[0];
        assert.strictEqual(hangingCall.options.signal.aborted, true, "l'appel qui pend doit être annulé");
    });

    await test("cooldown : un hôte qui vient d'échouer est évité", async () => {
        settings({ domain: "purstream.mort", autoFallback: true });
        const calls = installFetch({ failing: ["api.purstream.mort"] });
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");
        const before = hit(calls, "api.purstream.mort").length;

        await provider.getStreams("550", "movie");
        assert.strictEqual(hit(calls, "api.purstream.mort").length, before, "l'hôte mort ne doit pas être retenté");
    });

    await test("TMDb injoignable : renvoie [] sans jeter", async () => {
        settings({});
        installFetch({ tmdbFails: true });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.deepStrictEqual(streams, []);
    });

    await test("settings : structure renvoyée par onSettings()", async () => {
        settings({});
        const provider = freshProvider();
        const list = await provider.onSettings();

        const keys = list.map(function (item) {
            return item.key;
        });
        ["domain", "autoFallback", "prewarm", "lang", "showLang"].forEach(function (key) {
            assert.ok(keys.indexOf(key) !== -1, "réglage manquant: " + key);
        });
        const domainField = list.filter(function (item) {
            return item.key === "domain";
        })[0];
        assert.strictEqual(domainField.defaultValue, "purstream.tech");
    });
}

// ---------------------------------------------------------------------------
// 2. Tests live
// ---------------------------------------------------------------------------

async function liveTests() {
    section("Live — API réelle api.purstream.tech");
    globalThis.fetch = REAL_FETCH;

    let movieStream = null;
    let episodeStream = null;

    await test("film 969681 : source m3u8 avec headers du site", async () => {
        settings({});
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "aucune source renvoyée par l'API live");
        assert.ok(streams[0].url.indexOf(".m3u8") !== -1, "URL inattendue: " + streams[0].url);
        assert.strictEqual(streams[0].headers.Referer, "https://purstream.tech/");
        assert.strictEqual(streams[0].headers.Origin, "https://purstream.tech");
        movieStream = streams[0];
        console.log("       -> " + streams[0].title + " | " + streams[0].url + " (" + elapsed + " ms)");
    });

    await test("série 45790 S1E15 : l'épisode demandé est bien celui renvoyé", async () => {
        settings({});
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("45790", "tv", 1, 15);
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "aucune source renvoyée par l'API live");
        assert.ok(/[\/_-]S1[\/_-]?E15/i.test(streams[0].url), "mauvais épisode: " + streams[0].url);
        episodeStream = streams[0];
        console.log("       -> " + streams[0].title + " | " + streams[0].url + " (" + elapsed + " ms)");
    });

    await test("lecture : la playlist HLS est lisible avec les headers du scraper", async () => {
        assert.ok(episodeStream || movieStream, "aucun stream live à tester");
        const stream = episodeStream || movieStream;

        const good = await fetch(stream.url, { headers: stream.headers, redirect: "follow" });
        assert.ok(good.status < 400, "la playlist a répondu " + good.status + " avec les headers");
        const body = await good.text();
        assert.ok(body.indexOf("#EXTM3U") !== -1, "ce n'est pas une playlist HLS");

        // Le CDN filtre sur le User-Agent (pas sur Referer/Origin, vérifié au curl) :
        // un client non-navigateur se fait refuser, d'où le User-Agent dans les headers.
        const bot = await fetch(stream.url, { headers: { "User-Agent": "curl/8.5.0" }, redirect: "follow" });
        assert.ok(bot.status >= 400, "le CDN devrait refuser un User-Agent curl (reçu " + bot.status + ")");
        console.log("       -> playlist HLS " + body.split("\n").length + " lignes (navigateur), HTTP " + bot.status + " avec User-Agent curl");
    });

    await test("live : épisode suivant instantané depuis la fiche en cache", async () => {
        settings({});
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 1, 15);
        const t = Date.now();
        const streams = await provider.getStreams("45790", "tv", 1, 16);
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "aucune source pour l'épisode suivant");
        assert.ok(elapsed < 50, "fiche non réutilisée: " + elapsed + " ms");
        console.log("       -> S1E16 en " + elapsed + " ms");
    });

    await test("rotation de domaine : bascule rapide depuis un domaine qui pend", async () => {
        settings({ domain: "10.255.255.1.nip.io", autoFallback: true });
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "le fallback n'a pas joint Purstream");
        assert.strictEqual(streams[0].headers.Referer, "https://purstream.tech/");
        assert.ok(elapsed < 3000, "bascule trop lente: " + elapsed + " ms");
        console.log("       -> film 969681 en " + elapsed + " ms via la rafale parallèle");
    });
}

(async function main() {
    await offlineTests();
    await liveTests();
    globalThis.fetch = REAL_FETCH;

    console.log("\n" + passes + " test(s) ok, " + failures + " échec(s)");
    process.exit(failures === 0 ? 0 : 1);
})();
