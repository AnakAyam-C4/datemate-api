import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicAddress, safeFetch, SafeFetchError, validateUrl } from "../shared/safeFetch";
import { isTikTokCdnHost, isTikTokHost, resolveVideo, TikTokError } from "../1-tiktok/tiktok";

test("private, loopback, link-local and metadata addresses are rejected", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("validateUrl enforces scheme, host, port and credentials", () => {
  assert.equal(validateUrl("http://www.tiktok.com/x", isTikTokHost).protocol, "https:");
  for (const bad of [
    "ftp://www.tiktok.com/x",
    "javascript:alert(1)",
    "https://user:pass@www.tiktok.com/x",
    "https://www.tiktok.com:8443/x",
    "https://tiktok.com.evil.example/x",
    "https://evil.example/www.tiktok.com",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
  ]) {
    assert.throws(() => validateUrl(bad, isTikTokHost), SafeFetchError, bad);
  }
});

test("CDN allow-list accepts TikTok CDNs only", () => {
  assert.equal(isTikTokCdnHost("p16-sign-sg.tiktokcdn.com"), true);
  assert.equal(isTikTokCdnHost("p19-common-sign.tiktokcdn-us.com"), true);
  assert.equal(isTikTokCdnHost("tiktokcdn.com.evil.example"), false);
  assert.equal(isTikTokCdnHost("eviltiktokcdn.com"), false);
});

test("direct links resolve to a canonical URL without any network call", async () => {
  const cases: Array<[string, string, string]> = [
    ["https://www.tiktok.com/@masen.matcha/video/7312345678901234567?is_from_webapp=1", "7312345678901234567", "https://www.tiktok.com/@masen.matcha/video/7312345678901234567"],
    ["https://m.tiktok.com/v/7312345678901234567.html", "7312345678901234567", "https://www.tiktok.com/@_/video/7312345678901234567"],
    ["Cobain ini! https://www.tiktok.com/@a_b/video/7312345678901234567 #fyp", "7312345678901234567", "https://www.tiktok.com/@a_b/video/7312345678901234567"],
    ["https://www.tiktok.com/@kopi/photo/7312345678901234567", "7312345678901234567", "https://www.tiktok.com/@kopi/photo/7312345678901234567"],
  ];
  for (const [input, id, canonical] of cases) {
    const video = await resolveVideo(input);
    assert.equal(video.videoId, id, input);
    assert.equal(video.canonicalUrl, canonical, input);
    assert.equal(video.hops, 0);
  }
});

test("usernames that could smuggle arguments are dropped from the canonical URL", async () => {
  const video = await resolveVideo("https://www.tiktok.com/@--exec=rm/video/7312345678901234567");
  assert.equal(video.canonicalUrl, "https://www.tiktok.com/@_/video/7312345678901234567");
});

test("non-TikTok and malformed links are rejected as UNSUPPORTED_URL", async () => {
  for (const bad of [
    "https://www.youtube.com/watch?v=abc",
    "https://tiktok.com.evil.example/@a/video/7312345678901234567",
    "https://www.tiktok.com/@a/video/notanumber",
    "https://www.tiktok.com/@a",
    "",
    "x".repeat(3000),
  ]) {
    await assert.rejects(resolveVideo(bad), (error: unknown) => error instanceof TikTokError && error.code === "UNSUPPORTED_URL", bad);
  }
});

test("safeFetch refuses a disallowed host before any request is made", async () => {
  await assert.rejects(
    safeFetch("https://example.com/", { allowHost: isTikTokHost, maxBytes: 1024, timeoutMs: 1000 }),
    (error: unknown) => error instanceof SafeFetchError && error.code === "HOST_NOT_ALLOWED",
  );
});
