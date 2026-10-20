# Funding Rounds (VaultDAO Guide)

> Written for **grant managers** structuring milestone-based payouts and
> **integrators** wiring the funding-round lifecycle into tooling.
> Source of truth: the "Funding Rounds" section of `contracts/vault/src/lib.rs`,
> `FundingRound` / `FundingMilestone` / `FundingRoundConfig` in
> `contracts/vault/src/types.rs`, and the SDK helpers in `sdk/src/token-flows.ts`
> (see `sdk/examples/funding-round.ts` for a runnable example).

A funding round earmarks a fixed token amount in the vault and pays it to a
project in tranches as milestones are submitted and verified. Unlike a single
transfer proposal, the money is **not** sent up-front — the vault holds it and
releases one milestone at a time. If the round is cancelled, only the
not-yet-released portion is returned to the vault's escrow.

Typical uses:

- A grant paid on deliverables, where each deliverable unlocks its own tranche
- A vendor contract with a percentage or fixed milestone schedule
- A programme managed by a grant manager who verifies milestones and a
  treasurer who releases the funds

Ledgers close roughly every 5 seconds, so **1 day ≈ 17,280 ledgers**. Funding
rounds only use ledgers for audit timestamps (`created_at`, `approved_at`,
`submitted_at`, `verified_at`, `finalized_at`); they do not use deadlines.

---

## 1. Roles and entry points

| Action | Function | Required authority |
| --- | --- | --- |
| Create a round | `create_funding_round` | **Treasurer** or **Admin** |
| Approve a round | `approve_funding_round` | **Admin** |
| Submit a milestone | `submit_milestone` | the round's **recipient** only |
| Verify a milestone | `verify_milestone` | **Admin** |
| Release a verified milestone | `release_round_funds` | a **signer** with **Admin** or **Treasurer** role |
| Cancel a round | `cancel_funding_round` | **Admin** |
| Set the round config | `set_funding_round_config` | **any single current signer** |
| Read a round / config | `get_funding_round`, `get_funding_round_config`, `get_proposal_funding_rounds` | anyone |

Verification and release are deliberately split: an Admin decides a milestone is
done (`verify_milestone`) but does not move money, and a signer-treasurer moves
it (`release_round_funds`). This is a two-person control on every payout.

---

## 2. Lifecycle at a glance

```
                 create_funding_round                     approve_funding_round
  (none) ────────────────────────────▶ Pending ──────────────────────────────▶ Active
                                          │                                       │
                                          │ cancel_funding_round                  │ cancel_funding_round
                                          ▼                                       ▼
                                      Cancelled                               Cancelled
                                                                                  │
                                          all milestones verified + released       ▼
                                          ─────────────────────────────────▶  Completed
```

Milestones move independently:

```
Pending ──submit_milestone──▶ Submitted ──verify_milestone──▶ Verified ──release_round_funds──▶ (paid)
```

- `approve_funding_round` transitions `Pending → Active` in one step; the
  intermediate `Approved` status exists in the enum but is not observable
  (`approve_funding_round` writes `Active` directly).
- A milestone can be submitted only once and verified only once. `Rejected`
  exists in the enum but there is currently no funding-round entry point that
  sets it.
- The round auto-completes when the last verified milestone is released.

---

## 3. Milestone modes: fixed vs percentage

Each `FundingMilestone` carries both an `amount` and a
`release_percentage_bps` (basis points, where `10_000 = 100%`). Exactly one
mode is used per round — mixing them is rejected.

| | Fixed-amount mode | Percentage mode |
| --- | --- | --- |
| `release_percentage_bps` | `0` on every milestone | `> 0` on every milestone, summing to exactly `10_000` |
| `amount` | the exact payout for that milestone | also required to be `> 0` (see the gotcha below) |
| Round total | the sum of the milestone amounts (the `total_amount` argument is derived from, not used as, the total) | the sum of the milestone amounts |
| Payout at release | the milestone's `amount` | `round.total_amount × release_percentage_bps / 10_000`, truncated |

`create_funding_round` enforces, in order:

1. `total_amount > 0` and at least one milestone (`InvalidAmount` otherwise).
2. If a `FundingRoundConfig` is set: `enabled == true`, milestone count within
   `[min_milestones, max_milestones]`, and every milestone `amount ≥
   min_milestone_amount` (`InvalidAmount` if violated).
3. If any milestone uses percentages, their `release_percentage_bps` must sum
   to exactly `10_000`, or the call fails with `FundingRoundError` (220).
