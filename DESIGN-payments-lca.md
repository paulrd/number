# Payment routes with an endpoint at the LCA (v6.1)

Status: design for review. Contract unchanged — `Payment::is_valid` is
structural and never checked `debit_hops`/`credit_hops`; the table lives in
`ui/src/payments.ts` and `delegate/src/advance.rs`, which must stay identical.

## Why

Today a route needs `dS >= 1` **and** `dD >= 1`, so a board cannot pay its own
child, pay its own parent, or receive from either — i.e. the two most common
relationships are the two that cannot move value. A leaf whose only link is its
parent is excluded from payments entirely.

## Accounting

For an edge `P → C`, the slot value `s(P,C)` is C's balance. A board X's net is

```
net(X) = s(parent(X), X) - Σ over children C of X: s(X,C)
```

A transfer of `m` from A to B moves `m` along each edge of the route; every
intermediate board has both its balance edge and its liability edge changed, so
it nets zero. The LCA is where the two sides meet: it debits its source-side
slot and credits its destination-side slot, netting zero.

- **Only downward links (`dS = 0`, A is the LCA).** There is no source-side
  slot. A credits its slot for the first child on the destination path:
  `s(A,C) += m`. That raises A's liabilities by `m` (net −m) and raises C's
  balance by `m`; the rest of the path nets zero and B gains `m`. The credit to
  the first child **is** the issue. No second write.
- **Only upward links (`dD = 0`, B is the LCA).** There is no destination-side
  slot. B debits its slot for the child on the source path:
  `s(B,C) -= m`. That lowers B's liabilities by `m` (net +m) and lowers C's
  balance; the source side nets zero and A loses `m`. The debit of that slot
  **is** the burn. No second write.
- Both `dS = 0` and `dD = 0` would mean A = B, which stays invalid.
- Different roots remain impossible: there is no LCA path.

So the change is: allow either side to be empty, and record nothing extra. The
word "implicit" is exact — the issue/burn is the meaning of the single slot
write, derived from the route, not a second `adjustments` entry. This also
keeps reversal a pure inverse of the same writes, with no log to unwind.

## Cursor table

`L = lcaLength`, `dS = |srcAddr| - L`, `dD = |dstAddr| - L`, `N = dS + dD ≥ 1`.

| Case | actor at cursor | slots | next cursor |
|---|---|---|---|
| `dS >= 1`, cursor `0` | source (no leg) | — | `0`, address = parent |
| `dS >= 1`, `0 < cursor < dS-1` | ancestor of source at depth `|src|-1-cursor` | debit `src[depth]` | `cursor+1` |
| `dS >= 1`, `cursor = dS-1` | **LCA** | debit `src[L]`, plus credit `dst[L]` when `dD >= 1` | `dS+1` (or `N` when `dD = 0`) |
| `dS = 0`, `cursor = 0` | **LCA = source**, writes intent **and** its leg in one delta | credit `dst[L]` only | `1` (or `N` when `dD = 1`) |
| `0 < cursor < N` | ancestor of destination at depth `L + (cursor - dS)` | credit `dst[depth]` | `cursor+1` |

Notes:

- With `dS = 0` the source step and the LCA step collapse: the source is the
  acting board, so it publishes the intent already advanced by one hop, with
  one leg. `next` is the owner of the first destination-side child, which the
  source reads from its own slot.
- With `dD = 0` the LCA is the destination: its single debit is the final hop,
  so `cursor` reaches `N` and the payment is terminal on that delta.
- `dS = 0, dD = 1` is a parent paying its own child: one delta, one credit,
  complete.
- `dD = 0, dS = 1` is a child paying its own parent: one delta at the parent,
  one debit, complete.
- Every debit still aborts before signing if it would take its slot below zero
  (the burn clamps at zero, like a manual burn). A downward-only payment has no
  debit, so nothing to clamp; A's liability rises by `m`.
- `MAX_PAYMENT_LEGS = 2` still holds: at most one slot per side, and the LCA
  never writes the same slot twice.

