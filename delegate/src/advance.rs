//! Pure forward-leg planning for delegate auto-advance (v4.1).
//!
//! This module ports the routing and actor-step rules from
//! `ui/src/payments.ts` and implements the mandatory security checks from
//! `DESIGN-v4.1-v5.md`. It performs no signing and touches no secret store: the
//! caller turns a [`LegPlan`] into signed slot records and one signed payments
//! record.
//!
//! `BoardState` decodes both v4 and v5 JSON. `adjustments` is deliberately
//! ignored here: v4.1 only auto-advances payments.

use crate::{Entry, Payment, Payments, USER_ID_HEX_LEN};
use serde::Deserialize;

/// The all-zero owner id used for a terminal payment.
pub const ZERO_OWNER: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Maximum octal address length (`DESIGN-payments.md`).
pub const MAX_ADDRESS_DIGITS: usize = 32;

/// One slot's signed record, as read from either v4 or v5 state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SlotState {
    pub seq: u64,
    pub entry: Option<Entry>,
    pub sig: Option<String>,
}

/// A minimal board view shared by v4 and v5 states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardState {
    /// State version (4 or 5).
    pub v: u8,
    /// The owner key the instance is parameterised by (64 lowercase hex).
    pub owner: String,
    /// `parent.userId`, if any.
    pub parent: Option<String>,
    pub slots: [SlotState; 8],
    pub payments: Payments,
}

#[derive(Deserialize)]
struct WireState {
    v: u8,
    #[serde(default)]
    parent: WireParent,
    #[serde(default)]
    payments: Option<Payments>,
    #[serde(default)]
    slots: Vec<WireSlot>,
}

#[derive(Deserialize, Default)]
struct WireParent {
    #[serde(rename = "userId", default)]
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct WireSlot {
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    entry: Option<Entry>,
    #[serde(default)]
    sig: Option<String>,
}

fn empty_payments() -> Payments {
    Payments {
        seq: 0,
        settled: Vec::new(),
        entry: None,
        sig: None,
    }
}

impl BoardState {
    /// Decode a v4 or v5 JSON state under a known owner key.
    ///
    /// Unknown fields (notably v5's `adjustments`) are ignored.
    pub fn decode(bytes: &[u8], owner: &str) -> Result<Self, AdvanceError> {
        let wire: WireState = serde_json::from_slice(bytes).map_err(|_| AdvanceError::State)?;
        if wire.v != 4 && wire.v != 5 {
            return Err(AdvanceError::State);
        }
        if wire.slots.len() != 8 {
            return Err(AdvanceError::State);
        }
        let mut slots: [SlotState; 8] = std::array::from_fn(|_| SlotState::default());
        for (index, slot) in wire.slots.into_iter().enumerate() {
            slots[index] = SlotState {
                seq: slot.seq,
                entry: slot.entry,
                sig: slot.sig,
            };
        }
        Ok(Self {
            v: wire.v,
            owner: owner.to_owned(),
            parent: wire.parent.user_id,
            slots,
            payments: wire.payments.unwrap_or_else(empty_payments),
        })
    }

    fn slot_contact(&self, slot: u8) -> Option<&str> {
        self.slots
            .get(usize::from(slot))
            .and_then(|slot| slot.entry.as_ref())
            .map(|entry| entry.contact.as_str())
    }
}

/// The board being signed, plus the destination board when this is the final
/// leg. `destination` is only read for check (g).
pub struct OwnBoard<'a> {
    pub state: &'a BoardState,
    pub address: &'a str,
    pub destination: Option<&'a BoardState>,
}

/// One slot write the caller must sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotWrite {
    pub index: u8,
    /// The new post-leg entry.
    pub entry: Entry,
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Debit,
    Credit,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Debit => "debit",
            Direction::Credit => "credit",
        }
    }
}

/// The pure result of one leg. `payment.legs` is empty: the caller fills it
/// from the signed slot writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegPlan {
    pub slots: Vec<SlotWrite>,
    /// The next payment record to sign. Immutable fields are copied from the
    /// validated intent; `next`, `status`, `cursor` and `phase` are rebuilt from
    /// this board's own state and the actor step.
    pub payment: Payment,
    pub cursor: u8,
    pub role: Role,
    pub terminal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Debit,
    Lca,
    Credit,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Debit => "debit",
            Role::Lca => "lca",
            Role::Credit => "credit",
        }
    }
}

