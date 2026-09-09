import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { figmaRestRequest, refreshOAuth, resolveToken } from "../src/server/rest.js";

test("REST client uses OAuth bearer auth and preserves repeated query values", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const originalKind = process.env.FIGMA_TOKEN_KIND;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    if (originalKind === undefined) delete process.env.FIGMA_TOKEN_KIND;
    else process.env.FIGMA_TOKEN_KIND = originalKind;
  });
  process.env.FIGMA_ACCESS_TOKEN = "oauth-token";
  process.env.FIGMA_TOKEN_KIND = "oauth";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.figma.com");
    assert.deepEqual(url.searchParams.getAll("ids"), ["1:2", "3:4"]);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer oauth-token");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "x-figma-plan-tier": "professional" },
    });
  };
  const result = await figmaRestRequest({
    path: "/v1/files/key/nodes",
    query: { ids: ["1:2", "3:4"] },
  }) as { data: { ok: boolean }; headers: Record<string, string> };
  assert.equal(result.data.ok, true);
  assert.equal(result.headers["x-figma-plan-tier"], "professional");
});

test("REST writes require explicit confirmation", async () => {
  await assert.rejects(
    figmaRestRequest({ method: "POST", path: "/v1/files/key/comments", body: { message: "x" } }),
    /confirm: true/,
  );
});

test("REST client uses X-Figma-Token for PAT and Plan tokens", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const originalKind = process.env.FIGMA_TOKEN_KIND;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    if (originalKind === undefined) delete process.env.FIGMA_TOKEN_KIND;
    else process.env.FIGMA_TOKEN_KIND = originalKind;
  });
  process.env.FIGMA_ACCESS_TOKEN = "plan-token";
  process.env.FIGMA_TOKEN_KIND = "plan";
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)["x-figma-token"], "plan-token");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await figmaRestRequest({ path: "/v1/ai_usage/daily" });
});

test("OAuth refresh uses the current token endpoint and refresh grant", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let persisted: unknown;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.figma.com/v1/oauth/token");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    const body = new URLSearchParams(String(init?.body));
    assert.deepEqual([...body.entries()], [
      ["grant_type", "refresh_token"],
      ["refresh_token", "refresh-token"],
    ]);
    return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const updated = await refreshOAuth("figma-test", {
    kind: "oauth",
    accessToken: "old-access",
    refreshToken: "refresh-token",
    clientId: "client-id",
    clientSecret: "client-secret",
  }, (_service, credential) => { persisted = credential; });
  assert.equal(updated.accessToken, "new-access");
  assert.deepEqual(persisted, updated);
});

test("REST saveTo rejects a symlink that escapes caller cwd", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const originalKind = process.env.FIGMA_TOKEN_KIND;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    if (originalKind === undefined) delete process.env.FIGMA_TOKEN_KIND;
    else process.env.FIGMA_TOKEN_KIND = originalKind;
  });
  process.env.FIGMA_ACCESS_TOKEN = "oauth-token";
  process.env.FIGMA_TOKEN_KIND = "oauth";
  globalThis.fetch = async () => new Response("response", { status: 200 });
  const cwd = await mkdtemp(path.join(tmpdir(), "figma-rest-cwd-"));
  const outside = await mkdtemp(path.join(tmpdir(), "figma-rest-outside-"));
  await symlink(outside, path.join(cwd, "escape"), "dir");

  await assert.rejects(
    figmaRestRequest({ path: "/v1/me", saveTo: "escape/response.txt" }, cwd),
    /symbolic link/,
  );
  await assert.rejects(readFile(path.join(outside, "response.txt")));
});

test("normal common.sh settings fall back to the legacy PAT Keychain item", async (context) => {
  const original = Object.fromEntries([
    "PATH", "FIGMA_ACCESS_TOKEN", "FIGMA_TOKEN_KIND", "FIGMA_TOKEN_KEYCHAIN_ITEM", "FIGMA_PAT_KEYCHAIN_ITEM",
  ].map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const root = await mkdtemp(path.join(tmpdir(), "figma-security-stub-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const security = path.join(bin, "security");
  await writeFile(security, "#!/bin/sh\ncase \"$*\" in *figma_pat_legacy*) printf legacy-pat-token;; *) exit 44;; esac\n");
  await chmod(security, 0o700);
  process.env.PATH = `${bin}:${original.PATH || ""}`;
  delete process.env.FIGMA_ACCESS_TOKEN;
  process.env.FIGMA_TOKEN_KIND = "oauth";
  process.env.FIGMA_TOKEN_KEYCHAIN_ITEM = "figma_token_legacy_oauth";
  process.env.FIGMA_PAT_KEYCHAIN_ITEM = "figma_pat_legacy";

  assert.deepEqual(await resolveToken(), {
    token: "legacy-pat-token",
    kind: "pat",
    source: "keychain:figma_pat_legacy",
  });
});
