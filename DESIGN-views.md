# View spec — leaf-first default view and the advanced page

Status: pass 2 implementation spec. Supersedes the earlier design memo where
they disagree. Data layer is v6/v9 (see `DESIGN-v6.md`); this pass changes only
`ui/` presentation and flow.

## Information architecture

One document, two surfaces:

```
header   wordmark + tagline + [Advanced]  (or [Back to the simple view])
notice   unchanged (failures only)
warnings unchanged (only when non-empty)
main
  section#simple-view      the default: five things, nothing else
  section#advanced-view    hidden; everything else
footer   unchanged
...existing dialogs, unchanged position
```

- The toggle switches paint, never remounts: one `OnlineBoard`, one subscription,
  all existing `byId` references and painters keep working.
- Advanced is mirrored to `?view=advanced` via `history.pushState` inside a
  `try/catch` (gateway shells may refuse). Direct load opens Advanced. Leaving
  Advanced uses `history.back()` only when we pushed that entry, else
  `replaceState` strips the parameter, so Back never bounces out of the app.
- Focus moves per switch: to `#advanced-title` on entering, `#board-title` on
  leaving. `goHome()`/`openBoard()` focus per current view.
- Switching to the default while viewing another owner's board calls `goHome()`
  first and announces it: the default view is always your own board.

## The default view — exactly five things

1. **Name as given by the parent** — the parent's `childNames` entry for this
   board (entry slot matches the parent's slot naming this owner and
   `entry.userId` equals this owner). Falls back to the board's own signed
   `selfName`, then `Your board`.
2. **Value and unit as given by the parent** — the parent's signed slot for this
   board, presented as a record from above that you cannot edit.
3. **Send payment** — opens the payment dialog; recipient chosen from the
   private address book (not a typed address).
4. **Address book** — opens the contacts dialog; the same control also appears
   inside the payment dialog.
5. **Copy receive-payment link** — copies a link; another person opening it gets
   the add-contact dialog with payee id and octal address already filled.

Layout: a single record card (eyebrow `Held by <P>` / `No parent yet`, name as
`h2#board-title`, then the figure with unit, a `Recorded by <P>. You can't
change it here.` line, the optional note), then the three actions stacked full
width on a phone (44 px minimum), then the Advanced toggle.

Copy matrix for the card:

| Situation | Eyebrow | Name line source |
|---|---|---|
| Mutual parent, parent names this board | `Held by <P>` | that `childNames` entry |
| Mutual parent, no entry | `Held by <P>` | own `selfName`, else `Your board` |
| Parent set, not mutual | `Waiting on <P>` | own `selfName`, else `Your board` |
| Parent board missing | `<P> · not created` | own `selfName`, else `Your board` |
| Parent unreadable | `Could not check <P>` | own `selfName`, else `Your board` |
| Root | `No parent yet` | own `selfName`, else `Your board` |
| Loading | `Held by your parent` | `Your board` |

Value states: linked → figure + `Recorded by <P>. You can't change it here.`;
root → `Nothing is recorded above this board, because it has no parent.`;
pending → `<P> has this board in no slot yet, so there is no value to show.`;
not created → `<P> has not opened Tally yet, so there is no board there.`;
unreadable → `Could not read <P>'s board, so the value could not be checked.`;
loading → `Reading your board…`. Negative amounts use ink, not danger colour.

Action states (visible reason text, never a dead end, `aria-describedby`):

| Control | Enabled | Disabled reason |
|---|---|---|
| Send payment | own board, ready/offline, no active or stuck payment, not a root | root: `A board with no parent has nothing to pay from. Set a parent under Advanced.`; active: `A payment is already in progress. Review it under Advanced.` |
| Address book | own board, state loaded | `Waiting for your board.` |
| Copy receive-payment link | own identity available | `Waiting for your identity.` |

**One permitted exception to "five things":** when a payment leg is waiting for
this owner's signature, a single line appears between card and actions —
`A payment is waiting for your signature.` + `Review in Advanced` (switches view
and focuses the inbox). The ledger itself lives in Advanced, but a stalled leg
must never be invisible. The integrity `#warnings` box also stays visible when
non-empty; it is an alarm, not content.

Connection status moves to Advanced; failures still surface through `#notice`.

## The advanced page

Top to bottom, each block keeping its existing ids/painter:

1. Identity (short key, `Back up identity`) · board name (`Rename`) · parent
   (`Open parent` / `Set parent…` / `Clear parent`) · address book.