/// Why a leg was refused. Every variant is fail-closed: the caller records
/// [`AdvanceError::code`] as `lastError` and signs nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvanceError {
    State,
    MixedVersion,
    WrongNeighbour,
    PreviousSignature,
    PreviousRecord,
    LastLeg,
    NoUpstreamEvidence,
    Settled,
    Older,
    Busy,
    Cursor,
    Amount,
    Negative,
    Overflow,
    MissingSlot,
    FinalDestination,
    InvalidIntent,
    Route,
}

impl AdvanceError {
    pub fn code(self) -> &'static str {
        match self {
            AdvanceError::State => "invalid-state",
            AdvanceError::MixedVersion => "mixed-version",
            AdvanceError::WrongNeighbour => "wrong-neighbour",
            AdvanceError::PreviousSignature => "previous-signature",
            AdvanceError::PreviousRecord => "previous-record",
            AdvanceError::LastLeg => "previous-leg",
            AdvanceError::NoUpstreamEvidence => "no-upstream-evidence",
            AdvanceError::Settled => "settled",
            AdvanceError::Older => "older",
            AdvanceError::Busy => "busy",
            AdvanceError::Cursor => "cursor",
            AdvanceError::Amount => "amount",
            AdvanceError::Negative => "negative",
            AdvanceError::Overflow => "overflow",
            AdvanceError::MissingSlot => "missing-slot",
            AdvanceError::FinalDestination => "final-destination",
            AdvanceError::InvalidIntent => "invalid-intent",
            AdvanceError::Route => "route",
        }
    }
}

impl std::fmt::Display for AdvanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

