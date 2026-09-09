import { readGatewaySecret } from "./secret-store.js";

export type TokenKind = "oauth" | "pat" | "plan";

export interface GlobalOptions {
  profile?: string;
  port?: string;
  tokenKind?: string;
  tokenService?: string;
  secretService?: string;
}

export interface CliProfile {
  name: string;
  port: number;
  tokenKind: TokenKind;
  tokenService: string;
  secretService: string;
  secret: string;
  app: string;
}

export function resolveProfile(options: GlobalOptions = {}): CliProfile {
  const name = options.profile || process.env.FIGMA_VARIANT || "local";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid profile: ${name}`);
  const port = Number(
    options.port || process.env.FIGMA_GATEWAY_PORT || process.env.FIGMA_BRIDGE_PORT ||
    process.env.FIGMA_VARIANT_BRIDGE_PORT || "1995",
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  const tokenKind = (options.tokenKind || process.env.FIGMA_TOKEN_KIND || "pat") as TokenKind;
  if (!(["oauth", "pat", "plan"] as string[]).includes(tokenKind)) {
    throw new Error(`Invalid token kind: ${tokenKind}`);
  }
  const tokenService = options.tokenService || process.env.FIGMA_TOKEN_KEYCHAIN_ITEM ||
    `figma_token_${name}_${tokenKind}`;
  const explicitSecretService = options.secretService || process.env.FIGMA_GATEWAY_SECRET_KEYCHAIN_ITEM;
  const secretServices = explicitSecretService
    ? [explicitSecretService]
    : ["figma_gateway", `figma_gateway_${name}`];
  let secretService = secretServices[0]!;
  let secret = process.env.FIGMA_GATEWAY_SECRET || "";
  if (!secret) {
    for (const candidate of secretServices) {
      secret = readGatewaySecret(candidate);
      if (secret) {
        secretService = candidate;
        break;
      }
    }
  }
  return {
    name,
    port,
    tokenKind,
    tokenService,
    secretService,
    secret,
    app: "/Applications/Figma.app",
  };
}

export function applyRestProfile(profile: CliProfile): void {
  process.env.FIGMA_TOKEN_KIND = profile.tokenKind;
  process.env.FIGMA_TOKEN_KEYCHAIN_ITEM = profile.tokenService;
}

export function requireSecret(profile: CliProfile): string {
  if (!profile.secret) {
    throw new Error(
      "Shared gateway secret is not configured. Run: figma-gateway setup",
    );
  }
  return profile.secret;
}
