/**
 * Outbound HTTP for user-influenced URLs.
 *
 * Every URL this service fetches is derived from something a user pasted, so
 * this module is the SSRF boundary. Rules:
 *   - https only, no credentials in the URL, default port only
 *   - the host must pass the caller's allow-list
 *   - every resolved address must be public (no loopback, private, link-local,
 *     CGNAT, metadata 169.254.169.254, multicast, IPv4-mapped tricks, …)
 *   - redirects are followed by hand, re-validating each hop, with a hop cap
 *   - every response is size-capped and time-boxed
 *
 * Known gap (Phase 2): the address check and the connection resolve DNS
 * separately, so a hostile DNS server could answer differently the second
 * time (DNS rebinding). The allow-list limits this to TikTok/CDN domains,
 * which we do not expect to rebind; Phase 2 pins the connection to the
 * checked address.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class SafeFetchError extends Error {
  constructor(
    readonly code:
      | "INVALID_URL"
      | "HOST_NOT_ALLOWED"
      | "PRIVATE_ADDRESS"
      | "TOO_MANY_REDIRECTS"
      | "TOO_LARGE"
      | "TIMEOUT"
      | "NETWORK",
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

// Two separate lists on purpose: Node's BlockList matches IPv4 and IPv6 rules
// against each other, so a single list holding ::ffff:0:0/96 blocks every IPv4
// address. IPv4-mapped IPv6 addresses are routed to the IPv4 list by hand below.
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(network, prefix, "ipv6");

/** True only for globally routable unicast addresses. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) must be judged by its IPv4 address.
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !blockedV4.check(mapped[1]!, "ipv4");
    return !blockedV6.check(address, "ipv6");
  }
  return false;
};

export type HostPolicy = (hostname: string) => boolean;

/** Parses and validates a URL against the policy. Upgrades http → https. */
export const validateUrl = (raw: string | URL, allowHost: HostPolicy): URL => {
  let url: URL;
  try {
    url = new URL(raw.toString());
  } catch {
    throw new SafeFetchError("INVALID_URL", "Not a valid URL");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new SafeFetchError("INVALID_URL", "Only https links are supported");
  if (url.username || url.password) throw new SafeFetchError("INVALID_URL", "URLs with credentials are not allowed");
  if (url.port && url.port !== "443") throw new SafeFetchError("INVALID_URL", "Non-standard ports are not allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host) || !allowHost(host)) throw new SafeFetchError("HOST_NOT_ALLOWED", `Host not allowed: ${host}`);
  return url;
};

const assertResolvesPublic = async (hostname: string): Promise<void> => {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError("NETWORK", `Could not resolve ${hostname}`);
  }
  if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
    throw new SafeFetchError("PRIVATE_ADDRESS", `${hostname} resolves to a non-public address`);
  }
};

export type SafeFetchOptions = {
  allowHost: HostPolicy;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** When false, return the first redirect response instead of following it. */
  followRedirects?: boolean;
};

export type SafeResponse = {
  status: number;
  url: URL;
  /** Every URL visited, in order, including the final one. */
  hops: URL[];
  headers: Headers;
  body: Buffer;
};

const readCapped = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SafeFetchError("TOO_LARGE", `Response is ${declared} bytes (cap ${maxBytes})`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new SafeFetchError("TOO_LARGE", `Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const safeFetch = async (raw: string | URL, options: SafeFetchOptions): Promise<SafeResponse> => {
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const hops: URL[] = [];
  let url = validateUrl(raw, options.allowHost);

  for (let redirects = 0; ; redirects += 1) {
    hops.push(url);
    await assertResolvesPublic(url.hostname);

    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal: deadline, headers: options.headers });
    } catch (error) {
      if (deadline.aborted) throw new SafeFetchError("TIMEOUT", `Timed out after ${options.timeoutMs} ms`);
      throw new SafeFetchError("NETWORK", (error as Error).message);
    }

    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (isRedirect && options.followRedirects !== false) {
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= maxRedirects) throw new SafeFetchError("TOO_MANY_REDIRECTS", `More than ${maxRedirects} redirects`);
      url = validateUrl(new URL(location, url), options.allowHost);
      continue;
    }

    try {
      const body = await readCapped(response, options.maxBytes);
      return { status: response.status, url, hops, headers: response.headers, body };
    } catch (error) {
      if (deadline.aborted) throw new SafeFetchError("TIMEOUT", `Timed out after ${options.timeoutMs} ms`);
      throw error;
    }
  }
};