/// The planned route between two octal addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub src_addr: String,
    pub dst_addr: String,
    pub lca_length: usize,
    pub debit_hops: usize,
    pub credit_hops: usize,
    pub hops: usize,
    pub lca_addr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepRole {
    Source,
    Debit,
    Lca,
    Credit,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepSlot {
    pub slot: u8,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorStep {
    pub role: StepRole,
    pub own_address: String,
    pub slots: Vec<StepSlot>,
    pub next_cursor: u8,
    pub next_address: Option<String>,
}

fn is_octal_address(value: &str) -> bool {
    value.len() <= MAX_ADDRESS_DIGITS && value.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
}

fn common_prefix_length(a: &str, b: &str) -> usize {
    a.as_bytes()
        .iter()
        .zip(b.as_bytes())
        .take_while(|(left, right)| left == right)
        .count()
}

/// Port of `planRoute`. A payment needs at least one debit and one credit.
pub fn plan_route(src_addr: &str, dst_addr: &str) -> Result<Route, AdvanceError> {
    if !is_octal_address(src_addr) || !is_octal_address(dst_addr) {
        return Err(AdvanceError::Route);
    }
    if src_addr == dst_addr {
        return Err(AdvanceError::Route);
    }
    let lca_length = common_prefix_length(src_addr, dst_addr);
    let debit_hops = src_addr.len() - lca_length;
    let credit_hops = dst_addr.len() - lca_length;
    if debit_hops == 0 || credit_hops == 0 {
        return Err(AdvanceError::Route);
    }
    Ok(Route {
        src_addr: src_addr.to_owned(),
        dst_addr: dst_addr.to_owned(),
        lca_length,
        debit_hops,
        credit_hops,
        hops: debit_hops + credit_hops,
        lca_addr: src_addr[..lca_length].to_owned(),
    })
}

/// Port of `actorStep`. `own_address` is optional only for the terminal check.
pub fn actor_step(
    route: &Route,
    cursor: u8,
    own_address: Option<&str>,
) -> Result<ActorStep, AdvanceError> {
    let cursor = usize::from(cursor);
    if cursor > route.hops {
        return Err(AdvanceError::Cursor);
    }
    if cursor == route.hops {
        return Ok(ActorStep {
            role: StepRole::Terminal,
            own_address: String::new(),
            slots: Vec::new(),
            next_cursor: cursor as u8,
            next_address: None,
        });
    }
    // The LCA's second logical hop is part of one paired delta.
    if cursor == route.debit_hops {
        return Err(AdvanceError::Cursor);
    }

    let step = if cursor == 0 && own_address == Some(route.src_addr.as_str()) {
        ActorStep {
            role: StepRole::Source,
            own_address: route.src_addr.clone(),
            slots: Vec::new(),
            next_cursor: 0,
            next_address: Some(route.src_addr[..route.src_addr.len() - 1].to_owned()),
        }
    } else if cursor < route.debit_hops - 1 {
        let depth = route.src_addr.len() - 1 - cursor;
        ActorStep {
            role: StepRole::Debit,
            own_address: route.src_addr[..depth].to_owned(),
            slots: vec![StepSlot {
                slot: route.src_addr.as_bytes()[depth] - b'0',
                direction: Direction::Debit,
            }],
            next_cursor: (cursor + 1) as u8,
            next_address: Some(route.src_addr[..depth - 1].to_owned()),
        }
    } else if cursor == route.debit_hops - 1 {
        ActorStep {
            role: StepRole::Lca,
            own_address: route.lca_addr.clone(),
            slots: vec![
                StepSlot {
                    slot: route.src_addr.as_bytes()[route.lca_length] - b'0',
                    direction: Direction::Debit,
                },
                StepSlot {
                    slot: route.dst_addr.as_bytes()[route.lca_length] - b'0',
                    direction: Direction::Credit,
                },
            ],
            next_cursor: (route.debit_hops + 1) as u8,
            next_address: if route.credit_hops == 1 {
                None
            } else {
                Some(route.dst_addr[..route.lca_length + 1].to_owned())
            },
        }
    } else {
        let depth = route.lca_length + (cursor - route.debit_hops);
        ActorStep {
            role: StepRole::Credit,
            own_address: route.dst_addr[..depth].to_owned(),
            slots: vec![StepSlot {
                slot: route.dst_addr.as_bytes()[depth] - b'0',
                direction: Direction::Credit,
            }],
            next_cursor: (cursor + 1) as u8,
            next_address: if cursor + 1 == route.hops {
                None
            } else {
                Some(route.dst_addr[..depth + 1].to_owned())
            },
        }
    };

    if let Some(own_address) = own_address {
        if own_address != step.own_address {
            return Err(AdvanceError::InvalidIntent);
        }
    }
    Ok(step)
}

fn actor_address_at(route: &Route, hop: usize) -> Option<String> {
    if hop < route.debit_hops - 1 {
        return Some(route.src_addr[..route.src_addr.len() - 1 - hop].to_owned());
    }
    if hop == route.debit_hops - 1 {
        return Some(route.lca_addr.clone());
    }
    if hop <= route.debit_hops {
        return None;
    }
    Some(route.dst_addr[..route.lca_length + (hop - route.debit_hops)].to_owned())
}

/// The owner that should have carried the intent into this board.
fn expected_previous_owner(board: &BoardState, route: &Route, intent: &Payment) -> String {
    let cursor = usize::from(intent.cursor);
    if cursor == 0 {
        return intent.src.clone();
    }
    if cursor < route.debit_hops - 1 {
        let digit = route.src_addr.as_bytes()[route.src_addr.len() - 1 - cursor] - b'0';
        return board
            .slot_contact(digit)
            .unwrap_or(intent.src.as_str())
            .to_owned();
    }
    if cursor == route.debit_hops - 1 || cursor == route.debit_hops {
        if route.debit_hops == 1 {
            return intent.src.clone();
        }
        let digit = route.src_addr.as_bytes()[route.lca_length] - b'0';
        return board
            .slot_contact(digit)
            .unwrap_or(intent.src.as_str())
            .to_owned();
    }
    board.parent.clone().unwrap_or_else(|| intent.src.clone())
}

fn next_owner(board: &BoardState, step: &ActorStep) -> String {
    if step.next_address.is_none() {
        return ZERO_OWNER.to_owned();
    }
    if step.role == StepRole::Debit {
        return board
            .parent
            .clone()
            .unwrap_or_else(|| ZERO_OWNER.to_owned());
    }
    step.slots
        .iter()
        .find(|slot| slot.direction == Direction::Credit)
        .and_then(|slot| board.slot_contact(slot.slot))
        .unwrap_or(ZERO_OWNER)
        .to_owned()
}

fn parse_owner(owner: &str) -> Result<ed25519_dalek::VerifyingKey, AdvanceError> {
    if owner.len() != USER_ID_HEX_LEN {
        return Err(AdvanceError::PreviousSignature);
    }
    let bytes = hex::decode(owner).map_err(|_| AdvanceError::PreviousSignature)?;
    let bytes: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AdvanceError::PreviousSignature)?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| AdvanceError::PreviousSignature)
}

