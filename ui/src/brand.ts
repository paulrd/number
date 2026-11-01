/**
 * The name the interface calls itself.
 *
 * This is display copy only. Repository, crate, WASM and secret-key names stay
 * `number` (`number-contract`, `number-delegate`, `number.v1.seed`, …), because
 * renaming them changes the compiled bytes and so the contract id and delegate
 * key, which would strand every existing board. Keep brand strings here so the
 * next rename is one line.
 */
export const APP_NAME = "Tally";