4. The two modes cannot be mixed: if any milestone has a percentage, every
   milestone with `release_percentage_bps == 0` must also have `amount == 0`
   (`FundingRoundError`).
5. Every milestone `amount` must be `> 0`, and the sum of the milestone amounts
   must equal the round's `total_amount` (`InvalidAmount`).

> **Percentage-mode gotcha.** In step 5 the contract requires a positive
> `amount` on *every* milestone even when percentages are supplied, and it
> derives the round's `total_amount` from the **sum of the milestone amounts**
> rather than from the `total_amount` argument. Set each percentage milestone's
> `amount` to its nominal share as well as its `release_percentage_bps` so the
> two agree (for a 10,000-token round split 40/60, pass amounts `4_000` and
> `6_000` with bps `4_000` and `6_000`). The released figure is always
> recomputed from the basis points at verification time.

### Rounding in percentage mode

Percentages are integer-truncated at verification. Any remainder is added to
the release of the **final** milestone: when the last unverified milestone is
released and the sum of the stored milestone amounts is below
`total_amount`, the difference is added to that release so the total paid never
exceeds `total_amount`.

---

## 4. Walkthrough

Full example: `sdk/examples/funding-round.ts`.

### Step 1 — configure once (optional but recommended)

```rust
vault.set_funding_round_config(
    &signer,
    FundingRoundConfig {
        enabled: true,
        min_milestones: 2,
        max_milestones: 8,
        min_milestone_amount: 100_0000000, // 100 units, 7-decimal token
        max_rounds_per_proposal: 1,
    },
);
```

Only one signer is needed. If the config was never set, `create_funding_round`
skips all bounds checks (no milestone-count or minimum-amount limit).

### Step 2 — create the round

```rust
let round_id = vault.create_funding_round(
    &treasurer,
    project_address.clone(),
    usdc.clone(),
    10_000_0000000, // total
    vec![
        &env,
        FundingMilestone {
            description: String::from_str(&env, "MVP"),
            amount: 4_000_0000000,
            release_percentage_bps: 4_000,
            status: FundingMilestoneStatus::Pending,
            submitted_at: 0,
            verified_at: 0,
            required_verifiers: 1,
            verifications: Vec::new(&env),
            rejection_reason: None,
        },
        FundingMilestone {
            description: String::from_str(&env, "Mainnet launch"),
            amount: 6_000_0000000,
            release_percentage_bps: 6_000,
            status: FundingMilestoneStatus::Pending,
            submitted_at: 0,
            verified_at: 0,
            required_verifiers: 1,
            verifications: Vec::new(&env),
            rejection_reason: None,
        },
    ],
);
```

The newly created round is `Pending`.

### Step 3 — approve

```rust
vault.approve_funding_round(&admin, round_id);
```

The round is now `Active` and milestones can be submitted.

### Step 4 — the project submits a milestone

Only the round's `recipient` may call this, and only while the milestone is
`Pending`:

```rust
vault.submit_milestone(&project, round_id, 0);
```

The milestone becomes `Submitted`.

### Step 5 — an Admin verifies

```rust
vault.verify_milestone(&admin, round_id, 0);
```

The milestone becomes `Verified` and the payout amount is computed and stored.
**No tokens move yet.** Emits `milestone_verified(round_id, index, verifier,
amount)`.

### Step 6 — a signer-treasurer releases the funds

```rust
vault.release_round_funds(&treasurer, round_id, 0);
```

The tranche is transferred from the vault to the recipient. When the final
verified milestone is released, the round becomes `Completed`. Emits
`funding_released(round_id, recipient, amount, index, percentage_bps)` and, on
completion, `funding_round_completed(round_id, total_released)`.

### Step 7 — verify state

```rust
let round = vault.get_funding_round(round_id);
// round.status, round.released_amount, round.milestones[i].status
```

---

## 5. Verification and release rules

| Step | Preconditions | Effect |
| --- | --- | --- |
| `verify_milestone` | caller is Admin; round `Active`; index in range; milestone `Submitted` | milestone → `Verified`; amount computed from bps or fixed `amount`; **no transfer** |
| `release_round_funds` | vault not paused; caller is a signer with Admin/Treasurer; round `Active`; index in range; milestone `Verified` | transfers the tranche to the recipient; final release completes the round |

`release_round_funds` checks both signer membership (`NotASigner`, 11) and the
Admin/Treasurer role (`InsufficientRole`, 12). A paused vault rejects the call
before any role check.

