---
name: security-review
description: Use before opening a PR that touches contract source, and again after every push to it; also when reviewing any change to vault accounting, access control, settlement, upgrade paths or deployment scripts. Runs the built-in security review, then applies the fund-loss checks specific to Ember's vault contracts across Sui, EVM and Solana. Invoke with a diff, a PR number, or no argument for the working tree.
---

# security-review

This is contract code. A defect here is not a bug report — it is a withdrawal, and it is final. The generic pass finds injection and dependency advisories; this pass finds the change that compiles, tests green, reads well in review, and loses money.

Run the built-in `/security-review` first. Then work the checks below and report both together.

## Scope

With no argument, review the working tree against `origin/main`. With a PR number, fetch that head and review it. Out of scope: lockfiles, build artifacts, generated bindings, and vendored dependencies.

## The blast-radius question comes first

Before reading the diff line by line: **if this change is wrong, what is the worst thing that happens, and is it reversible?**

1. **Funds leave to the wrong place, or become permanently unrecoverable.** Wrong recipient, wrong amount, an authority check that does not hold, a withdrawal cancelled that should have settled.
2. **Funds are frozen.** A vault that cannot pay out, a queue that cannot drain, an upgrade path that is now closed.
3. **Accounting drifts but is recoverable.** Rounding in the wrong direction, a rate that can be moved outside its intended bounds.
4. **Griefing and availability.** An action anyone can make fail, unbounded gas or compute.
5. **Everything else.**

Tiers 1 and 2 block a PR. State the tier for every finding.

## 1. Authority

The role set is the same on all three chains: protocol admin, vault admin, operator, rate manager, guardian. The separation is the security model — the operator settles but cannot reprice; the rate manager prices but cannot move funds.

- **Every state-changing entry point asserts exactly one authority**, and it is the least that suffices. A function that gains a second caller class, or loses an assertion, is tier 1 regardless of how it reads.
- **Find the new authority surface.** Any added public/entry/instruction handler is a new door. Ask who can open it and what it reaches.
- **Role transfer.** A single-step transfer to an unverified address is permanent loss of that role. Where a two-step handover exists, check both halves and the state in between — a pending transfer that can be overwritten, or that leaves the old holder active, is a finding.
- **Guardian pause must not be bypassable.** If a paused vault still accepts a path, say which.
- **Timelocks are not uniform.** Sui and EVM delay privileged actions; **the Solana implementation has none** — a privileged change there lands immediately. Any shared tooling or documentation that assumes a delay is wrong on Solana.

## 2. Accounting

- **Rate direction.** Confirm whether the rate is shares-per-collateral or its inverse before touching any arithmetic that uses it. Inverting it is silent, passes a symmetric test, and is total.
- **Rounding direction, and who absorbs the dust.** Every division picks a winner. The vault should absorb dust on both deposit and redemption; a change that rounds in the user's favour on both sides is a slow drain that no single transaction reveals.
- **First-depositor and empty-vault cases.** Zero total supply, zero total assets, and a donation directly to the vault's balance. Share-price inflation is the classic vault attack; check what prevents it.
- **Decimals.** Share and collateral decimals, and any scaling constant, must be read from the asset, never assumed.
- **Overflow and precision.** Intermediate products before division. On Move and Solana, confirm the arithmetic aborts rather than wraps; in Solidity, confirm an `unchecked` block cannot.
- **Deposit slippage.** Sui and Solana take a minimum-shares bound; **EVM does not**, because ERC-4626 fixes the signature. Do not add an API or a doc implying otherwise, and do not remove the bound where it exists — it is the user's only protection against a rate move between signing and landing.

## 3. Settlement and the withdrawal queue

The highest-value area in the codebase, and the one where a plausible-looking improvement does the most damage.

- **A missing or invalid destination account must abort the batch, not skip the request.** Turning an abort into a skip converts a stuck batch into a silent mass cancellation of every withdrawal whose owner closed their token account. It reads in review as robustness. It is tier 1.
- **Batch bounds are on accounts or gas, not on a request count.** Requests from the same owner share accounts, so a fixed request cap under-fills in the common case and over-fills when per-request cost rises. Check what the bound actually is before changing it.
- **FIFO ordering.** Any change that reorders, skips or compacts the queue changes who gets paid and when. Prove the ordering guarantee still holds.
- **Partial settlement.** If a batch can half-apply, every state change must be consistent at the abort point.
- **Cancellation.** Who can cancel, in what states, and what happens to escrowed shares.

## 4. External interaction

- **Reentrancy.** Any external call — a token transfer with a callback, a CPI, a hook — can re-enter. Check state is written before the call, or a guard holds. ERC-777 and ERC-1363 style callbacks, and any transfer to a contract address, count.
- **Token assumptions.** Fee-on-transfer, rebasing, non-standard return values, and blocklist tokens each break a naive `transfer`. On Solana, Token-2022 extensions do the same — confirm the forbidden-extension list still covers transfer fees, transfer hooks, and pausable mints.
- **Associated token accounts depend on the token program.** Classic SPL and Token-2022 derive different addresses for the same owner and mint, so the token program belongs in the derivation, explicitly.
- **Strategy adapters are trusted code paths.** A new adapter is a new trust assumption; say what it can do with the collateral it receives.

## 5. Upgrade safety

- **Storage and layout.** Solidity proxies: no reordering, no type changes, appends only, gap preserved. Move: struct field layout and abilities are part of the compatibility contract. Solana: account layout changes must be migrated or versioned, and `InitSpace` must still match.
- **Run the compatibility check before claiming compatibility.** An upgrade that the loader accepts can still mis-decode existing accounts — acceptance is not compatibility.
- **Event struct layout is a wire contract** with the off-chain indexer. Changing a field's type, order or name breaks decoding downstream even when the upgrade itself is valid. Treat it as a breaking change and name the consumer.
- **Initializers.** A new one must be callable exactly once, and not by anyone.
- **Upgrade authority.** Who holds it, and whether this change moves it.

## 6. Deployment and scripts

- **A script that signs is production tooling.** Check which key it uses, which network it targets, and what happens when those disagree. A network argument that defaults to mainnet is a finding.
- **No key material in source, config, logs or an error.** Keys come from the environment. Check error paths — a signer error that stringifies its input is the usual leak.
- **Deployment records must be written when they change.** A manifest that drifts from chain is how the next operator targets the wrong address.
- **Idempotency.** A script re-run after a partial failure must not double-apply.

## 7. Tests as evidence

A finding is stronger with a test that fails. Before reporting a tier 1 or 2, try to write the case that breaks it — if you cannot, say so and lower your confidence rather than your tier.

Conversely: a PR that changes accounting, authority or settlement and adds no test is itself a finding.

## Output

For each finding: tier, file and line, the defect in one sentence, then the concrete failure scenario — the inputs, state and caller that produce the wrong outcome. Most severe first.

Close with one of:

- `No tier 1 or 2 findings.` plus the lower-tier list, or
- `Blocking: <n> tier 1/2 findings.`

Then name what you checked and what you did not. An unreviewed path is where the next finding is hiding, and a reviewer who finds the gap stops trusting the rest of the report.
