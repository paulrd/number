/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import type { ProxyOptions } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NODE_URL,
  mintDevAuthToken,
  readWebappId,
} from "./dev-proxy";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Dev only: proxy the node's `/v1` surface and attest the connection as the
 * pinned webapp, so `npm run dev` can reach a local node. In production the
 * gateway shell does both jobs; see `dev-proxy.ts`.
 *
 * Disabled for builds, `vite preview`, unit tests and offline mode, so none of
 * those require a running node.
 */
async function devProxy(
  command: "build" | "serve",
  isPreview: boolean,
): Promise<Record<string, ProxyOptions> | undefined> {
  const isTest =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (
    command !== "serve" ||
    isPreview ||
    isTest ||
    process.env.VITE_OFFLINE_MODE === "1"
  ) {
    return undefined;
  }

  const nodeUrl = (
    process.env.FREENET_NODE_URL?.trim() || DEFAULT_NODE_URL
  ).replace(/\/+$/, "");

  let token = process.env.FREENET_AUTH_TOKEN?.trim() ?? "";
  if (!token) {
    try {
      const webappId =
        process.env.FREENET_WEBAPP_ID?.trim() || readWebappId(resolve(rootDir, ".."));
      token = await mintDevAuthToken(nodeUrl, webappId);
      console.log(`[dev] minted a node auth token for webapp ${webappId}`);
    } catch (error) {
      // Contract reads still work unauthenticated; delegate calls do not,
      // because the delegate accepts only MessageOrigin::WebApp(id).
      console.warn(`[dev] could not mint a node auth token: ${String(error)}`);
      console.warn(
        `[dev] publish the site to ${nodeUrl}, or set FREENET_AUTH_TOKEN. ` +
          "Until then contract reads work and delegate actions fail.",
      );
    }
  }

  const authorization = token ? { authorization: `Bearer ${token}` } : undefined;
  return {
    "/v1": {
      target: nodeUrl,
      ws: true,
      changeOrigin: true,
      ...(authorization ? { headers: authorization } : {}),
      // http-proxy applies `headers` to ordinary requests; set it on the
      // WebSocket upgrade explicitly too, which is the one this app uses.
      configure: (proxy) => {
        if (!authorization) return;
        proxy.on("proxyReqWs", (proxyRequest) => {
          proxyRequest.setHeader("authorization", authorization.authorization);
        });
      },
    },
  };
}

/**
 * Build-time constants are written next to this config by `scripts/build-ui`
 * (see public/README.md). A missing file is not a build error: the app renders
 * a clear "build configuration missing" state instead of failing at runtime
 * with an opaque flatbuffer error.
 */
function readFileOrDefault(filename: string, fallback: string): string {
  const filePath = resolve(rootDir, filename);
  if (!existsSync(filePath)) return fallback;
  return readFileSync(filePath, "utf-8").trim() || fallback;
}

function readJsonArrayOrDefault(filename: string, envValue?: string): string {
  const raw = envValue?.trim() || readFileOrDefault(filename, "[]");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (n) =>
          typeof n !== "number" ||
          !Number.isInteger(n) ||
          n < 0 ||
          n > 255,
      )
    ) {
      throw new Error("expected a JSON array of byte values (0..255)");
    }
    return JSON.stringify(parsed);
  } catch (error) {
    // Fail the build rather than injecting a syntactically invalid constant.
    throw new Error(`invalid ${filename}: ${String(error)}`);
  }
}

const contractCodeHash =
  process.env.CONTRACT_CODE_HASH?.trim() ||
  readFileOrDefault("contract_code_hash.txt", "");
const delegateKeyBytes = readJsonArrayOrDefault(
  "delegate_key_bytes.json",
  process.env.DELEGATE_KEY_BYTES,
);
const delegateCodeHashBytes = readJsonArrayOrDefault(
  "delegate_code_hash_bytes.json",
  process.env.DELEGATE_CODE_HASH_BYTES,
);
const webappContractIdBytes = readJsonArrayOrDefault(
  "webapp_contract_id_bytes.json",
  process.env.WEBAPP_CONTRACT_ID_BYTES,
);

export default defineConfig(async ({ command, isPreview }) => {
  const proxy = await devProxy(command, isPreview === true);
  return {
    // Relative assets: Freenet serves webapps from a nested sandboxed-iframe path.
    base: "./",
    define: {
      __CONTRACT_CODE_HASH__: JSON.stringify(contractCodeHash),
      __DELEGATE_KEY_BYTES__: delegateKeyBytes,
      __DELEGATE_CODE_HASH_BYTES__: delegateCodeHashBytes,
      __WEBAPP_CONTRACT_ID_BYTES__: webappContractIdBytes,
      __CONTRACT_WASM_URL__: JSON.stringify(
        process.env.CONTRACT_WASM_URL?.trim() || "./number_contract.wasm",
      ),
      __DELEGATE_WASM_URL__: JSON.stringify(
        process.env.DELEGATE_WASM_URL?.trim() || "./number_delegate.wasm",
      ),
      __OFFLINE_MODE__: JSON.stringify(process.env.VITE_OFFLINE_MODE === "1"),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
    },
    server: {
      port: 8080,
      ...(proxy ? { proxy } : {}),
    },
    test: {
      environment: "node",
      include: ["src/**/*.{test,spec}.ts"],
      passWithNoTests: false,
    },
  };
});
