/**
 * Tests du scraper NAKIOS pour Nuvio.
 *
 *   node test/test-nakios.js
 *
 * 1. Tests hors ligne : fetch mocké (URL, headers, mapping, tri, cache, dédup,
 *    bascule parallèle de domaine, cooldown, prefetch, préchauffage).
 * 2. Tests live : vrais appels sur api.nakios.rent + vérification que le MP4
 *    renvoyé est bien lisible avec les headers fournis par le scraper.
 */

const assert = require("assert");
const path = require("path");

const PROVIDER_PATH = path.join(__dirname, "..", "providers", "nakios.js");
const REAL_FETCH = globalThis.fetch;

// Déterministe : ni préchauffage ni prefetch sauf dans les tests dédiés.
globalThis.SCRAPER_SETTINGS = { prewarm: false, prefetch: false };

let failures = 0;
let passes = 0;

function settings(overrides) {
    const config = Object.assign({ domain: "nakios.rent", lang: "all", showLang: true, prewarm: false, prefetch: false }, overrides);
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fixtures (mêmes charges utiles que l'API réelle)
// ---------------------------------------------------------------------------

const MOVIE_FIXTURE = {
    success: true,
    sources: [
        {
            id: "noctaflix-movie-969681",
            name: "NAKIOS (NK)",
            url: "https://cdn79.mongo-loko.store/movies/Spider-Man-Brand-New-Day-2026-Swiftflow.mp4",
            quality: "HD",
            isEmbed: false,
            isPremium: true,
            isM3U8: false,
            lang: "VF",
            provider: "NAKIOS (NK)"
        }
    ]
};

const TV_FIXTURE = {
    success: true,
    sources: [
        {
            id: "noctaflix-tv-45790-s1e15",
            name: "NAKIOS (NK)",
            url: "https://cdn79.mongo-loko.store/animes/VF/Jojo-S-Bizarre-Adventure/S01/jojo-s-bizarre-adventure-S01-E15.mp4",
            quality: "HD",
            isEmbed: false,
            isPremium: true,
            isM3U8: false,
            lang: "VF",
            provider: "NAKIOS (NK)"
        }
    ]
};

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockResponse(body, status) {
    return {
        status: status === undefined ? 200 : status,
        ok: (status === undefined ? 200 : status) < 400,
        json: function () {
            return Promise.resolve(body);
        }
    };
}

// Un hôte qui ne répond jamais (le fameux "domaine qui pend"), jusqu'à abort.
function hangUntilAborted(record) {
    return new Promise(function (_, reject) {
        const signal = record.options.signal;
        if (!signal) return; // sans AbortController on ne saurait pas sortir
        signal.addEventListener("abort", function () {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
        });
    });
}

/**
 * Installe un fetch mocké. `handler(record)` renvoie soit une réponse, soit une
 * promesse. Par défaut : fixture renvoyée pour tout, sauf les hôtes de
 * `failing` qui échouent, et `hanging` qui pendent.
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
        if (typeof config.handler === "function") return Promise.resolve(config.handler(record));
        return Promise.resolve(mockResponse(config.body || MOVIE_FIXTURE));
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
    section("Hors ligne — requêtes, mapping et tri");

    await test("film : URL /api/sources/movie/{tmdbId} + headers du site", async () => {
        settings({});
        const calls = installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.strictEqual(calls.length, 1, "un seul appel attendu");
        assert.strictEqual(calls[0].url, "https://api.nakios.rent/api/sources/movie/969681");
        assert.strictEqual(calls[0].options.headers.Referer, "https://nakios.rent/");
        assert.strictEqual(calls[0].options.headers.Origin, "https://nakios.rent");

        assert.strictEqual(streams.length, 1);
        assert.strictEqual(streams[0].url, MOVIE_FIXTURE.sources[0].url);
        assert.strictEqual(streams[0].name, "NAKIOS");
        assert.strictEqual(streams[0].quality, "HD");
        assert.ok(streams[0].title.indexOf("VF") !== -1, "langue absente du titre");
        assert.strictEqual(streams[0].headers.Referer, "https://nakios.rent/");
        assert.strictEqual(streams[0].headers.Origin, "https://nakios.rent");
    });

    await test("série : URL /api/sources/tv/{tmdbId}/{saison}/{épisode}", async () => {
        settings({});
        const calls = installFetch({ body: TV_FIXTURE });
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 1, 15);

        assert.strictEqual(calls[0].url, "https://api.nakios.rent/api/sources/tv/45790/1/15");
        assert.strictEqual(calls[0].options.headers.Referer, "https://nakios.rent/");
        assert.strictEqual(streams.length, 1);
        assert.ok(streams[0].url.endsWith("S01-E15.mp4"), "mauvais épisode: " + streams[0].url);
    });

    await test("domaine personnalisé : api.<domaine> + Referer sur le bon site", async () => {
        settings({ domain: "https://Nakios.TO/accueil" });
        const calls = installFetch({ body: TV_FIXTURE });
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 2, 3);

        assert.strictEqual(calls[0].url, "https://api.nakios.to/api/sources/tv/45790/2/3");
        assert.strictEqual(calls[0].options.headers.Referer, "https://nakios.to/");
        assert.strictEqual(calls[0].options.headers.Origin, "https://nakios.to");
    });

    await test("tri : meilleure source d'abord, liens embed en dernier", async () => {
        settings({ lang: "all" });
        installFetch({
            body: {
                success: true,
                sources: [
                    { name: "NAKIOS (NK)", url: "https://cdn/movie-vf-embed.mp4", quality: "4K", lang: "VF", isEmbed: true },
                    { name: "NAKIOS (NK)", url: "https://cdn/movie-vf.mp4", quality: "HD", lang: "VF" },
                    { name: "NAKIOS (NK)", url: "https://cdn/movie-vostfr.mp4", quality: "1080p", lang: "VOSTFR" }
                ]
            }
        });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.strictEqual(streams.length, 3);
        assert.strictEqual(streams[0].lang, "VOSTFR", "la meilleure qualité/langue doit passer en premier");
        assert.strictEqual(streams[0].isEmbed, false);
        assert.strictEqual(streams[streams.length - 1].isEmbed, true, "les liens embed doivent passer en dernier");
    });

    await test("doublons : une même URL n'est renvoyée qu'une fois", async () => {
        settings({});
        installFetch({
            body: {
                success: true,
                sources: [
                    { name: "NAKIOS (NK)", url: "https://cdn/same.mp4", quality: "HD", lang: "VF" },
                    { name: "NAKIOS (NK)", url: "https://cdn/same.mp4", quality: "HD", lang: "VF" },
                    { name: "NAKIOS (NK)", url: "", quality: "HD", lang: "VF" }
                ]
            }
        });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.strictEqual(streams.length, 1);
    });

    await test("domaine mort : bascule immédiate sur api.nakios.rent", async () => {
        settings({ domain: "nakios.mort", autoFallback: true });
        const calls = installFetch({ failing: ["api.nakios.mort"], body: MOVIE_FIXTURE });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.ok(hit(calls, "api.nakios.mort").length === 1, "l'hôte principal doit être tenté");
        assert.ok(hit(calls, "api.nakios.rent").length === 1, "le domaine par défaut doit être tenté");
        assert.strictEqual(streams.length, 1);
    });

    await test("fallback désactivé : aucun appel de secours", async () => {
        settings({ domain: "nakios.mort", autoFallback: false });
        const calls = installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].url, "https://api.nakios.mort/api/sources/movie/969681");
    });

    await test("filtre langue VOSTFR : on garde le VF si c'est le seul dispo", async () => {
        settings({ lang: "VOSTFR" });
        installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.strictEqual(streams.length, 1, "le filtre ne doit jamais tout masquer");
        assert.strictEqual(streams[0].lang, "VF");
    });

    await test("settings : structure renvoyée par onSettings()", async () => {
        settings({});
        const provider = freshProvider();
        const list = await provider.onSettings();

        assert.ok(Array.isArray(list), "onSettings doit renvoyer un tableau");
        const keys = list.map(function (item) {
            return item.key;
        });
        ["domain", "autoFallback", "prewarm", "prefetch", "lang", "showLang"].forEach(function (key) {
            assert.ok(keys.indexOf(key) !== -1, "réglage manquant: " + key);
        });
        const domainField = list.filter(function (item) {
            return item.key === "domain";
        })[0];
        assert.strictEqual(domainField.defaultValue, "nakios.rent");
    });

    await test("API en échec : renvoie [] sans jeter", async () => {
        settings({ domain: "nakios.mort", autoFallback: false });
        installFetch({ failing: ["nakios.mort"] });
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.deepStrictEqual(streams, []);
    });

    section("Hors ligne — vitesse");

    await test("cache : le 2e appel du même titre ne fait aucune requête", async () => {
        settings({});
        const calls = installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");
        assert.strictEqual(calls.length, 1);

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(calls.length, 1, "aucune nouvelle requête réseau attendue");
        assert.strictEqual(streams.length, 1);
        assert.ok(elapsed < 50, "le cache doit répondre en < 50 ms (mesuré: " + elapsed + " ms)");
    });

    await test("dédup : deux appels simultanés partagent une seule requête", async () => {
        settings({});
        const calls = installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        const both = await Promise.all([provider.getStreams("969681", "movie"), provider.getStreams("969681", "movie")]);

        assert.strictEqual(calls.length, 1, "une seule requête attendue");
        assert.strictEqual(both[0].length, 1);
        assert.strictEqual(both[1].length, 1);
    });

    await test("hôte qui pend : la réponse arrive via un autre hôte en parallèle", async () => {
        settings({ domain: "nakios-pend.tld", autoFallback: true });
        const calls = installFetch({ hanging: ["nakios-pend.tld"], body: MOVIE_FIXTURE });
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(streams.length, 1, "un hôte qui pend ne doit jamais bloquer");
        assert.ok(elapsed < 1200, "bascule trop lente: " + elapsed + " ms");
        assert.ok(hit(calls, "api.nakios.rent").length === 1, "le domaine par défaut devait être interrogé en parallèle");
        const hangingCall = hit(calls, "api.nakios-pend.tld")[0];
        assert.strictEqual(hangingCall.options.signal.aborted, true, "la requête qui pend doit être annulée");
    });

    await test("cooldown : un hôte qui vient d'échouer n'est pas retenté tout de suite", async () => {
        settings({ domain: "nakios.mort", autoFallback: true });
        const calls = installFetch({ failing: ["api.nakios.mort"], body: MOVIE_FIXTURE });
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");
        const before = hit(calls, "api.nakios.mort").length;
        assert.strictEqual(before, 1);

        await provider.getStreams("550", "movie"); // autre titre -> pas de cache
        assert.strictEqual(hit(calls, "api.nakios.mort").length, before, "l'hôte mort ne doit pas être retenté dans la foulée");
    });

    await test("prefetch : l'épisode suivant est préchargé puis servi du cache", async () => {
        settings({ prefetch: true, prefetchDelay: 20 });
        const calls = installFetch({
            handler: (record) => {
                const match = record.url.match(/\/tv\/45790\/1\/(\d+)$/);
                const episode = match ? match[1] : "0";
                return mockResponse({
                    success: true,
                    sources: [{ name: "NAKIOS (NK)", url: "https://cdn/animes/VF/jojo-S01-E" + episode + ".mp4", quality: "HD", lang: "VF" }]
                });
            }
        });
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 1, 15);
        await wait(120);

        assert.ok(hit(calls, "/tv/45790/1/16").length === 1, "l'épisode suivant devait être préchargé");

        const t = Date.now();
        const streams = await provider.getStreams("45790", "tv", 1, 16);
        const elapsed = Date.now() - t;

        assert.strictEqual(streams.length, 1);
        assert.ok(streams[0].url.indexOf("E16") !== -1, "mauvais épisode: " + streams[0].url);
        assert.ok(elapsed < 50, "l'épisode préchargé doit être instantané (mesuré: " + elapsed + " ms)");
        assert.strictEqual(hit(calls, "/tv/45790/1/16").length, 1, "aucune requête supplémentaire attendue");
    });

    await test("préchargement : onSettings() réchauffe la connexion", async () => {
        settings({ prewarm: true });
        const calls = installFetch({ body: MOVIE_FIXTURE });
        const provider = freshProvider();

        await provider.onSettings();
        await wait(80);

        assert.ok(hit(calls, "/movie/969681").length >= 1, "le titre témoin devait être préchargé");

        const before = hit(calls, "/movie/969681").length;
        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(streams.length, 1);
        assert.strictEqual(hit(calls, "/movie/969681").length, before, "le titre préchargé ne doit plus faire de requête");
        assert.ok(elapsed < 50, "réponse attendue depuis le cache (< 50 ms), mesuré " + elapsed + " ms");
    });
}

// ---------------------------------------------------------------------------
// 2. Tests live
// ---------------------------------------------------------------------------

async function liveTests() {
    section("Live — API réelle api.nakios.rent");
    globalThis.fetch = REAL_FETCH;

    const movieStreams = [];
    const tvStreams = [];

    await test("film 969681 : au moins une source MP4 avec headers", async () => {
        settings({});
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.ok(streams.length > 0, "aucune source renvoyée par l'API live");
        assert.ok(/^https?:\/\//.test(streams[0].url), "URL invalide: " + streams[0].url);
        assert.strictEqual(streams[0].headers.Referer, "https://nakios.rent/");
        assert.strictEqual(streams[0].headers.Origin, "https://nakios.rent");
        movieStreams.push(streams[0]);
        console.log("       -> " + streams[0].title + " | " + streams[0].url);
    });

    await test("série 45790 S1E15 : au moins une source MP4 avec headers", async () => {
        settings({});
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 1, 15);
        assert.ok(streams.length > 0, "aucune source renvoyée par l'API live");
        assert.strictEqual(streams[0].headers.Referer, "https://nakios.rent/");
        tvStreams.push(streams[0]);
        console.log("       -> " + streams[0].title + " | " + streams[0].url);
    });

    await test("lecture : on récupère de vrais octets MP4 avec les headers du scraper", async () => {
        const stream = tvStreams[0] || movieStreams[0];
        assert.ok(stream, "aucun stream live à tester");

        const response = await fetch(stream.url, {
            headers: Object.assign({ Range: "bytes=0-2047" }, stream.headers),
            redirect: "follow"
        });
        assert.ok(response.status < 400, "le CDN a répondu " + response.status);

        const buffer = Buffer.from(await response.arrayBuffer());
        assert.ok(buffer.length > 0, "aucun octet reçu");
        // Le proxy CDN ne renvoie pas de Content-Type : on valide la signature MP4.
        assert.ok(buffer.slice(0, 32).toString("latin1").indexOf("ftyp") !== -1, "ce n'est pas un MP4");
        console.log("       -> " + buffer.length + " octets MP4 reçus (content-type: " + (response.headers.get("content-type") || "absent") + ")");
    });

    await test("rotation de domaine : bascule réelle et rapide depuis un domaine invalide", async () => {
        settings({ domain: "10.255.255.1.nip.io", autoFallback: true, prefetch: false });
        const provider = freshProvider();

        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "le fallback n'a pas réussi à joindre Nakios");
        assert.strictEqual(streams[0].headers.Referer, "https://nakios.rent/");
        assert.ok(elapsed < 2500, "bascule trop lente: " + elapsed + " ms");
        console.log("       -> bascule en " + elapsed + " ms");
    });

    await test("live : 2e appel du même titre instantané", async () => {
        settings({});
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");
        const t = Date.now();
        const streams = await provider.getStreams("969681", "movie");
        const elapsed = Date.now() - t;

        assert.strictEqual(streams.length, 1);
        assert.ok(elapsed < 50, "cache live trop lent: " + elapsed + " ms");
        console.log("       -> 2e appel en " + elapsed + " ms");
    });

    await test("live : episode suivant préchargé puis instantané", async () => {
        settings({ prefetch: true, prefetchDelay: 100 });
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 1, 17);
        await wait(900);

        const t = Date.now();
        const streams = await provider.getStreams("45790", "tv", 1, 18);
        const elapsed = Date.now() - t;

        assert.ok(streams.length > 0, "aucune source pour l'épisode préchargé");
        assert.ok(elapsed < 50, "prefetch live inefficace: " + elapsed + " ms");
        console.log("       -> S1E18 en " + elapsed + " ms");
    });
}

(async function main() {
    await offlineTests();
    await liveTests();
    globalThis.fetch = REAL_FETCH;

    console.log("\n" + passes + " test(s) ok, " + failures + " échec(s)");
    process.exit(failures === 0 ? 0 : 1);
})();
