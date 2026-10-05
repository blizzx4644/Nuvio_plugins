/**
 * Mesure du temps de recherche d'un stream, pour chaque scraper du dépôt.
 *
 *   node test/bench.js                                 # tous les providers
 *   node test/bench.js providers/nakios.js             # un seul
 *   node test/bench.js /tmp/nakios-v1.js               # comparer une ancienne version
 *
 * Scénarios :
 *   A. happy path       : 8 films différents (aucun cache possible)
 *   B. même titre 2x    : effet du cache (et du prefetch pour NAKIOS)
 *   C. 2 épisodes       : NAKIOS précharge le suivant, PURSTREAM sert la série
 *                         entière depuis une seule fiche
 *   D. domaine qui pend : bascule parallèle vers un hôte qui répond
 *                         (10.255.255.1.nip.io ne répond jamais)
 */

const fs = require("fs");
const path = require("path");

const MOVIE_IDS = ["969681", "550", "27205", "680", "603", "13", "155", "238"];

function providers() {
    if (process.argv[2]) return [process.argv[2]];
    const dir = path.join(__dirname, "..", "providers");
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => path.join(dir, name));
}

function fresh(providerPath) {
    delete require.cache[require.resolve(providerPath)];
    return require(providerPath);
}

function use(overrides) {
    globalThis.SCRAPER_SETTINGS = Object.assign({ domain: "", lang: "all", showLang: true }, overrides);
}

async function timed(fn) {
    const start = Date.now();
    const result = await fn();
    return { ms: Date.now() - start, result: result };
}

async function scenarioA(providerPath, domain) {
    use({ domain: domain, prewarm: false, prefetch: false });
    const provider = fresh(providerPath);
    const times = [];
    const found = [];
    for (const id of MOVIE_IDS) {
        const run = await timed(() => provider.getStreams(id, "movie"));
        times.push(run.ms);
        found.push(run.result.length);
    }
    const sorted = times.slice().sort((a, b) => a - b);
    console.log("A. 8 films (aucun cache) : " + times.join(" ms, ") + " ms");
    console.log("   p50=" + sorted[Math.floor(sorted.length / 2)] + " ms  total=" + times.reduce((a, b) => a + b, 0) + " ms");
    console.log("   sources trouvées     : " + found.join(", "));
}

async function scenarioB(providerPath, domain) {
    use({ domain: domain, prewarm: false, prefetch: false });
    const provider = fresh(providerPath);
    const first = await timed(() => provider.getStreams("969681", "movie"));
    const second = await timed(() => provider.getStreams("969681", "movie"));
    console.log("B. même titre 2x         : 1er=" + first.ms + " ms  2e=" + second.ms + " ms");
}

async function scenarioC(providerPath, domain) {
    use({ domain: domain, prewarm: false, prefetch: true });
    const provider = fresh(providerPath);
    const first = await timed(() => provider.getStreams("45790", "tv", 1, 15));
    await new Promise((resolve) => setTimeout(resolve, 6000)); // laisse le prefetch NAKIOS se terminer
    const second = await timed(() => provider.getStreams("45790", "tv", 1, 16));
    console.log("C. S1E15 puis S1E16      : 1er=" + first.ms + " ms  2e=" + second.ms + " ms");
}

async function scenarioD(providerPath) {
    use({ domain: "10.255.255.1.nip.io", autoFallback: true, prewarm: false, prefetch: false });
    const provider = fresh(providerPath);
    const run = await timed(() => provider.getStreams("969681", "movie"));
    console.log("D. domaine qui pend      : " + run.ms + " ms (" + run.result.length + " source)");
}

(async function main() {
    for (const providerPath of providers()) {
        console.log("\n=== " + providerPath + " ===");
        const name = path.basename(providerPath);
        // NAKIOS tourne sur nakios.rent, PURSTREAM sur purstream.tech.
        const domain = name.indexOf("purstream") !== -1 ? "purstream.tech" : "nakios.rent";
        await scenarioA(providerPath, domain);
        await scenarioB(providerPath, domain);
        await scenarioC(providerPath, domain);
        await scenarioD(providerPath);
    }
})();
