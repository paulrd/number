/**
 * Guard for the migration registry, not a test of the UI.
 *
 * `published/manifest.json` records the artifact bytes that are actually
 * deployed. This test keeps that record honest and keeps the registry complete:
 * a WASM change that re-keys a contract or delegate cannot land unless the
 * superseded generation is still listed in `migrations.ts`, where the migration
 * code can find it.
 *
 * It runs in `make check` and in CI's UI job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  LEGACY_CONTRACT_CODE_HASHES,
  LEGACY_DELEGATES,
  UNMIGRATABLE_CONTRACT_CODE_HASHES,
} from "./migrations";

interface DelegateGeneration {
  key: string;
  codeHash: string;
  webappId: string;
}

interface Manifest {
  toolchain: string;
  contract: {
    codeHash: string;
    file: string;
    generations: string[];
  };
  delegate: {
    codeHash: string;
    key: string;
    webappId: string;
    file: string;
    generations: DelegateGeneration[];
  };
}

const root = fileURLToPath(new URL("../..", import.meta.url));

const manifest = JSON.parse(
  readFileSync(`${root}/published/manifest.json`, "utf8"),
) as Manifest;

function decode32(value: string, what: string): Uint8Array {
  const bytes = bs58.decode(value);
  expect(bytes.length, `${what} must be 32 bytes`).toBe(32);
  return bytes;
}

function codeHashOf(file: string): string {
  return bs58.encode(blake3(readFileSync(`${root}/${file}`)));
}

/** Delegate key = BLAKE3(code_hash || parameters), as the node computes it. */
function delegateKeyOf(codeHash: string, webappId: string): string {
  return bs58.encode(
    blake3(
      new Uint8Array([
        ...decode32(codeHash, "delegate code hash"),
        ...decode32(webappId, "delegate webapp id"),
      ]),
    ),
  );
}

describe("migration registry", () => {
  it("holds only well-formed, unique entries", () => {
    for (const hash of LEGACY_CONTRACT_CODE_HASHES) {
      decode32(hash, "legacy contract code hash");
    }
    for (const hash of UNMIGRATABLE_CONTRACT_CODE_HASHES) {
      decode32(hash, "unmigratable contract code hash");
    }
    const contractHashes = [
      ...LEGACY_CONTRACT_CODE_HASHES,
      ...UNMIGRATABLE_CONTRACT_CODE_HASHES,
    ];
    expect(new Set(contractHashes).size).toBe(contractHashes.length);

    for (const entry of LEGACY_DELEGATES) {
      decode32(entry.key, "legacy delegate key");
      decode32(entry.codeHash, "legacy delegate code hash");
      decode32(entry.webappId, "legacy delegate webapp id");
      expect(entry.key, "delegate key must derive from code hash + webapp id").toBe(
        delegateKeyOf(entry.codeHash, entry.webappId),
      );
    }
    expect(new Set(LEGACY_DELEGATES.map((e) => e.key)).size).toBe(
      LEGACY_DELEGATES.length,
    );
  });

  it("matches the committed artifact bytes", () => {
    expect(codeHashOf(manifest.contract.file)).toBe(manifest.contract.codeHash);
    expect(codeHashOf(manifest.delegate.file)).toBe(manifest.delegate.codeHash);
    expect(
      delegateKeyOf(manifest.delegate.codeHash, manifest.delegate.webappId),
    ).toBe(manifest.delegate.key);
  });

  it("records the active generation first and every generation exactly once", () => {
    expect(manifest.contract.generations[0]).toBe(manifest.contract.codeHash);
    expect(manifest.delegate.generations[0].key).toBe(manifest.delegate.key);
    expect(new Set(manifest.contract.generations).size).toBe(
      manifest.contract.generations.length,
    );
    expect(new Set(manifest.delegate.generations.map((g) => g.key)).size).toBe(
      manifest.delegate.generations.length,
    );
    for (const generation of manifest.delegate.generations) {
      expect(
        generation.key,
        "historical delegate entry must derive from its own code hash + webapp id",
      ).toBe(delegateKeyOf(generation.codeHash, generation.webappId));
    }
  });

  it("treats v2 as migratable and v1 as unmigratable", () => {
    // v3 keeps the v2 slot/contacts signing bytes; the client only adds an
    // empty parent. v1 changed the slot schema and cannot be re-PUT.
    expect(LEGACY_CONTRACT_CODE_HASHES).toContain(
      "A1J4T4sJ4xwRtbbu8QpXhCSyMHrW1uMp2H4H5BfBdiur",
    );
    for (const v1 of [
      "6DJM6gSdfUdHe4ec4mwvAvQHLx9Jonkq8deEoWZ1jfmX",
      "3f15GMxe5Bf8hkdDLGaX2ZNuyyjcQv7FL7i5wayfR6Kd",
      "7aK2LcB5Uy8V8AYJYF7entSPk4noEcnYaa72EWpJG1ez",
    ]) {
      expect(UNMIGRATABLE_CONTRACT_CODE_HASHES).toContain(v1);
      expect(LEGACY_CONTRACT_CODE_HASHES).not.toContain(v1);
    }
  });

  it("keeps every superseded generation registered", () => {
    const registeredContracts = [
      ...LEGACY_CONTRACT_CODE_HASHES,
      ...UNMIGRATABLE_CONTRACT_CODE_HASHES,
    ];
    for (const hash of manifest.contract.generations.slice(1)) {
      expect(
        registeredContracts,
        `superseded contract ${hash} is missing from the contract registries`,
      ).toContain(hash);
    }

    for (const generation of manifest.delegate.generations.slice(1)) {
      const registered = LEGACY_DELEGATES.some(
        (entry) =>
          entry.key === generation.key &&
          entry.codeHash === generation.codeHash &&
          entry.webappId === generation.webappId,
      );
      expect(
        registered,
        `superseded delegate ${generation.key} is missing from LEGACY_DELEGATES`,
      ).toBe(true);
    }
  });

  it("was recorded with the committed toolchain pin", () => {
    const pinned = readFileSync(`${root}/rust-toolchain.toml`, "utf8").match(
      /^channel = "(.+)"$/m,
    )?.[1];
    expect(pinned).toBeTruthy();
    expect(manifest.toolchain).toBe(pinned);
  });

  it("was recorded against the webapp id the build pins the delegate to", () => {
    const pinned = readFileSync(
      `${root}/delegate/webapp_contract_id.txt`,
      "utf8",
    ).trim();
    expect(pinned).not.toBe("");
    expect(manifest.delegate.webappId).toBe(pinned);
  });
});
