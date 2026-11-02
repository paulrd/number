import { describe, expect, it } from "vitest";
import {
  MAX_CONTACT_ADDRESS,
  MAX_CONTACT_LABEL_BYTES,
  MAX_CONTACTS,
  contactAddressValueProblem,
  contactLabelProblem,
  contactListProblem,
  contactRecordProblem,
  normalizeContactList,
  normalizeContactRecord,
} from "./contact-rules";

const userId = (n: number): string => n.toString(16).padStart(64, "0");

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { label: "Alice", userId: userId(1), address: "03", ...overrides };
}

function records(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `c${index}`,
    userId: userId(index),
    address: null,
  }));
}

describe("contact rules constants", () => {
  it("matches the delegate bounds", () => {
    expect(MAX_CONTACT_LABEL_BYTES).toBe(64);
    expect(MAX_CONTACTS).toBe(64);
    expect(MAX_CONTACT_ADDRESS).toBe(32);
  });
});

describe("contactLabelProblem", () => {
  it("accepts a non-empty label of at most 64 UTF-8 bytes", () => {
    expect(contactLabelProblem("Alice", "contacts[0].label")).toBeNull();
    expect(contactLabelProblem("a".repeat(64), "label")).toBeNull();
    expect(contactLabelProblem("é".repeat(32), "label")).toBeNull();
  });

  it("rejects a missing or non-string label", () => {
    expect(contactLabelProblem(undefined, "contacts[0].label")).toBe(
      "contacts[0].label must be a string.",
    );
    expect(contactLabelProblem(null, "label")).toBe("label must be a string.");
    expect(contactLabelProblem(42, "label")).toBe("label must be a string.");
  });

  it("rejects an empty label", () => {
    expect(contactLabelProblem("", "contacts[0].label")).toBe(
      "contacts[0].label must not be empty.",
    );
  });

  it("counts UTF-8 bytes for the 65-byte boundary", () => {
    expect(contactLabelProblem("a".repeat(65), "label")).toBe(
      "label is 65 bytes; maximum is 64.",
    );
    // 32 two-byte characters plus one ASCII byte is exactly 65 bytes.
    expect(contactLabelProblem("é".repeat(32) + "a", "label")).toBe(
      "label is 65 bytes; maximum is 64.",
    );
  });
});

describe("contactAddressValueProblem", () => {
  it("accepts an absent or octal address", () => {
    expect(contactAddressValueProblem(undefined, "address")).toBeNull();
    expect(contactAddressValueProblem(null, "address")).toBeNull();
    expect(contactAddressValueProblem("", "address")).toBeNull();
    expect(contactAddressValueProblem("03", "address")).toBeNull();
    expect(contactAddressValueProblem("0".repeat(MAX_CONTACT_ADDRESS), "address")).toBeNull();
  });

  it("rejects non-octal text and overlong addresses", () => {
    expect(contactAddressValueProblem("12a", "contacts[0].address")).toBe(
      "contacts[0].address must be null or an octal address of at most 32 digits 0..7.",
    );
    expect(contactAddressValueProblem("8", "address")).toContain("0..7");
    expect(contactAddressValueProblem("0".repeat(MAX_CONTACT_ADDRESS + 1), "address")).toBe(
      "address must be null or an octal address of at most 32 digits 0..7.",
    );
    expect(contactAddressValueProblem(3, "address")).toContain("0..7");
  });
});

describe("contactRecordProblem", () => {
  it("accepts a valid record, with or without an address", () => {
    expect(contactRecordProblem(record(), "contacts[0]")).toBeNull();
    const addressless = record();
    delete addressless.address;
    expect(contactRecordProblem(addressless, "contacts[0]")).toBeNull();
  });

  it("rejects a non-object record", () => {
    expect(contactRecordProblem(null, "contacts[0]")).toBe(
      "contacts[0] must be an object.",
    );
    expect(contactRecordProblem([], "contacts[0]")).toBe(
      "contacts[0] must be an object.",
    );
  });

  it("rejects a bad userId", () => {
    expect(contactRecordProblem(record({ userId: "abc" }), "contacts[0]")).toBe(
      "contacts[0].userId must be 64 lowercase hex characters.",
    );
    expect(
      contactRecordProblem(record({ userId: "A".repeat(64) }), "contacts[0]"),
    ).toBe("contacts[0].userId must be 64 lowercase hex characters.");
  });

  it("rejects a bad label or address", () => {
    expect(contactRecordProblem(record({ label: "" }), "contacts[0]")).toBe(
      "contacts[0].label must not be empty.",
    );
    expect(contactRecordProblem(record({ address: "xyz" }), "contacts[0]")).toBe(
      "contacts[0].address must be null or an octal address of at most 32 digits 0..7.",
    );
  });
});

describe("contactListProblem", () => {
  it("accepts up to 64 contacts", () => {
    expect(contactListProblem([], "contacts")).toBeNull();
    expect(contactListProblem(records(MAX_CONTACTS), "contacts")).toBeNull();
  });

  it("rejects more than 64 contacts", () => {
    expect(contactListProblem(records(MAX_CONTACTS + 1), "contacts")).toBe(
      "contacts are limited to 64 entries (65 given).",
    );
  });

  it("rejects a non-array", () => {
    expect(contactListProblem(null, "contacts")).toBe(
      "contacts must be an array.",
    );
  });

  it("rejects duplicate userIds and labels", () => {
    expect(
      contactListProblem(
        [
          record({ label: "Alice", userId: userId(1) }),
          record({ label: "Bob", userId: userId(1) }),
        ],
        "contacts",
      ),
    ).toBe("contacts[1] duplicates a userId.");

    expect(
      contactListProblem(
        [
          record({ label: "Alice", userId: userId(1) }),
          record({ label: "Alice", userId: userId(2) }),
        ],
        "contacts",
      ),
    ).toBe("contacts[1] duplicates a label.");
  });

  it("reports the first bad record with its path", () => {
    expect(
      contactListProblem(
        [record(), record({ userId: "not-hex" })],
        "contacts",
      ),
    ).toBe("contacts[1].userId must be 64 lowercase hex characters.");
  });
});

describe("normalization", () => {
  it("defaults a missing address to null on one record", () => {
    expect(
      normalizeContactRecord({ label: "Alice", userId: userId(1) }),
    ).toEqual({ label: "Alice", userId: userId(1), address: null });
    expect(normalizeContactRecord(record({ address: undefined }))).toEqual({
      label: "Alice",
      userId: userId(1),
      address: null,
    });
  });

  it("defaults missing addresses to null across a list", () => {
    expect(
      normalizeContactList([
        { label: "Alice", userId: userId(1) },
        record({ label: "Bob", userId: userId(2), address: "0" }),
      ]),
    ).toEqual([
      { label: "Alice", userId: userId(1), address: null },
      { label: "Bob", userId: userId(2), address: "0" },
    ]);
  });
});