fn verify_payments_signature(
    state: &BoardState,
    owner: &str,
    entry: &Payment,
) -> Result<(), AdvanceError> {
    if state.payments.seq == 0 {
        return Err(AdvanceError::PreviousRecord);
    }
    let signature = state
        .payments
        .sig
        .as_deref()
        .ok_or(AdvanceError::PreviousSignature)?;
    let signature = hex::decode(signature).map_err(|_| AdvanceError::PreviousSignature)?;
    let signature: [u8; 64] = signature
        .as_slice()
        .try_into()
        .map_err(|_| AdvanceError::PreviousSignature)?;
    let signature = ed25519_dalek::Signature::from_bytes(&signature);
    let bytes =
        crate::payments_signing_bytes(state.payments.seq, &state.payments.settled, Some(entry))
            .map_err(|_| AdvanceError::PreviousSignature)?;
    parse_owner(owner)?
        .verify_strict(&bytes, &signature)
        .map_err(|_| AdvanceError::PreviousSignature)
}

fn same_immutable_fields(left: &Payment, right: &Payment) -> bool {
    left.id == right.id
        && left.src == right.src
        && left.dst == right.dst
        && left.amount == right.amount
        && left.src_addr == right.src_addr
        && left.dst_addr == right.dst_addr
}

/// Plan one forward leg.
///
/// `own` is this board's state and octal address; `intent` is the neighbour's
/// signed payment entry; `from` is that neighbour's board state and
/// `from_owner` its owner key. Checks (a)-(g) of
/// `DESIGN-v4.1-v5.md` are mandatory and fail closed.
pub fn plan_leg(
    own: &OwnBoard<'_>,
    intent: &Payment,
    from: &BoardState,
    from_owner: &str,
    max_amount: i64,
) -> Result<LegPlan, AdvanceError> {
    // Version compatibility: never sign into a mixed v4/v5 tree.
    if !matches!(own.state.v, 4 | 5) || !matches!(from.v, 4 | 5) || own.state.v != from.v {
        return Err(AdvanceError::MixedVersion);
    }
    if let Some(destination) = own.destination {
        if destination.v != own.state.v {
            return Err(AdvanceError::MixedVersion);
        }
    }

    if intent.next != own.state.owner {
        return Err(AdvanceError::WrongNeighbour);
    }
    if intent.phase != "forward" || !matches!(intent.status.as_str(), "offered" | "acted") {
        return Err(AdvanceError::InvalidIntent);
    }
    if intent.amount <= 0 {
        return Err(AdvanceError::Amount);
    }
    if max_amount != 0 && intent.amount > max_amount {
        return Err(AdvanceError::Amount);
    }

    let route = plan_route(&intent.src_addr, &intent.dst_addr)?;
    if usize::from(intent.cursor) > route.hops {
        return Err(AdvanceError::Cursor);
    }
    let step = actor_step(&route, intent.cursor, Some(own.address))?;
    let role = match step.role {
        StepRole::Debit => Role::Debit,
        StepRole::Lca => Role::Lca,
        StepRole::Credit => Role::Credit,
        StepRole::Source | StepRole::Terminal => return Err(AdvanceError::InvalidIntent),
    };

    // (a) The carrying board must be the previous route actor derived from own
    // state, not merely an adjacent board.
    if from_owner != expected_previous_owner(own.state, &route, intent) {
        return Err(AdvanceError::WrongNeighbour);
    }

    // (b) The previous actor's payments record must be signed and match.
    let from_entry = from
        .payments
        .entry
        .as_ref()
        .ok_or(AdvanceError::PreviousRecord)?;
    if !same_immutable_fields(from_entry, intent)
        || from_entry.phase != intent.phase
        || from_entry.status != intent.status
        || from_entry.cursor != intent.cursor
        || from_entry.next != intent.next
        || from_entry.fail != intent.fail
        || from_entry.legs != intent.legs
    {
        return Err(AdvanceError::PreviousRecord);
    }
    verify_payments_signature(from, from_owner, from_entry)?;

    // (c) Every leg the previous actor claims must be present in its own state.
    let cursor = usize::from(intent.cursor);
    if cursor == 0 {
        // The source has no leg. The first upward actor must debit the slot
        // that actually names the claimed source.
        let debit = step
            .slots
            .iter()
            .find(|slot| slot.direction == Direction::Debit)
            .ok_or(AdvanceError::InvalidIntent)?;
        if own.state.slot_contact(debit.slot) != Some(intent.src.as_str()) {
            return Err(AdvanceError::LastLeg);
        }
    } else {
        if from_entry.legs.is_empty() {
            return Err(AdvanceError::NoUpstreamEvidence);
        }
        // The LCA's pair advances the cursor by two, so the actor immediately
        // before the first destination-side credit is the LCA, not `cursor - 1`.
        let previous_hop = if cursor == route.debit_hops + 1 {
            route.debit_hops - 1
        } else {
            cursor - 1
        };
        let previous_address =
            actor_address_at(&route, previous_hop).ok_or(AdvanceError::PreviousRecord)?;
        let previous_step = actor_step(&route, previous_hop as u8, Some(&previous_address))?;
        for leg in &from_entry.legs {
            let slot = from
                .slots
                .get(usize::from(leg.slot))
                .ok_or(AdvanceError::LastLeg)?;
            let entry = slot.entry.as_ref().ok_or(AdvanceError::LastLeg)?;
            if slot.seq != leg.seq
                || entry.value != leg.post_value
                || slot.sig.as_deref() != Some(leg.sig.as_str())
            {
                return Err(AdvanceError::LastLeg);
            }
            let direction = previous_step
                .slots
                .iter()
                .find(|candidate| candidate.slot == leg.slot)
                .ok_or(AdvanceError::LastLeg)?;
            if direction.direction == Direction::Credit && entry.contact != own.state.owner {
                return Err(AdvanceError::LastLeg);
            }
        }
        // A destination-side credit must be backed by the previous actor's own
        // signed credit leg to this board. A source-side debit is not evidence
        // for a credit, even when it is otherwise valid.
        if step.role == StepRole::Credit {
            let credit = previous_step
                .slots
                .iter()
                .find(|slot| slot.direction == Direction::Credit)
                .ok_or(AdvanceError::NoUpstreamEvidence)?;
            let backed = from_entry.legs.iter().any(|leg| {
                leg.slot == credit.slot
                    && from
                        .slots
                        .get(usize::from(credit.slot))
                        .and_then(|slot| slot.entry.as_ref())
                        .is_some_and(|entry| entry.contact == own.state.owner)
            });
            if !backed {
                return Err(AdvanceError::NoUpstreamEvidence);
            }
        }
    }

    // (d) This board's own record: settled, older, or busy.
    if own.state.payments.settled.iter().any(|id| id == &intent.id) {
        return Err(AdvanceError::Settled);
    }
    if let Some(own_entry) = own.state.payments.entry.as_ref() {
        if own_entry.id == intent.id {
            if own_entry.phase == "terminal" || own_entry.cursor >= intent.cursor {
                return Err(AdvanceError::Older);
            }
            if own_entry.phase != "forward" {
                return Err(AdvanceError::InvalidIntent);
            }
        } else if own_entry.phase != "terminal" {
            return Err(AdvanceError::Busy);
        }
    }

    // (e) Cursor continuity.
    if cursor == 0 {
        if from_entry.cursor != 0 || from_entry.phase != "forward" {
            return Err(AdvanceError::Cursor);
        }
    } else if from_entry.phase != "forward"
        || from_entry.status != "acted"
        || from_entry.cursor != intent.cursor
    {
        return Err(AdvanceError::Cursor);
    }

    // (f) Amount and funds, computed from own state.
    let mut slots = Vec::with_capacity(step.slots.len());
    for step_slot in &step.slots {
        let own_slot = own
            .state
            .slots
            .get(usize::from(step_slot.slot))
            .ok_or(AdvanceError::MissingSlot)?;
        let entry = own_slot.entry.as_ref().ok_or(AdvanceError::MissingSlot)?;
        let value = match step_slot.direction {
            Direction::Debit => {
                if entry.value < intent.amount {
                    return Err(AdvanceError::Negative);
                }
                entry.value - intent.amount
            }
            Direction::Credit => entry
                .value
                .checked_add(intent.amount)
                .ok_or(AdvanceError::Overflow)?,
        };
        let mut new_entry = entry.clone();
        new_entry.value = value;
        slots.push(SlotWrite {
            index: step_slot.slot,
            entry: new_entry,
            direction: step_slot.direction,
        });
    }

    let terminal = step.next_address.is_none();

    // (g) Final leg: the credited slot names the destination, and that board's
    // parent link names this board's owner.
    if terminal {
        let credit = step
            .slots
            .iter()
            .find(|slot| slot.direction == Direction::Credit)
            .ok_or(AdvanceError::FinalDestination)?;
        if own.state.slot_contact(credit.slot) != Some(intent.dst.as_str()) {
            return Err(AdvanceError::FinalDestination);
        }
        let destination = own.destination.ok_or(AdvanceError::FinalDestination)?;
        if destination.owner != intent.dst
            || destination.parent.as_deref() != Some(own.state.owner.as_str())
        {
            return Err(AdvanceError::FinalDestination);
        }
    }

    let payment = Payment {
        id: intent.id.clone(),
        src: intent.src.clone(),
        dst: intent.dst.clone(),
        amount: intent.amount,
        src_addr: intent.src_addr.clone(),
        dst_addr: intent.dst_addr.clone(),
        cursor: step.next_cursor,
        phase: if terminal { "terminal" } else { "forward" }.to_owned(),
        status: if terminal { "complete" } else { "acted" }.to_owned(),
        next: next_owner(own.state, &step),
        fail: None,
        legs: Vec::new(),
    };

    Ok(LegPlan {
        slots,
        payment,
        cursor: step.next_cursor,
        role,
        terminal,
    })
}

