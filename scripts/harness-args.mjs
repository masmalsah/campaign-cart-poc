// Shared argument parsing for the init-latency harnesses.
//
// Only the "where" and "how many" are adjustable. The measurement itself
// (throttle profile, ready signal, blocked hosts, cold cache) is fixed in
// each harness so that numbers from different machines are measured the
// same way.
//
//   --base <url>        Static server serving the test pages (default http://127.0.0.1:8899)
//   --variants <spec>   Either a JSON array of {name, path} or a comma list of
//                       name=path pairs, e.g. "baseline=/checkout/,exp-a=/checkout-exp-a/"
//   --runs <n>          Runs per variant (default 3; report the median)
//   --timeout <ms>      Give up waiting for ready after this long (default 45000)
//   --query <string>    Query string appended to every page URL (default "ignore=true",
//                       which keeps the SDK's analytics out of production data)
//
// The VARIANTS, RUNS and BASE environment variables are honoured too, for
// callers that already set them; flags win over env.

export function parseArgs(argv, defaults) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  if (flags.help) {
    console.error(HELP);
    process.exit(0);
  }

  const base = String(flags.base ?? process.env.BASE ?? defaults.base).replace(/\/$/, '');
  const runs = Number(flags.runs ?? process.env.RUNS ?? defaults.runs);
  const timeout = Number(flags.timeout ?? defaults.timeout);
  const query = String(flags.query ?? defaults.query);

  let variants = defaults.variants;
  const spec = flags.variants ?? process.env.VARIANTS;
  if (spec) variants = parseVariants(String(spec));

  if (!Number.isFinite(runs) || runs < 1) fail(`--runs must be a positive number, got ${flags.runs}`);
  if (!variants.length) fail('no variants given');
  for (const v of variants) {
    if (!v.name || !v.path) fail(`variant needs name and path: ${JSON.stringify(v)}`);
    if (!v.path.startsWith('/')) fail(`variant path must start with "/": ${v.path}`);
  }
  return { base, runs, timeout, query, variants };
}

function parseVariants(spec) {
  const trimmed = spec.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) fail('--variants JSON must be an array');
    return arr;
  }
  return trimmed
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) fail(`variant "${pair}" is not name=path`);
      return { name: pair.slice(0, eq).trim(), path: pair.slice(eq + 1).trim() };
    });
}

function fail(msg) {
  console.error(`harness: ${msg}`);
  process.exit(2);
}

const HELP = `Usage: node scripts/<harness>.mjs [--base URL] [--variants SPEC] [--runs N] [--timeout MS] [--query QS]

  --variants  JSON array of {name,path} or "name=/path/,name2=/path2/"
  --base      static server root, default http://127.0.0.1:8899
  --runs      runs per variant, default 3
  --timeout   ms to wait for next-display-ready, default 45000
  --query     query string for every page load, default ignore=true

Output: one JSON line per run on stdout. Report medians across runs.
See docs/init-latency-harness.md.`;
