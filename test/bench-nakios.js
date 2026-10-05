/**
 * Mesure du temps de recherche d'un stream (API réelle).
 *
 *   node test/bench-nakios.js                          # providers/nakios.js
 *   node test/bench-nakios.js /chemin/vers/ancienne.js # comparer une autre version
 *
 * Scénarios :
 *   A. happy path        : 8 films différents (aucun cache possible)
 *   B. même titre 2x     : montre l'effet du cache
 *   C. épisode suivant   : montre l'effet du prefetch (délai par défaut)
 *   D. domaine qui pend  : bascule parallèle vers un hôte qui répond
 *                          (10.255.255.1.nip.io ne répond jamais)
 *   E. préchauffage      : 1er appel à froid vs 1er appel après warm-up
 */

const path = require("path");

const PROVIDER = process.argv[2] || path.join(__dirname, "..", "providers", "nakios.js");
const MOVIE_IDS = ["969681", "550", "27205", "680", "603", "13", "155", "238"];

function fresh() {
    delete require.cache[require.resolve(PROVIDER)];
    return require(PROVIDER);
}

function use(overrides) {
    globalThis.SCRAPER_SETTINGS = Object.assign({ domain: "nakios.rent", lang: "all", showLang: true }, overrides);
}

async function timed(fn) {
    const start = Date.now();
    const result = await fn();
    return { ms: Date.now() - start, result: result };
}

async function scenarioA() {
    use({ prewarm: false, prefetch: false });
    const provider = fresh();
    const times = [];
    for (const id of MOVIE_IDS) {
        const run = await timed(() => provider.getStreams(id, "movie"));
        times.push(run.ms);
    }
    const sorted = times.slice().sort((a, b) => a - b);
    console.log("A. 8 films (aucun cache) : " + times.join(" ms, ") + " ms");
    console.log("   p50=" + sorted[Math.floor(sorted.length / 2)] + " ms  total=" + times.reduce((a, b) => a + b, 0) + " ms");
}

async function scenarioB() {
    use({ prewarm: false, prefetch: false });
    const provider = fresh();
    const first = await timed(() => provider.getStreams("969681", "movie"));
    const second = await timed(() => provider.getStreams("969681", "movie"));
    console.log("B. même titre 2x         : 1er=" + first.ms + " ms  2e=" + second.ms + " ms");
}

async function scenarioC() {
    use({ prewarm: false, prefetch: true });
    const provider = fresh();
    const first = await timed(() => provider.getStreams("45790", "tv", 1, 15));
    await new Promise((resolve) => setTimeout(resolve, 6000)); // laisse le prefetch se terminer
    const second = await timed(() => provider.getStreams("45790", "tv", 1, 16));
    console.log("C. S1E15 puis S1E16      : 1er=" + first.ms + " ms  2e=" + second.ms + " ms (préchargé en arrière-plan)");
}

async function scenarioD() {
    use({ domain: "10.255.255.1.nip.io", autoFallback: true, prewarm: false, prefetch: false });
    const provider = fresh();
    const run = await timed(() => provider.getStreams("969681", "movie"));
    console.log("D. domaine qui pend      : " + run.ms + " ms (" + run.result.length + " source)");
}

async function scenarioE() {
    const cold = [];
    const warm = [];

    for (let i = 0; i < 3; i++) {
        use({ prewarm: false, prefetch: false });
        let provider = fresh();
        let run = await timed(() => provider.getStreams("550", "movie"));
        cold.push(run.ms);

        use({ prewarm: true, prefetch: false });
        provider = fresh();
        await new Promise((resolve) => setTimeout(resolve, 1700)); // laisse le warm-up finir
        run = await timed(() => provider.getStreams("550", "movie"));
        warm.push(run.ms);
    }

    const avg = (list) => Math.round(list.reduce((a, b) => a + b, 0) / list.length);
    console.log("E. 1er appel à froid     : " + cold.join(" ms, ") + " ms (moy " + avg(cold) + " ms)");
    console.log("   1er appel préchauffé  : " + warm.join(" ms, ") + " ms (moy " + avg(warm) + " ms)");
}

(async function main() {
    console.log("\n=== " + PROVIDER + " ===");
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
})();
