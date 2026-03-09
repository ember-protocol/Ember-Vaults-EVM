# Architecture: Custom Rate-Based ERC-4626 Implementation

> **⚠️ Critical for Integrators:** Ember Vaults use a **custom rate-based share conversion system** that differs from standard ERC-4626 vaults.

## Overview

**This vault implements a custom rate-based conversion system that differs from standard ERC-4626 vaults.** Understanding this is crucial for integrators and users.

## Standard ERC-4626 (Pool-Based)

Most ERC-4626 vaults use a **pool-based** conversion where share value is determined by the ratio of total assets to total supply:

```solidity
// Standard ERC-4626 conversion
shares = assets * totalSupply / totalAssets
assets = shares * totalAssets / totalSupply
```

In this model:
- Share value fluctuates based on vault performance
- `totalAssets()` equals actual token balance
- All shares have equal value

## Ember Vault (Rate-Based)

Ember Vaults use a **fixed-rate conversion** system where each share's value is determined by a configurable rate:

```solidity
// Ember Vault conversion
shares = assets * rate                    // Deposit
assets = shares / rate                    // Withdrawal
totalAssets = totalShares / rate          // Calculated TVL
```

**Key Parameters:**
- `rate`: Fixed-point value (1e18 precision) representing shares per asset
- Example: `rate = 1e18` means 1:1 ratio (1 asset = 1 share)
- Rate can be updated by Rate Manager within configured bounds

## Critical Differences

| Aspect | Standard ERC-4626 | Ember Vault |
|--------|-------------------|-------------|
| **Conversion Basis** | Pool ratio | Fixed rate |
| **Share Value** | Fluctuates with pool performance | Determined by configured rate |
| **totalAssets()** | Actual token balance | **Calculated** from `totalShares / rate` |
| **Rate Updates** | Automatic (based on balance) | Manual (by Rate Manager) |
| **Token Balance** | Always matches totalAssets() | **May differ** due to operator withdrawals |

## Important Implications

### 1. Calculated vs Actual Balance

```solidity
// totalAssets() returns a CALCULATED value
uint256 calculatedTVL = totalAssets();  // Based on shares and rate

// Actual token balance may differ
uint256 actualBalance = IERC20(asset()).balanceOf(vaultAddress);

// Difference occurs when operator withdraws to sub-accounts
uint256 difference = calculatedTVL - actualBalance;
```

### 2. Operator Withdrawals

- Operators can withdraw tokens to whitelisted sub-accounts
- This reduces actual balance but maintains accounting via rate
- Share holders still entitled to full calculated value
- Operator must ensure sufficient liquidity for withdrawals

### 3. Share-Asset Conversion

```solidity
// Depositing 100 USDC with rate = 1e18
uint256 assets = 100 * 1e6;  // 100 USDC (6 decimals)
uint256 shares = assets * rate / 1e18;
// Result: 100 * 1e6 shares

// Withdrawing with same rate
uint256 assetsBack = shares * 1e18 / rate;
// Result: 100 * 1e6 USDC
```

### 4. Rate Management

- Rate can be updated by Rate Manager
- Updates are bounded by `maxRateChangePerUpdate`
- Rate changes affect future deposits/withdrawals
- Existing shares maintain their entitled asset value

## Why This Design?

This rate-based system enables:

- **Institutional Operations**: Operators can deploy funds to trading/DeFi strategies while maintaining accounting
- **Flexible Share Pricing**: Rate adjustments can reflect external performance or strategy changes
- **Capital Efficiency**: Vault can operate with partial reserves while honoring all claims
- **Predictable Conversions**: Share-asset ratio changes only via explicit rate updates, not automatic rebalancing

## Integration Guidelines

When integrating with Ember Vaults:

### 1. Don't Assume Standard Behavior

- Do not rely on `totalAssets()` matching actual token balance
- Do not expect automatic share value appreciation
- Understand rate updates may affect conversion ratios

### 2. Check Available Liquidity

```solidity
uint256 actualBalance = IERC20(asset()).balanceOf(vaultAddress);
// Use actualBalance to determine withdrawal feasibility
```

### 3. Monitor Rate Changes

- Subscribe to `VaultRateUpdated` events
- Rate changes affect deposit/withdrawal calculations
- Existing share holders are not affected by rate changes

### 4. Use Request-Based Withdrawals

- Standard `withdraw()` and `redeem()` are disabled
- Must use `redeemShares()` to create withdrawal request
- Operator processes requests via `processWithdrawalRequests()`

### 5. Understand the Math

```solidity
// All conversions use FixedPointMath (1e18 precision)
// When rate = 1e18: 1 asset unit = 1 share unit
// When rate = 2e18: 1 asset unit = 2 share units (shares worth 0.5 assets each)
```

## Example Scenario

```solidity
// Initial state
rate = 1e18 (1:1 ratio)
actualBalance = 1000 USDC
totalShares = 1000e6
totalAssets() = 1000e6 (calculated: totalShares / rate)

// User deposits 100 USDC
shares_minted = 100e6 * 1e18 / 1e18 = 100e6 shares
totalShares = 1100e6
actualBalance = 1100 USDC
totalAssets() = 1100e6

// Operator withdraws 500 USDC to sub-account for trading
actualBalance = 600 USDC  // Physical balance reduced
totalShares = 1100e6      // Unchanged
totalAssets() = 1100e6    // Still calculated from shares, not balance!

// User requests withdrawal of 100 shares
calculated_assets = 100e6 * 1e18 / 1e18 = 100 USDC
// Withdrawal will succeed if actualBalance >= 100 USDC ✅
```

## Key Takeaways

✅ **Ember uses rate-based conversion**, not pool-based  
✅ **`totalAssets()` is calculated**, may differ from actual balance  
✅ **Operator can withdraw** to sub-accounts for strategies  
✅ **Rate updates are manual** and bounded by parameters  
✅ **Request-based withdrawals** replace instant redemptions  
✅ **Integration requires** understanding these differences  

---

**See Also:**
- [Contract API Reference](./CONTRACTS.md)
- [Access Control & Roles](./ACCESS_CONTROL.md)
- [Deployment Guide](./DEPLOYMENT.md)

