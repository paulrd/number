import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Copy rules for the two-surface shell. The source of truth is the shipped
 * document, so a banned phrase in the default view fails here before it
 * reaches a browser.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf-8");

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
  it("keeps the three action labels and the neutral record seams", () => {
    expect(simple).toContain("Send payment");
    expect(simple).toContain("Address book");
    expect(simple).toContain("Copy receive-payment link");
    expect(simple).toContain(">Balance</p>");
    expect(simple).not.toContain("You can't change it here.");
    expect(simple).toContain(">Your zone</h2>");
    expect(simple).toContain("simple-address");
    expect(simple).not.toContain("Your Board Name");
    expect(simple).not.toContain("Held by your parent");
  });

  it("mentions a parent only when the link is missing", () => {
    expect(simple).toMatch(/id="simple-parent"[\s\S]*?hidden/);
    expect(simple).toContain("Add a parent");
  });

  it("keeps the compact child list hidden until a mutual child exists", () => {
    expect(simple).toMatch(/id="simple-children"[\s\S]*?hidden/);
    expect(simple).toContain("simple-children-list");
  });

  it("shows the owner's id readout with a copy control", () => {
    expect(simple).toContain('id="simple-owner-id"');
    expect(simple).toContain('id="simple-owner-copy"');
    expect(simple).toContain('id="simple-owner-status"');
    expect(simple).toContain("Your id");
    expect(simple).toContain("Copy your user id");
    // The default surface still never uses the word "slot".
    expect(simple).not.toMatch(/slot/i);
  });
});

describe("advanced child slot ids", () => {
  it("paints a shortened child id with the full key in the title", () => {
    expect(mainSource).toContain('"slot-id"');
    expect(mainSource).toContain("shorten(entry.contact)");
    expect(mainSource).toContain("slotView.id.title = entry ? entry.contact");
  });
});

describe("branding copy", () => {
  it("drops the old header eyebrow and tagline", () => {
    expect(html).not.toContain("Personal Freenet board");
    expect(html).not.toContain("One owner. One board. Every change signed.");
    expect(html).not.toContain("wordmark-tag");
    expect(html).not.toContain("Eight slots");
  });

  it("calls the product a zone, not a board", () => {
    expect(html).not.toMatch(/Your board\b/);
    expect(html).not.toMatch(/board name/i);
    expect(html).not.toMatch(/Child board|Parent board|A personal board/i);
    expect(html).not.toMatch(/board tree/i);
    expect(html).toContain("A personal zone");
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
