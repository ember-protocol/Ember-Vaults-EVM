# EmberETHVault vs EmberVault: Key Differences

> **Canonical reference:** the authoritative, exhaustive version of this document lives next to the contract at [`contracts/EmberETHVault.README.md`](../contracts/EmberETHVault.README.md). This page is a short, accurate summary that points there — kept brief deliberately so the two copies cannot drift apart again. For deployment specifics see [`docs/EmberETHVault.DEPLOYMENT.md`](EmberETHVault.DEPLOYMENT.md).

## What EmberETHVault is

`EmberETHVault` is a specialized vault for ETH/WETH that keeps the same core mechanics as `EmberVault` (rate-based pricing, request-based redemption queue, platform fees, roles/pause, blacklist). The ETH-specific differences:

- **Inheritance:** like `EmberVault`, it inherits `ERC4626Upgradeable` — it is a full ERC-4626 vault (it additionally implements `IBridgeable`). It is **not** a custom ERC-20-only vault.
- **Underlying asset:** **WETH (an ERC-20 token)**, set as the ERC-4626 `asset()` at `initialize` (the address is validated to be a WETH contract via `_isWETH`). The vault holds WETH, not native ETH.
- **Deposits accept both ETH and WETH:**
  - Native ETH — `depositETH(receiver)` and `mintWithETH(shares, receiver)` (both `payable`); the contract wraps the ETH to WETH via `IWETH.deposit{value:}` and emits `ETHWrapped`. `mintWithETH` refunds any excess ETH.
  - Pre-wrapped WETH — the standard ERC-4626 `deposit` / `depositWithPermit` / `mint` / `mintWithPermit`, which pull WETH via `safeTransferFrom`. (These are **not** removed.)
- **Withdrawals (user):** `redeemShares` queues a request; the operator's `processWithdrawalRequests` unwraps WETH to native ETH (`IWETH.withdraw`) and sends **native ETH** to the receiver via `call{value:}` (reverting `ETHTransferFailed` on failure).
- **Withdrawals (operator/non-user):** `withdrawFromVaultWithoutRedeemingShares` (to sub-accounts) and `collectPlatformFee` (to the fee recipient) send **WETH** (not unwrapped).
- **Accounting:** `totalAssets()` is **rate-based** (`convertToAssets(totalSupply())`), not `address(this).balance` or a token balance. `address(this).balance` is never read for TVL.
- **`receive()`:** the contract defines `receive() external payable {}` to accept ETH from `WETH.withdraw()` during unwrap. The body is unrestricted, but because TVL is rate-based, stray ETH does not affect accounting or the share price.
- **Disabled standard functions:** the ERC-4626 `withdraw` / `redeem` revert with `UseRedeemShares()` — users must use the async `redeemShares` flow (same as `EmberVault`).
- **Version:** `version()` returns `"v2.1.0-eth"` (vs `EmberVault`'s `"v2.1.0"`).
- **Admin / rate management / protocol-config integration:** identical to `EmberVault`.

See the canonical document for the full function-by-function mapping, flows, events, and security notes.
