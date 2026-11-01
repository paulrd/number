import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Copy rules for the two-surface shell. The source of truth is the shipped
 * document, so a stray "slot" in the default view or a banned branding phrase
 * fails here before it reaches a browser.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

function section(source: string, id: string): string {
  const marker = `id="${id}"`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`missing #${id}`);
  const open = source.lastIndexOf("<section", start);
  const close = source.indexOf("</section>", start);
  return source.slice(open, close);
}

const simple = section(html, "simple-view");
const advancedStart = html.indexOf('id="advanced-view"');
const advancedEnd = html.indexOf("</main>", advancedStart);
const advanced = html.slice(advancedStart, advancedEnd);
const outsideAdvanced = html.slice(0, advancedStart) + html.slice(advancedEnd);

describe("default view copy", () => {
  it("contains no slot wording at all", () => {
    expect(simple.toLowerCase()).not.toContain("slot");
  });

  it("keeps the three action labels and the record card seams", () => {
    expect(simple).toContain("Send payment");
    expect(simple).toContain("Address book");
    expect(simple).toContain("Copy receive-payment link");
    expect(simple).toContain("Held by your parent");
  });
});

describe("branding copy", () => {
  it("uses the new tagline and drops the old wordmark tag", () => {
    expect(html).toContain("One owner. One board. Every change signed.");
    expect(html).not.toContain("wordmark-tag");
    expect(html).not.toContain("Eight slots");
  });

  it("does not describe the product as eight slots", () => {
    expect(outsideAdvanced).not.toMatch(/8 slots/i);
    expect(outsideAdvanced).not.toMatch(/eight slots/i);
    const meta = html.match(/<meta\s+name="description"\s+content="([^"]*)"/s);
    expect(meta?.[1] ?? "").not.toMatch(/slot/i);
  });

  it("states the capacity limit once, inside Advanced", () => {
    expect(advanced).toContain("Child slots");
    expect(advanced.match(/of 8\)/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(outsideAdvanced).not.toContain("of 8)");
  });
});