/// Extract the payment id/destination displayed in audit entries.
pub fn audit_slots(plan: &LegPlan) -> Vec<u8> {
    plan.slots.iter().map(|slot| slot.index).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PaymentLeg, Payments};
    use ed25519_dalek::{Signer, SigningKey};

    fn owner(seed: u8) -> (SigningKey, String) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let hex = hex::encode(key.verifying_key().to_bytes());
        (key, hex)
    }

    fn entry(value: i64, contact: &str) -> Entry {
        Entry {
            value,
            contact: contact.to_owned(),
            unit: None,
            note: None,
        }
    }

    fn slot(seq: u64, value: i64, contact: &str) -> SlotState {
        SlotState {
            seq,
            entry: Some(entry(value, contact)),
            sig: Some("aa".repeat(64)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn payment(
        id: &str,
        src: &str,
        dst: &str,
        amount: i64,
        src_addr: &str,
        dst_addr: &str,
        cursor: u8,
        status: &str,
        next: &str,
        legs: Vec<PaymentLeg>,
    ) -> Payment {
        Payment {
            id: id.to_owned(),
            src: src.to_owned(),
            dst: dst.to_owned(),
            amount,
            src_addr: src_addr.to_owned(),
            dst_addr: dst_addr.to_owned(),
            cursor,
            phase: "forward".to_owned(),
            status: status.to_owned(),
            next: next.to_owned(),
            fail: None,
            legs,
        }
    }

    fn sign_from(key: &SigningKey, state: &mut BoardState) {
        let entry = state.payments.entry.clone().expect("test entry");
        let bytes = crate::payments_signing_bytes(
            state.payments.seq,
            &state.payments.settled,
            Some(&entry),
        )
        .expect("valid test entry");
        state.payments.sig = Some(hex::encode(key.sign(&bytes).to_bytes()));
    }

    fn board(v: u8, owner: &str, parent: Option<&str>) -> BoardState {
        BoardState {
            v,
            owner: owner.to_owned(),
            parent: parent.map(str::to_owned),
            slots: std::array::from_fn(|_| SlotState::default()),
            payments: Payments {
                seq: 0,
                settled: Vec::new(),
                entry: None,
                sig: None,
            },
        }
    }

    const PAYMENT_ID: &str = "11111111111111111111111111111111";

    /// Vector 1: a 3-hop route, source-side debit at cursor 0.
    #[test]
    fn three_hop_source_side_debit() {
        let (src_key, src) = owner(1);
        let (own_key, own) = owner(2);
        let (_root_key, root) = owner(3);
        let (_dst_key, dst) = owner(4);

        let mut own_state = board(4, &own, Some(&root));
        own_state.slots[2] = slot(4, 1000, &src);

        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "3",
            0,
            "offered",
            &own,
            vec![],
        );
        let mut from = board(4, &src, Some(&own));
        from.payments = Payments {
            seq: 3,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&src_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "5",
            destination: None,
        };
        let plan = plan_leg(&own_board, &intent, &from, &src, 0).expect("leg plans");

        assert_eq!(plan.role, Role::Debit);
        assert_eq!(plan.cursor, 1);
        assert!(!plan.terminal);
        assert_eq!(plan.slots.len(), 1);
        assert_eq!(plan.slots[0].index, 2);
        assert_eq!(plan.slots[0].entry.value, 900);
        assert_eq!(plan.payment.next, root);
        assert_eq!(plan.payment.status, "acted");
        assert!(plan.payment.legs.is_empty());
        // The source's own key is only used to sign the previous record.
        let _ = own_key;
    }

    /// Vector 2: the LCA's paired debit/credit in one delta.
    #[test]
    fn lca_pair() {
        let (_src_key, src) = owner(1);
        let (prev_key, prev) = owner(6);
        let (own_key, own) = owner(7);
        let (_child_key, child) = owner(8);
        let (_dst_key, dst) = owner(4);

        let mut own_state = board(4, &own, Some(&owner(3).1));
        own_state.slots[5] = slot(7, 1000, &prev);
        own_state.slots[3] = slot(2, 500, &child);

        let leg = PaymentLeg {
            slot: 2,
            seq: 5,
            post_value: 900,
            sig: "aa".repeat(64),
        };
        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "31",
            1,
            "acted",
            &own,
            vec![leg.clone()],
        );
        let mut from = board(4, &prev, Some(&own));
        from.slots[2] = slot(5, 900, &src);
        from.payments = Payments {
            seq: 8,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&prev_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "",
            destination: None,
        };
        let plan = plan_leg(&own_board, &intent, &from, &prev, 0).expect("lca leg plans");

        assert_eq!(plan.role, Role::Lca);
        assert_eq!(plan.cursor, 3);
        assert_eq!(plan.slots.len(), 2);
        assert_eq!(plan.slots[0].index, 5);
        assert_eq!(plan.slots[0].entry.value, 900);
        assert_eq!(plan.slots[1].index, 3);
        assert_eq!(plan.slots[1].entry.value, 600);
        assert_eq!(plan.payment.next, child);
        assert!(!plan.terminal);
        let _ = own_key;
    }

    /// Vector 3: a destination-side credit.
    #[test]
    fn destination_side_credit() {
        let (_src_key, src) = owner(1);
        let (prev_key, prev) = owner(3);
        let (own_key, own) = owner(9);
        let (_next_key, next) = owner(10);
        let (_dst_key, dst) = owner(4);

        let mut own_state = board(4, &own, Some(&prev));
        own_state.slots[1] = slot(3, 500, &next);

        let leg = PaymentLeg {
            slot: 3,
            seq: 6,
            post_value: 600,
            sig: "bb".repeat(64),
        };
        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "310",
            3,
            "acted",
            &own,
            vec![leg.clone()],
        );
        let mut from = board(4, &prev, None);
        from.slots[5] = slot(4, 1000, &src);
        from.slots[3] = slot(6, 600, &own);
        from.slots[3].sig = Some(leg.sig.clone());
        from.payments = Payments {
            seq: 9,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&prev_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "3",
            destination: None,
        };
        let plan = plan_leg(&own_board, &intent, &from, &prev, 0).expect("credit leg plans");

        assert_eq!(plan.role, Role::Credit);
        assert_eq!(plan.cursor, 4);
        assert_eq!(plan.slots[0].index, 1);
        assert_eq!(plan.slots[0].entry.value, 600);
        assert_eq!(plan.payment.next, next);
        assert!(!plan.terminal);
        let _ = own_key;
    }

    /// Vector 4: the destination's parent final leg.
    #[test]
    fn destination_parent_final_leg() {
        let (_src_key, src) = owner(1);
        let (prev_key, prev) = owner(9);
        let (own_key, own) = owner(10);
        let (dst_key, dst) = owner(11);

        let mut own_state = board(4, &own, Some(&prev));
        own_state.slots[0] = slot(4, 500, &dst);
        own_state.payments.seq = 2;

        let leg = PaymentLeg {
            slot: 1,
            seq: 7,
            post_value: 600,
            sig: "cc".repeat(64),
        };
        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "310",
            4,
            "acted",
            &own,
            vec![leg.clone()],
        );
        let mut from = board(4, &prev, None);
        from.slots[1] = slot(7, 600, &own);
        from.slots[1].sig = Some(leg.sig.clone());
        from.payments = Payments {
            seq: 10,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&prev_key, &mut from);

        let mut destination = board(4, &dst, Some(&own));
        destination.slots[0] = slot(1, 0, &src);

        let own_board = OwnBoard {
            state: &own_state,
            address: "31",
            destination: Some(&destination),
        };
        let plan = plan_leg(&own_board, &intent, &from, &prev, 0).expect("final leg plans");

        assert!(plan.terminal);
        assert_eq!(plan.role, Role::Credit);
        assert_eq!(plan.cursor, 5);
        assert_eq!(plan.payment.phase, "terminal");
        assert_eq!(plan.payment.status, "complete");
        assert_eq!(plan.payment.next, ZERO_OWNER);
        assert_eq!(plan.slots[0].entry.value, 600);
        let _ = (own_key, dst_key);
    }

    /// Vector 5: cursor 0, source-parent leg (the source's parent debits the
    /// slot naming the source).
    #[test]
    fn cursor_zero_source_parent_leg() {
        let (src_key, src) = owner(1);
        let (_own_key, own) = owner(12);
        let root = owner(3).1;
        let dst = owner(4).1;

        let mut own_state = board(4, &own, Some(&root));
        own_state.slots[0] = slot(1, 800, &src);

        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            150,
            "520",
            "31",
            0,
            "offered",
            &own,
            vec![],
        );
        let mut from = board(4, &src, Some(&own));
        from.payments = Payments {
            seq: 1,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&src_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "52",
            destination: None,
        };
        let plan = plan_leg(&own_board, &intent, &from, &src, 0).expect("source parent leg plans");

        assert_eq!(plan.role, Role::Debit);
        assert_eq!(plan.cursor, 1);
        assert_eq!(plan.slots[0].index, 0);
        assert_eq!(plan.slots[0].entry.value, 650);
    }

    /// Vector 6: a debit larger than the slot value aborts.
    #[test]
    fn negative_debit_aborts() {
        let (src_key, src) = owner(1);
        let own = owner(2).1;
        let root = owner(3).1;
        let dst = owner(4).1;

        let mut own_state = board(4, &own, Some(&root));
        own_state.slots[2] = slot(1, 50, &src);

        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "3",
            0,
            "offered",
            &own,
            vec![],
        );
        let mut from = board(4, &src, Some(&own));
        from.payments = Payments {
            seq: 1,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&src_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "5",
            destination: None,
        };
        assert_eq!(
            plan_leg(&own_board, &intent, &from, &src, 0),
            Err(AdvanceError::Negative)
        );
    }

    /// Vector 7: an intent carried by a board that is not the previous actor.
    #[test]
    fn wrong_neighbour_aborts() {
        let (src_key, src) = owner(1);
        let own = owner(2).1;
        let root = owner(3).1;
        let dst = owner(4).1;
        let stranger = owner(5).1;

        let mut own_state = board(4, &own, Some(&root));
        own_state.slots[2] = slot(1, 1000, &src);

        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "3",
            0,
            "offered",
            &own,
            vec![],
        );
        let mut from = board(4, &src, Some(&own));
        from.payments = Payments {
            seq: 1,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&src_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "5",
            destination: None,
        };
        assert_eq!(
            plan_leg(&own_board, &intent, &from, &stranger, 0),
            Err(AdvanceError::WrongNeighbour)
        );
    }

    /// Vector 8: a credit with no upstream leg evidence aborts.
    #[test]
    fn credit_without_upstream_evidence_aborts() {
        let src = owner(1).1;
        let (prev_key, prev) = owner(3);
        let own = owner(9).1;
        let next = owner(10).1;
        let dst = owner(4).1;

        let mut own_state = board(4, &own, Some(&prev));
        own_state.slots[1] = slot(3, 500, &next);

        // The previous actor claims cursor 3 but carries no leg.
        let intent = payment(
            PAYMENT_ID,
            &src,
            &dst,
            100,
            "52",
            "310",
            3,
            "acted",
            &own,
            vec![],
        );
        let mut from = board(4, &prev, None);
        from.payments = Payments {
            seq: 9,
            settled: vec![],
            entry: Some(intent.clone()),
            sig: None,
        };
        sign_from(&prev_key, &mut from);

        let own_board = OwnBoard {
            state: &own_state,
            address: "3",
            destination: None,
        };
        assert_eq!(
            plan_leg(&own_board, &intent, &from, &prev, 0),
            Err(AdvanceError::NoUpstreamEvidence)
        );
    }

    #[test]
    fn v5_states_decode_and_mixed_versions_abort() {
        let bytes = br#"{
            "v": 5,
            "parent": {"seq": 1, "userId": "1111111111111111111111111111111111111111111111111111111111111111", "sig": "00"},
            "contacts": {"seq": 0, "entries": [], "sig": null},
            "payments": {"seq": 0, "settled": [], "entry": null, "sig": null},
            "adjustments": {"seq": 3, "entries": [], "sig": null},
            "slots": [
                {"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},
                {"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},
                {"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null},
                {"seq":0,"entry":null,"sig":null},{"seq":0,"entry":null,"sig":null}
            ]
        }"#;
        let owner = owner(2).1;
        let state = BoardState::decode(bytes, &owner).expect("v5 decodes");
        assert_eq!(state.v, 5);

        let own_state = board(4, &owner, None);
        let own = OwnBoard {
            state: &own_state,
            address: "",
            destination: None,
        };
        let from = board(5, &owner, None);
        let intent = payment(
            PAYMENT_ID,
            &owner,
            &owner,
            1,
            "5",
            "3",
            0,
            "offered",
            &owner,
            vec![],
        );
        assert_eq!(
            plan_leg(&own, &intent, &from, &owner, 0),
            Err(AdvanceError::MixedVersion)
        );
    }
}