## Reversal

The reverse walk mirrors the same table: each actor undoes exactly the slot it
wrote. The LCA in a `dS = 0` route gives back the credit (a debit of the same
slot); in a `dD = 0` route it gives back the debit (a credit). Because the
forward write was one side of a pair, the inverse is one side too, and the
existing "own record still matches the intent" check keeps it from clobbering a
newer write. Terminal statuses and `superseded`/`blocked` handling are
unchanged.

## Call sites

- `ui/src/payments.ts`: drop `source-at-lca` / `destination-at-lca` from
  `RouteError`; `planRoute` accepts `dS = 0` or `dD = 0`; `actorStep` gains the
  two collapsed cases; the reverse step function mirrors them; keep
  `same-address`, `invalid-address`, `invalid-cursor`, `not-an-actor`.
- `delegate/src/advance.rs`: the same table in `Route`/`plan_leg`, including the
  `dS = 0` "source is the actor" case and the `dD = 0` terminal LCA case. Bump
  `DELEGATE_VERSION` to 10; register v9 in `LEGACY_DELEGATES`.
- UI copy: the payment dialog no longer says a payment needs a board above each
  side. A ledger entry should say *implicit issue* / *implicit burn* when the
  route has an LCA endpoint, so the liability change is legible.
- Eligibility: a board may send or receive when it has at least one link
  (parent or child) and shares a root with the counterparty. A board with no
  links still cannot pay: it has no slot anywhere.

## Resolved by review (attempt 1)

The accounting stands. These are the implementation constraints both sides must
follow; they are the difference between a route table that adds up and one that
panics or double-counts.

1. **Collapsed source step is explicit.** For `dS = 0` the plan carries a
   `sourceStep` with `sourceSlots` (the single credit). The source publishes the
   intent *already carrying its leg* at `cursor = 1` in one delta. Express it as
   its own concept; do not describe it as "advanced by one hop" (the record has
   no `offered`-with-leg state).
2. **Guard order.** The "phantom post-LCA cursor" rejection (`cursor == dS`)
   applies only when `dS >= 1`. The collapsed branch must be tested before the
   plain source branch, because with `dS = 0` the source address *is* the LCA
   address.
3. **No unsigned arithmetic on hop counts.** Every `dS - 1`, `len - 1`,
   `debit_hops - 1` site must be dead or guarded for `dS = 0` / root addresses;
   in Rust these are panics inside `plan_leg`, which aborts the delegate rather
   than failing closed.
4. **`dD = 0` terminal is debit-only.** The final-hop check must accept an LCA
   step with no credit slot and assert `own.owner == entry.dst` — that assertion
   is what ties the burn to the payee.
5. **`dS = 0` reversal must terminate.** After restoring the credit the source
   writes a **terminal** record; the generic `hop + 2` expectation does not
   apply and the "previous owner" of hop 0 is the source itself, so a naive
   mirror deadlocks in `reversing`. `dD = 0` has no reversal path in the forward
   flow (the burn is the last hop); make that branch fail cleanly rather than
   half-run.
6. **Eligibility follows the route, not the old rule.** A root may send and
   receive; a receive link may carry the empty (root) address; the payment
   dialog no longer requires a board above each side. A board with no links at
   all still cannot pay.
7. **The source must be able to undo its own issue.** A `dS = 0` source acts at
   cursor 1, so withdrawal/close handling that only accepts `cursor == 0`
   strands it. Allow the source to reverse or close the payment it created.
8. **Known new risk, accepted:** with `dS = 0` the amount is issued before the
   payee consents, and only the payer's own slot write can remove it. A stalled
   downward payment therefore leaves value issued until the payer reverses or
   overwrites the slot. This is the price of the user's rule and must be visible
   in the UI ("issued, not delivered"); it is not a silent condition.
9. **Ledger derives from the route.** Nothing writes an `adjustments` entry for
   an implicit issue/burn, so anything that infers issuance from the v5 log will
   disagree; the ledger must read the route.
