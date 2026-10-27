/**
 * Dev-server bridge to a local Freenet node.
 *
 * In production the gateway serves the webapp same-origin and mints a per-app
 * auth token for the shell, which is what binds `MessageOrigin::WebApp` on the
 * node's WebSocket. Vite's dev server supplies neither, so without this module
 * `npm run dev` talks to itself on :8080 and every request 404s.
 *
 * What this does:
 *   - proxies `/v1` (HTTP and WebSocket) to the node, preserving the query
 *     string the client builds;
 *   - mints a token the same way the browser shell does: load the webapp's
 *     shell page and read the credential the node binds to that contract
 *     instance. `FREENET_AUTH_TOKEN` overrides the minting.
 *
 * The token is presented as a Bearer header on the upgrade, which the node
 * accepts as equivalent to the `authToken` query parameter (see
 * `connection_info` in freenet-core). Tokens are in-memory on the node, so
 * restarting the node invalidates them — restart the dev server to re-mint.
 *
 * This file is Node-only tooling loaded by `vite.config.ts`; it is never part
 * of the browser bundle.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_NODE_URL = "http://127.0.0.1:7510";
export const DEFAULT_MINT_TIMEOUT_MS = 10_000;

/**
 * The shell page passes its credential to the bridge as
 * `freenetBridge("<token>")`. The token is base58 (alphanumeric only), which is
 * why it needs no escaping in that call.
 */
const TOKEN_PATTERN = /freenetBridge\(\s*"([1-9A-HJ-NP-Za-km-z]+)"/;

export function extractAuthToken(html: string): string | null {
  return html.match(TOKEN_PATTERN)?.[1] ?? null;
}

export function shellPageUrl(nodeUrl: string, webappId: string): URL {
  return new URL(`/v1/contract/web/${webappId}/`, nodeUrl);
}

/** The webapp whose origin the delegate is pinned to (`MessageOrigin::WebApp`). */
export function readWebappId(repoRoot: string): string {
  const id = readFileSync(
    resolve(repoRoot, "delegate/webapp_contract_id.txt"),
    "utf8",
  ).trim();
  if (!id) throw new Error("delegate/webapp_contract_id.txt is empty");
  return id;
}

/**
 * Ask the node for the webapp's shell page. Serving that page generates a fresh
 * token and binds it to the contract instance, so presenting it later attests
 * this connection as that webapp — exactly what the delegate requires.
 */
export async function mintDevAuthToken(
  nodeUrl: string,
  webappId: string,
  timeoutMs: number = DEFAULT_MINT_TIMEOUT_MS,
): Promise<string> {
  const url = shellPageUrl(nodeUrl, webappId);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  const token = extractAuthToken(await response.text());
  if (!token) throw new Error("the shell page carried no auth token");
  return token;
}
