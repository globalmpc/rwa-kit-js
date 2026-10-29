/**
 * Keeps credentials out of anything this package writes.
 *
 * `@globalmpc/evm-log-walker` redacts endpoint URLs to their origin, and `sanitizeProviderText`
 * makes an endpoint's own wording fit for one log line — control characters removed, whitespace
 * collapsed, length capped. Neither removes secrets: a provider answering
 * `invalid API key: <key>` has that text embedded verbatim in `RpcError.message`, and printing it
 * would put the key in a CI log.
 *
 * The user tells us what the secrets are by passing endpoint URLs, so everything in those URLs
 * beyond the origin is treated as secret and masked wherever it appears in outgoing text.
 */

/**
 * Shortest value treated as a credential.
 *
 * One floor for every URL component, including path segments: a higher floor for paths would
 * leave a five-character key in `https://rpc.example/abcde` unmasked — and the cost of being
 * wrong is asymmetric: over-masking makes a message less readable, under-masking puts a key in a
 * CI log.
 *
 * Four is low enough that no real credential slips under it and high enough that the common short
 * routing segments (`v1`, `v2`, `eth`, `rpc`, `ws`) are left alone.
 */
const MIN_SECRET = 4;

/**
 * The parts of the given endpoint URLs that must never be printed: path segments, query values,
 * fragment and userinfo. The origin is deliberately excluded — it is what provenance reports.
 *
 * Short fragments are dropped: masking a 3-character path segment would scrub unrelated words out
 * of every message for no gain.
 */
export function secretsFromEndpoints(urls: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    // `pathname`, `username`, `password` and `hash` keep their percent-encoding, while a provider
    // echoing the credential back prints it decoded: a key of `key%2Fpart123` in the URL comes
    // back as `key/part123`. Both spellings are collected, or the decoded one reaches stderr
    // unmasked. `searchParams` already decodes, so its values need the encoded form adding.
    // `searchParams` also turns `+` into a space, so `?apikey=abcd+efgh` would only yield
    // `abcd efgh`; the raw pairs are split out of `search` too, to keep the spelling as written.
    const rawQuery = url.search.replace(/^\?/, "").split("&").flatMap((pair) => pair.split("="));
    for (const part of [
      ...url.pathname.split("/"),
      ...[...url.searchParams.values()],
      ...[...url.searchParams.keys()],
      ...rawQuery,
      url.username,
      url.password,
      url.hash.replace(/^#/, ""),
    ]) {
      for (const value of variants(part.trim())) {
        if (value.length >= MIN_SECRET) found.add(value);
      }
    }
  }
  // Longest first, so a secret that contains another is masked whole rather than in pieces.
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * A value as it may appear in text: as written, decoded, and encoded. Decoding can throw on a
 * malformed sequence, and encoding a decoded value recovers spellings a provider may normalise to.
 */
function variants(value: string): string[] {
  const out = new Set<string>([value]);
  try {
    out.add(decodeURIComponent(value));
  } catch {
    // A malformed percent sequence cannot be decoded; the raw form is still collected.
  }
  try {
    out.add(encodeURIComponent(value));
  } catch {
    // Lone surrogates cannot be encoded; again, the raw form stands.
  }
  return [...out];
}

/** Every character that would otherwise be a regular-expression operator. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Replaces every occurrence of each secret with `[redacted]`, whatever its casing.
 *
 * Matching the literal spelling and its lower-cased form is not enough: a provider is free to
 * upper-case or title-case the value it echoes, and an unmatched spelling is a credential in a
 * log. A case-insensitive match over the escaped secret covers every spelling at once.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.replace(new RegExp(secret.replace(REGEX_SPECIAL, "\\$&"), "gi"), "[redacted]");
  }
  return out;
}

/**
 * Everything an error message could reveal about the given endpoints, replaced: each endpoint's
 * origin, host and hostname by its position label (`endpoint-1`), then every credential-bearing
 * part beyond the origin by `[redacted]`.
 *
 * `secretsFromEndpoints` leaves the origin alone, but `evm-log-walker` names the origin in its
 * errors, and some providers issue keyed subdomains — `https://<key>.rpc.example` — so the host can
 * itself be the credential. Naming endpoints by position in errors, as in every other output, means
 * no part of a URL the user supplied is ever printed.
 */
export function redactEndpoints(text: string, urls: readonly string[]): string {
  const labels: [string, string][] = [];
  const subdomains: string[] = [];
  urls.forEach((raw, index) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    for (const part of [url.origin, url.host, url.hostname]) {
      if (part !== "" && part !== "null") labels.push([part, `endpoint-${index + 1}`]);
    }
    subdomains.push(...subdomainLabels(url.hostname));
  });
  // Longest first, so an origin is replaced whole before its hostname could split it.
  labels.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [part, label] of labels) {
    out = out.replace(new RegExp(part.replace(REGEX_SPECIAL, "\\$&"), "gi"), label);
  }
  const secrets = new Set([...secretsFromEndpoints(urls), ...subdomains]);
  return redactSecrets(out, [...secrets].sort((a, b) => b.length - a.length));
}

/**
 * The labels of a hostname left of its registrable domain, each a possible credential.
 *
 * Replacing the whole hostname is not enough: a provider rejecting `https://<key>.rpc.example`
 * may echo `invalid API key: <key>` on its own. The last two labels name the provider and are left
 * readable; IP addresses carry no labels to mask.
 */
function subdomainLabels(hostname: string): string[] {
  if (hostname.startsWith("[") || /^[\d.]+$/.test(hostname)) return [];
  return hostname
    .split(".")
    .slice(0, -2)
    .filter((label) => label.length >= MIN_SECRET);
}
