import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { safeOutputPath } from "./safe-path.js";

export type TokenKind = "oauth" | "pat" | "plan";
export type QueryValue = string | number | boolean | Array<string | number | boolean> | null | undefined;

export interface RestRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  confirm?: boolean;
  saveTo?: string;
}

export interface StoredCredential {
  kind: TokenKind;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
}

function keychainToken(service: string): string {
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function saveKeychainCredential(service: string, credential: StoredCredential): void {
  execFileSync("security", [
    "add-generic-password", "-U", "-a", userInfo().username,
    "-s", service, "-w", JSON.stringify(credential),
  ], { stdio: "ignore" });
}

function parseCredential(raw: string, fallbackKind: TokenKind): StoredCredential {
  if (!raw.trim().startsWith("{")) return { kind: fallbackKind, accessToken: raw };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Stored Figma credential is not valid JSON"); }
  const record = value as Partial<StoredCredential>;
  const kind = record.kind || fallbackKind;
  if (!(["oauth", "pat", "plan"] as string[]).includes(kind) || !record.accessToken) {
    throw new Error("Stored Figma credential is missing kind or accessToken");
  }
  return { ...record, kind, accessToken: record.accessToken };
}

function expiring(credential: StoredCredential): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60_000;
}

export async function refreshOAuth(
  service: string,
  credential: StoredCredential,
  persist: (service: string, credential: StoredCredential) => void = saveKeychainCredential,
): Promise<StoredCredential> {
  if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) {
    throw new Error("Stored OAuth token is expiring and has no refreshToken/client credentials");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
  });
  const basic = Buffer.from(`${credential.clientId}:${credential.clientSecret}`).toString("base64");
  const response = await fetch("https://api.figma.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form,
  });
  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Figma OAuth refresh failed: ${response.status} ${data.message || response.statusText}`);
  }
  const updated: StoredCredential = {
    ...credential,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credential.refreshToken,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
  };
  persist(service, updated);
  return updated;
}

export async function resolveToken(): Promise<{ token: string; kind: TokenKind; source: string }> {
  const inferred = process.env.FIGMA_PAT_KEYCHAIN_ITEM && !process.env.FIGMA_TOKEN_KEYCHAIN_ITEM
    ? "pat"
    : "oauth";
  const kind = (process.env.FIGMA_TOKEN_KIND || inferred) as TokenKind;
  if (!(["oauth", "pat", "plan"] as string[]).includes(kind)) {
    throw new Error(`FIGMA_TOKEN_KIND must be oauth, pat, or plan: ${kind}`);
  }
  const direct = process.env.FIGMA_ACCESS_TOKEN || "";
  if (direct) return { token: direct, kind, source: "environment" };
  for (const { service, fallbackKind } of keychainCandidates(kind)) {
    const raw = keychainToken(service);
    if (raw) {
      let credential = parseCredential(raw, fallbackKind);
      if (credential.kind === "oauth" && expiring(credential)) {
        credential = await refreshOAuth(service, credential);
      }
      return { token: credential.accessToken, kind: credential.kind, source: `keychain:${service}` };
    }
  }
  throw new Error(
    "Figma REST token is not configured. Set FIGMA_ACCESS_TOKEN, or FIGMA_TOKEN_KEYCHAIN_ITEM and FIGMA_TOKEN_KIND.",
  );
}

function keychainCandidates(kind: TokenKind): Array<{ service: string; fallbackKind: TokenKind }> {
  const candidates: Array<{ service: string; fallbackKind: TokenKind }> = [];
  const primary = process.env.FIGMA_TOKEN_KEYCHAIN_ITEM || "";
  if (primary) candidates.push({ service: primary, fallbackKind: kind });
  const legacyPat = process.env.FIGMA_PAT_KEYCHAIN_ITEM || "";
  if (legacyPat && legacyPat !== primary && kind !== "plan") {
    candidates.push({ service: legacyPat, fallbackKind: "pat" });
  }
  return candidates;
}

export async function credentialStatus(): Promise<Record<string, unknown>> {
  const inferred = process.env.FIGMA_PAT_KEYCHAIN_ITEM && !process.env.FIGMA_TOKEN_KEYCHAIN_ITEM ? "pat" : "oauth";
  const kind = (process.env.FIGMA_TOKEN_KIND || inferred) as TokenKind;
  if (process.env.FIGMA_ACCESS_TOKEN) return { configured: true, kind, source: "environment" };
  const candidates = keychainCandidates(kind);
  for (const { service, fallbackKind } of candidates) {
    const raw = keychainToken(service);
    if (!raw) continue;
    const credential = parseCredential(raw, fallbackKind);
    return {
      configured: true,
      kind: credential.kind,
      source: `keychain:${service}`,
      expiresAt: credential.expiresAt || null,
      refreshable: Boolean(credential.refreshToken && credential.clientId && credential.clientSecret),
    };
  }
  return {
    configured: false,
    kind,
    source: candidates[0] ? `keychain:${candidates[0].service}` : "none",
  };
}

function responseHeaders(headers: Headers): Record<string, string> {
  const names = [
    "content-type",
    "etag",
    "retry-after",
    "x-figma-plan-tier",
    "x-figma-rate-limit-type",
    "x-figma-upgrade-link",
  ];
  return Object.fromEntries(names.flatMap((name) => {
    const value = headers.get(name);
    return value ? [[name, value]] : [];
  }));
}

export async function figmaRestRequest(request: RestRequest, cwd = process.cwd()): Promise<unknown> {
  const method = request.method || "GET";
  if (method !== "GET" && request.confirm !== true) {
    throw new Error(`${method} requires confirm: true because it may change Figma data`);
  }
  if (!/^\/v[12]\/[A-Za-z0-9_./{}:-]+$/.test(request.path) || request.path.includes("..")) {
    throw new Error(`path must be an absolute Figma REST v1/v2 path: ${request.path}`);
  }
  const url = new URL(request.path, "https://api.figma.com");
  for (const [name, value] of Object.entries(request.query || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(name, String(item)));
    else url.searchParams.set(name, String(value));
  }
  const credential = await resolveToken();
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential.kind === "oauth") headers.authorization = `Bearer ${credential.token}`;
  else headers["x-figma-token"] = credential.token;
  let body: string | undefined;
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.body);
  }
  const response = await fetch(url, { method, headers, body });
  const raw = Buffer.from(await response.arrayBuffer());
  const metadata = {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
    authKind: credential.kind,
    authSource: credential.source,
  };
  if (request.saveTo) {
    const target = await safeOutputPath(cwd, request.saveTo, "saveTo");
    await writeFile(target, raw);
    if (!response.ok) throw new Error(`Figma REST ${response.status} ${response.statusText}; response saved to ${request.saveTo}`);
    return { ...metadata, savedTo: request.saveTo, bytesWritten: raw.byteLength };
  }
  const contentType = response.headers.get("content-type") || "";
  let data: unknown = raw.toString("utf8");
  if (contentType.includes("json")) {
    try { data = JSON.parse(raw.toString("utf8")); } catch { /* preserve invalid JSON as text */ }
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Figma REST ${response.status} ${response.statusText}: ${detail.slice(0, 4000)}`);
  }
  return { ...metadata, data };
}