---

## 6. Cancellation

```rust
vault.cancel_funding_round(&admin, round_id);
```

- Admin only.
- A round in a terminal state (`Completed` or `Cancelled`) cannot be cancelled.
- Cancelling marks the round `Cancelled` and stamps `finalized_at`.
- Funds are **not** moved: the unreleased balance is already held in the vault,
  so there is no external refund transaction — the escrow simply stays in the
  vault and can be reused by another round.
- Milestones keep their current statuses; the round can no longer be submitted
  to, verified, or released.

Emits `funding_round_cancelled(round_id, canceller)`.

---

## 7. Configuration reference

`FundingRoundConfig` (set with `set_funding_round_config`):

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch. `false` makes `create_funding_round` fail with `InvalidAmount`. |
| `min_milestones` | Fewer milestones than this → `InvalidAmount`. |
| `max_milestones` | More milestones than this → `InvalidAmount`. |
| `min_milestone_amount` | Any milestone below this → `InvalidAmount`. `0` disables the check. |
| `max_rounds_per_proposal` | Stored for policy/UI use. `create_funding_round` in the direct flow does not currently enforce it. |

If no config has ever been written, `get_funding_round_config` returns `None`
and creation is unbounded.

> Governance note: `set_funding_round_config` requires only **one** signer and
> does not go through multisig governance — see
> [GOVERNANCE_CONFIG_CHANGES.md](./GOVERNANCE_CONFIG_CHANGES.md#known-governance-bypasses).
> Treat the config as an operational parameter you keep under review.

---

## 8. Reads and events

Reads:

- `get_funding_round(round_id)` → `FundingRound`
- `get_proposal_funding_rounds(proposal_id)` → `Vec<u64>` (rounds indexed by the
  associated `proposal_id`; the direct-create flow stores `proposal_id = 0`)
- `get_funding_round_config()` → `Option<FundingRoundConfig>`

Events emitted (see [EVENTS.md](../reference/EVENTS.md)):

| Event | Payload |
| --- | --- |
| `funding_round_created` | `round_id, proposal_id, recipient, token, total_amount, milestone_count` |
| `funding_round_approved` | `round_id, approver` |
| `milestone_submitted` | `round_id, milestone_index, submitter` |
| `milestone_verified` | `round_id, milestone_index, verifier, amount` |
| `milestone_rejected` | `round_id, milestone_index, rejector` |
| `funding_released` | `round_id, recipient, amount, milestone_index, percentage_bps` |
| `funding_round_cancelled` | `round_id, canceller` |
| `funding_round_completed` | `round_id, total_released` |

Audit actions `FundingRoundCreated`, `FundingRoundApproved`,
`FundingRoundReleased`, and `FundingRoundCancelled` are also written to the
vault's audit trail.

---

## 9. Errors

Numeric codes live in `contracts/vault/src/errors.rs`.

| Error | Code | Typical cause |
| --- | --- | --- |
| `NotInitialized` | 2 | Vault config missing |
| `NoSigners` | 3 | — |
| `Unauthorized` | 10 | `submit_milestone` called by a non-recipient |
| `NotASigner` | 11 | `release_round_funds` / `set_funding_round_config` by a non-signer |
| `InsufficientRole` | 12 | Caller below Admin/Treasurer (approve, verify, release, cancel) |
| `ProposalNotPending` | 21 | — |
| `InvalidAmount` | 40 | Zero/negative total, empty milestones, amount-sum mismatch, out-of-range milestone count, milestone below the configured minimum, or a `false` config |
| `TimelockNotExpired` | 60 | — |
| `FundingRoundError` | 220 | Percentage milestones not summing to `10_000`, or a mixed fixed/percentage round |
| `InvalidStatusTransition` | 940 | Verifying a non-`Submitted` milestone, releasing a non-`Verified` milestone, or acting on a non-`Active` round |
| `VaultPaused` | 1020 | `release_round_funds` while the vault is paused |

---

## Related

- [Phased treasury disbursements](./PHASED_DISBURSEMENTS.md) — the other
  multi-step payout primitive, for non-milestone bundles
- [Token vesting](./VESTING.md) — time-based, rather than deliverable-based,
  release
- [Governance config changes](./GOVERNANCE_CONFIG_CHANGES.md#known-governance-bypasses)
  — why single-signer setters such as `set_funding_round_config` need review
- [Events reference](../reference/EVENTS.md)