2. Details (collapsed): contract id, background payments/delegate status, cleared
   slots (`Cleared slots: 3, 5`).
3. Where this board sits: breadcrumbs, octal address chip, mode line.
4. Payments: status card, waiting-for-you inbox, `Check for payments`,
   `Send a payment…` (a second entry point, id `#payment-open-ledger`).
5. **Child slots (N of 8)** — the only place the count may appear, phrased as a
   capacity limit. Shows a slot only when it **exists**: the parent has the slot
   *and* the child board names this board as its parent. Empty slots are hidden
   (`button.hidden = true`; the eight `.slot` nodes stay in the DOM so existing
   tests and `SlotView[]` keep working). `Add a child slot` under the grid,
   hidden when all eight are written. Empty state: `No child slots yet.` Hint:
   `A child slot records a value for one child board. A board holds up to 8. A
   link counts as a child only when both boards name each other.`
6. **Unconfirmed slots** — written slots whose child does not point back, listed
   as facts with a `Clear` action. Deliberate deviation from "only mutual":
   without it an owner has no path to see or clear a one-sided slot. Never
   labelled "child slots".
7. Adjustments (issue/burn log, the payment-since-adjustment line).
8. The own-board hint paragraph.

## Dialogs

### Send payment

Recipient first: a `<select>` of address-book contacts (`Choose someone…`),
then an `Address book` button (the same dialog, `selectOnAdd`), then the resolved
address line: `Address 03` / `No address yet. Ask them for a receive link.`
The address comes **from the contact record**, not from reading their board.

Amount, then `<details>` `Pay an address directly` wrapping the existing typed
address/user id fields (operator escape hatch, collapsed). Submit label
`Send payment`. Reword the intro to `The amount moves up to the board you share
and down to theirs. Each owner signs their own part, so it waits for them.` and
the LCA error to `A payment needs a board above each side. Neither end can be the
shared top board or the root itself.`

### Address book

- Each row: label, short id, address (`03` or `not set`), `Remove`, and a
  rename/edit affordance using `updateContact` (a contact rename does **not**
  re-sign `childNames`; say so where it matters).
- Add form gains `Octal address (optional)`, saved with the contact and editable
  later; hint: `Digits 0–7 from the root, e.g. 03. Needed to pay them.`
- Invite banner (`From a link`): `<name> shared their board with you.` with
  `Board address` and `Their key` rows; prefills label, id and address; nothing
  is saved until `Add contact`.

### Receive link

`<origin><path>?pay=<64 hex>&name=<suggested label>&addr=<octal>`, params dropped
with `replaceState` after the dialog opens. `pay` required and validated; a bad
`addr` is ignored, not fatal; `name` is this board's own name, omitted when none.
Rejected cases: own id (`That link is your own board`), already a contact (open
the book, highlight the row, `Already in your address book.`), missing/invalid
pay (`That link is incomplete`). Clipboard feedback: visible status line
(`Link copied. Opening it adds you to their address book.`) plus label swap to
`Copied` for 1.3 s; on failure show the link in `#notice` so it can be copied by
hand.

## Copy rule

`8 slots` / `Eight slots` must not appear on the default view or as branding;
`(N of 8)` appears once, inside Advanced. `#simple-view` must contain no
occurrence of the word `slot`. The tagline becomes
`One owner. One board. Every change signed.` The `.wordmark-tag` (`08 slots`)
node is deleted. A unit test over the copy and one e2e assertion enforce this.

## Accessibility and responsive

Heading order: default `h1` → `h2#board-title`; advanced `h1` → `h2#advanced-title`
→ `h3` per block (renumber the adjustments `h4` to `h3`). Disabled actions carry
visible reasons. `role="status"` for address resolution and clipboard feedback
with empty initial text. Targets ≥44 px; the action stack is full width below
560 px; the figure uses the existing long-amount classes so
`92233720368547758.07` cannot force horizontal scroll. Reuse the existing palette,
`.button` variants, dialog focus behaviour and `@media (prefers-reduced-motion)`
guard; no new dependencies, fonts or images.

## Revision 2 (2026-11-01) — children and the parent on the default view

Supersedes the corresponding points above.

- **Header:** the `Personal Freenet board` eyebrow and the `One owner. One board.
  Every change signed.` tagline are gone. The header is the wordmark, the view
  toggle, and nothing else.
- **Board name label:** the card title is prefixed with a literal, quiet label
  `Your Board Name:` above the name (the words stay inside the `h2`, so the
  accessible heading still reads `Your Board Name: <name>`). An unnamed board
  renders `Your Board Name: —`.
