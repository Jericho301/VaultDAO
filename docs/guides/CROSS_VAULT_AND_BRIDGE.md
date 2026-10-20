# Cross-Vault and Bridge Guide

How to coordinate actions across vaults (`set_cross_vault_config`,
`propose_cross_vault`, `execute_cross_vault`) and how to move assets
between vaults/chains (`set_bridge_config`, `propose_bridge_transfer`,
`bridge_to_vault`, `confirm_bridge_receipt`).

## Stability

| Area | Status |
|---|---|
| `set_cross_vault_config`, `propose_cross_vault`, `execute_cross_vault` | **Stable.** Same-vault governance rules apply (threshold, quorum, timelock). |
| `bridge_to_vault`, `confirm_bridge_receipt` (direct vault-to-vault transfer) | **Stable.** Record-based flow with slippage and deadline protection. |
| `set_bridge_config`, `propose_bridge_transfer` (adapter-mediated cross-chain proposals) | **Experimental.** Adapter interface and finality rules may change. |

## Feature flags

Both subsystems are opt-in per vault:

- Cross-vault: `CrossVaultConfig.enabled` (via `set_cross_vault_config`).
  `authorized_coordinators` lists the vault addresses allowed to coordinate
  actions on this vault; `max_action_amount` / `max_actions` bound each
  proposal.
- Bridge: `BridgeConfig.enabled` (via `set_bridge_config`).
  `bridge_adapters` lists the authorized adapter contracts;
  `max_action_amount` / `max_actions` bound each bridge proposal.

Calls are rejected when the corresponding flag is disabled. Both setters are
Admin-only.

## Trust assumptions

1. **Coordinators are trusted counterparties.** A coordinator listed in
   `authorized_coordinators` can propose actions that move this vault's funds
   once local governance approves them. Only list vaults you control or have
   audited agreements with.
2. **Adapters are trusted code.** An adapter in `bridge_adapters` executes
   cross-chain legs on this vault's behalf. A malicious or buggy adapter can
   lose funds in transit; keep the adapter list minimal.
3. **Destination chains are assumed to provide eventual finality.**
   The vault cannot observe the remote chain: receipt must be confirmed
   explicitly (see below). Until `confirm_bridge_receipt` succeeds, in-flight
   funds are at risk and count against exposure limits.
4. **Slippage bounds are the sender's responsibility.** Set `min_received`
   to the worst acceptable outcome; the confirmation step enforces it
   on-chain.

## Adapter interface requirements

An adapter contract used with `propose_bridge_transfer` must:

- expose an execute entrypoint the vault can call with the proposal's
  asset list and destination identifiers;
- report per-asset success/failure so the vault can record
  `execution_results` (`CrossChainProposal`) accurately;
- never take custody beyond the exact amounts in the approved proposal
  (the vault transfers only what governance approved);
- be deterministic and idempotent: re-execution after a partial failure
  must not double-spend a leg that already succeeded.

## Receipt-confirmation flow (`bridge_to_vault` / `confirm_bridge_receipt`)

1. **Initiate.** `bridge_to_vault(caller, target_vault, token, amount,
   min_received, deadline_ledger)` transfers `amount` to `target_vault`,
   stores a `BridgeRecord` (`Initiated`), and returns a `bridge_id`
   (hash of source + target + token + amount + ledger).
2. **Confirm.** After delivery, anyone calls
   `confirm_bridge_receipt(caller, bridge_id, actual_amount)`:
   - if the ledger is past `deadline_ledger`, funds are returned to the
     source vault, the record moves to `Returned`, and confirmation fails
     with `BridgeDeadlineExceeded`;
   - if `actual_amount < min_received`, confirmation fails with
     `BridgeSlippageExceeded` and the record stays `Initiated`
     (funds can be retried or returned);
   - otherwise the record moves to `Completed` with `actual_amount`
     recorded.

## Failure handling

| Failure | Behavior |
|---|---|
| Amount exceeds spending limit / `max_action_amount` | Rejected upfront (`BridgeAmountExceedsLimit`, `InvalidAmount`). |
| `deadline_ledger` already passed at initiation | Rejected (`BridgeDeadlineExceeded`). |
| Confirmation after deadline | Funds auto-returned to source vault; status `Returned`. |
| Slippage (`actual_amount < min_received`) | Confirmation rejected; funds stay in flight until deadline return. |
| Duplicate `bridge_id` | Rejected (`BridgeAlreadyExists`). |
| Unknown `bridge_id` / wrong status | Rejected (`BridgeInvalidId` / `BridgeInvalidStatus`). |
| Partial multi-asset execution (adapter path) | Per-asset `execution_results`; failed legs can be retried without re-executing successful ones. |
| Emergency | `pause` blocks initiation and confirmation; `unpause` resumes. |

## Minimal example

```rust
// 1. Enable cross-vault coordination (admin).
client.set_cross_vault_config(&admin, &CrossVaultConfig {
    enabled: true,
    authorized_coordinators: vec![&env, partner_vault],
    max_action_amount: 10_000,
    max_actions: 5,
});

// 2. Bridge with 2% slippage tolerance and a 500-ledger deadline.
let bridge_id = client.bridge_to_vault(
    &caller, &target_vault, &token,
    &10_000, &9_800, &(&env.ledger().sequence() as u64 + 500),
);

// 3. Confirm receipt once delivered.
client.confirm_bridge_receipt(&caller, &bridge_id, &9_950);
```
