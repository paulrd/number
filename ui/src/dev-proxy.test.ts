import { describe, expect, it } from "vitest";
import { extractAuthToken, shellPageUrl } from "../dev-proxy";

// A base58-encoded 32-byte token, the shape the node mints.
const TOKEN = "3ViRVk2ScELVVmk4bjJVWS33dD6SiSmTbSQ1b8yDHVdZ";

describe("dev proxy", () => {
  it("reads the credential out of the shell page's bridge call", () => {
    expect(extractAuthToken(`<script>freenetBridge("${TOKEN}");</script>`)).toBe(
      TOKEN,
    );
    expect(
      extractAuthToken(`freenetBridge( "${TOKEN}" , __freenet_user_token, true);`),
    ).toBe(TOKEN);
  });

  it("does not invent a token when the shell page has none", () => {
    expect(extractAuthToken("<html><body>not a shell</body></html>")).toBeNull();
    expect(extractAuthToken(`freenetBridge("not base58!!");`)).toBeNull();
    expect(extractAuthToken("")).toBeNull();
  });

  it("builds the shell URL from a node origin", () => {
    expect(
      shellPageUrl("http://127.0.0.1:7510", "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k")
        .toString(),
    ).toBe(
      "http://127.0.0.1:7510/v1/contract/web/BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k/",
    );
  });
});