- **Children:** the default view lists the children a board actually has —
  rows of name + value + unit, read-only, sharing one sheet with the parent
  card. A child appears only under the existing mutual rule; a one-sided slot
  never appears here. The block is hidden when there are none. Authoring
  (add / edit / clear) and the `Unconfirmed slots` block stay in Advanced.
- **Parent:** setting, changing and clearing the parent now happen on the
  default view. Root/pending states show `Set parent…` as the primary action
  (it is the leaf user's onboarding step); a linked board shows the parent's
  name with `Change parent` / `Clear parent`. Advanced keeps only a read-only
  parent summary plus `Open parent`.
- **Auto-advance:** manual payment controls are conditional on the delegate
  actually auto-advancing (`configured && autoAdvance && lastScan > 0`).
  When it is active, `Check for payments` and the duplicate `Send a payment…`
  entry are absent and the block says the node signs your part as it arrives.
  When it is not (no delegate, switched off, or a node that never granted the
  Background capability), `Check for payments` and the manual sentence remain:
  without the grant there is no automatic signing, and hiding the control would
  strand a leg. The app cannot grant Background itself — the node decides — so
  this fallback is permanent, not transitional.
- **Ids:** the default-view actions are `#simple-pay`, `#simple-contacts`,
  `#simple-receive-link`; the parent controls are `#parent-edit` /
  `#parent-clear`, reachable from the default view. `#payment-open-ledger` and
  `#payment-open` no longer exist.
- **Copy rule:** the banned phrases remain `8 slots` / `Eight slots` outside
  Advanced. The word `slot` may appear on the default view now that children
  are listed there; the old "no `slot` in `#simple-view`" assertion is retired.

## Revision 3 (2026-11-02) — zones, no own name, parent only when missing

Supersedes Revision 2's name, parent and address points.

- **Terminology:** user-facing copy says **zone** / **zones** everywhere.
  Identifiers, CSS ids/classes, signing domains and crate/file names keep the
  old `board` wording; they are frozen and invisible to users.
- **No own name:** a zone has no name of its own. `selfName` stays in the v6
  state schema so older boards still decode and merge, but it is dormant: the
  UI never reads it, never writes it, and the v5→v6 migration never seeds it.
  The only remaining names are the parent-signed `childNames` entries for child
  slots. The Board name row, Rename action and name dialog are gone.
- **Simple view, top to bottom:**
  1. an `h2#board-title` reading `Your zone`, with a small, low-contrast
     `Octal address` reading beside it (`root` for a root). The address uses the
     existing `octalAddress` walk and updates as the parent chain resolves; it is
     not the Advanced chip and never competes with the actions;
  2. the record card, present only when a mutual parent exists: neutral eyebrow
     `Balance`, then the parent's value and unit. It never names the parent;
  3. the mutual-only children list (slot-given name + value + unit), hidden when
     empty;
  4. a payment-waiting line when one exists (unchanged);
  5. Send payment, Address book, Copy receive-payment link (unchanged).
- **Parent only when missing:** with a usable mutual parent the simple view does
  not mention the parent at all — no eyebrow, name, link or clear control.
  Root, pending, missing and unreadable links show one quiet prompt: the fact,
  one sentence and a single button opening `parentDialog.open()`. Root reads
  `Add a parent`; a set-but-broken link reads `Fix parent link…`. Changing and
  clearing a healthy parent live in Advanced only: its Parent row shows
  `#parent-name`, `#parent-status` and `#parent-note`, plus `Change parent…`
  (`#parent-advanced-edit`, opens `parentDialog.open()`) and `Clear parent`
  (`#parent-advanced-clear`) whenever the zone has a parent. A root shows no
  Advanced parent controls; the simple view owns `Add a parent`.
- **Receive links:** `name=` comes from the parent's `childNames` entry for this
  zone when a mutual parent exists, and is omitted otherwise. `pay=` and `addr=`
  are unchanged.
- **Ids:** `#simple-parent` may now be hidden; `#parent-edit` is the prompt's
  single button and `#parent-clear` remains in the DOM but hidden. `#board-title`
  is the simple `h2`; `#simple-address`, `#simple-address-value` and
  `#simple-address-note` are the quiet address. The Advanced parent controls are
  `#parent-advanced-edit` and `#parent-advanced-clear`. Heading order stays
  `h1` → `h2#board-title` → `h3` (children).
- **Copy rule:** unchanged. `8 slots` / `Eight slots` appear only inside
  Advanced; the default view does not use the word `slot`.
