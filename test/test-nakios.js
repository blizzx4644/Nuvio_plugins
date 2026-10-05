/**
 * Tests du scraper NAKIOS pour Nuvio.
 *
 *   node test/test-nakios.js
 *
 * 1. Tests hors ligne : fetch mocké, on vérifie l'URL construite, les headers
 *    Referer/Origin envoyés, le mapping des sources et le fallback de domaine.
 * 2. Tests live : vrais appels sur api.nakios.rent (film 969681, série 45790
 *    S1E15) + vérification que le MP4 renvoyé est bien lisible avec les headers
 *    fournis par le scraper.
 */

const assert = require("assert");
const path = require("path");

const PROVIDER_PATH = path.join(__dirname, "..", "providers", "nakios.js");
const REAL_FETCH = globalThis.fetch;

let failures = 0;
let passes = 0;

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

function mockFetch(fixture, failFor) {
    const calls = [];
    globalThis.fetch = function (url, options) {
        calls.push({ url: url, options: options || {} });
        const shouldFail = (failFor || []).some(function (host) {
            return String(url).indexOf(host) !== -1;
        });
        if (shouldFail) {
            return Promise.reject(new Error("mock: host injoignable"));
        }
        return Promise.resolve({
            status: 200,
            ok: true,
            json: function () {
                return Promise.resolve(fixture);
            }
        });
    };
    return calls;
}

// ---------------------------------------------------------------------------
// 1. Tests hors ligne
// ---------------------------------------------------------------------------

async function offlineTests() {
    section("Hors ligne — construction des requêtes");

    await test("film : URL /api/sources/movie/{tmdbId} + headers du site", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.rent", lang: "all", showLang: true };
        const calls = mockFetch(MOVIE_FIXTURE, []);
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
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.rent", lang: "all", showLang: true };
        const calls = mockFetch(TV_FIXTURE, []);
        const provider = freshProvider();

        const streams = await provider.getStreams("45790", "tv", 1, 15);

        assert.strictEqual(calls[0].url, "https://api.nakios.rent/api/sources/tv/45790/1/15");
        assert.strictEqual(calls[0].options.headers.Referer, "https://nakios.rent/");
        assert.strictEqual(streams.length, 1);
        assert.ok(streams[0].url.endsWith("S01-E15.mp4"), "mauvais épisode: " + streams[0].url);
    });

    await test("domaine personnalisé : api.<domaine> + Referer sur le bon site", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "https://Nakios.TO/accueil", lang: "all", showLang: true };
        const calls = mockFetch(TV_FIXTURE, []);
        const provider = freshProvider();

        await provider.getStreams("45790", "tv", 2, 3);

        assert.strictEqual(calls[0].url, "https://api.nakios.to/api/sources/tv/45790/2/3");
        assert.strictEqual(calls[0].options.headers.Referer, "https://nakios.to/");
        assert.strictEqual(calls[0].options.headers.Origin, "https://nakios.to");
    });

    await test("domaine mort : bascule sur api.nakios.rent", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.mort", lang: "all", showLang: true, autoFallback: true };
        const calls = mockFetch(MOVIE_FIXTURE, ["api.nakios.mort"]);
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.ok(calls.length >= 2, "le fallback n'a pas été tenté");
        assert.strictEqual(calls[0].url.indexOf("api.nakios.mort"), 8);
        assert.strictEqual(calls[1].url, "https://api.nakios.rent/api/sources/movie/969681");
        assert.strictEqual(streams.length, 1);
    });

    await test("fallback désactivé : aucun appel de secours", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.mort", lang: "all", autoFallback: false };
        const calls = mockFetch(MOVIE_FIXTURE, []);
        const provider = freshProvider();

        await provider.getStreams("969681", "movie");

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].url, "https://api.nakios.mort/api/sources/movie/969681");
    });

    await test("filtre langue VOSTFR : on garde le VF si c'est le seul dispo", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.rent", lang: "VOSTFR", showLang: true };
        const calls = mockFetch(MOVIE_FIXTURE, []);
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");

        assert.strictEqual(streams.length, 1, "le filtre ne doit jamais tout masquer");
        assert.strictEqual(streams[0].lang, "VF");
    });

    await test("settings : structure renvoyée par onSettings()", async () => {
        const provider = freshProvider();
        const settings = await provider.onSettings();

        assert.ok(Array.isArray(settings), "onSettings doit renvoyer un tableau");
        const keys = settings.map(function (item) {
            return item.key;
        });
        assert.ok(keys.indexOf("domain") !== -1);
        assert.ok(keys.indexOf("lang") !== -1);
        const domainField = settings.filter(function (item) {
            return item.key === "domain";
        })[0];
        assert.strictEqual(domainField.defaultValue, "nakios.rent");
    });

    await test("API en échec : renvoie [] sans jeter", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.mort", autoFallback: false };
        mockFetch(MOVIE_FIXTURE, ["nakios.mort"]);
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.deepStrictEqual(streams, []);
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
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.rent", lang: "all", showLang: true };
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
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.rent", lang: "all", showLang: true };
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
        assert.ok(buffer.slice(0, 32).toString("latin1").indexOf("ftyp") !== -1, "ce n'est pas un MP4 : " + buffer.slice(0, 32).toString("latin1"));
        console.log("       -> " + buffer.length + " octets MP4 reçus (" + (response.headers.get("content-type") || "content-type absent") + ")");
    });

    await test("rotation de domaine : domaine invalide -> bascule réelle sur api.nakios.rent", async () => {
        globalThis.SCRAPER_SETTINGS = { domain: "nakios.mort", lang: "all", showLang: true, autoFallback: true };
        const provider = freshProvider();

        const streams = await provider.getStreams("969681", "movie");
        assert.ok(streams.length > 0, "le fallback n'a pas réussi à joindre Nakios");
        assert.strictEqual(streams[0].headers.Referer, "https://nakios.rent/");
    });
}

(async function main() {
    await offlineTests();
    await liveTests();
    globalThis.fetch = REAL_FETCH;

    console.log("\n" + passes + " test(s) ok, " + failures + " échec(s)");
    process.exit(failures === 0 ? 0 : 1);
})();
