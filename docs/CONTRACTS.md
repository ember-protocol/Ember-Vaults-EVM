# Contract API Reference

Complete API reference for all smart contracts in the Ember Vaults system.

## Table of Contents

- [EmberVault.sol](#embervaultsol)
- [EmberProtocolConfig.sol](#emberprotocolconfigsol)
- [FixedPointMath Library](#fixedpointmath-library)
- [ERC20Token.sol (Testing)](#erc20tokensol-testing)
- [Custom Errors](#custom-errors)

## EmberVault.sol

The main ERC-4626 compliant vault contract that manages deposits, withdrawals, and vault operations. Implements request-based withdrawals with a queue system. Uses UUPS upgradeable pattern.

**Key Features:**
- ERC-4626 compliant vault with ERC20 share tokens
- **Custom rate-based share conversion system** ([see Architecture](./ARCHITECTURE.md))
- Request-based withdrawal system (not instant withdrawals)
- Multi-role access control (Owner, Admin, Operator, Rate Manager)
- Configurable fees and rate management
- Sub-account system for institutional operations
- Emergency pause capabilities
- Uses FixedPointMath library for precise calculations

### ERC-4626 Standard Functions

| Function | Description |
|----------|-------------|
| `deposit(uint256 assets, address receiver)` | Deposits assets and mints shares using **rate-based conversion** (`shares = assets * rate`) |
| `mint(uint256 shares, address receiver)` | Mints exact shares by depositing required assets using **rate-based conversion** (`assets = shares / rate`) |
| `asset()` | Returns the underlying asset token address |
| `totalAssets()` | Returns **calculated** TVL based on `totalShares / rate` (may differ from actual token balance) |
| `convertToShares(uint256 assets)` | Calculates shares using rate-based formula |
| `convertToAssets(uint256 shares)` | Calculates assets using rate-based formula |
| `maxDeposit(address)` | Returns maximum deposit amount (considers maxTVL and pause status) |
| `maxMint(address)` | Returns maximum mintable shares (considers maxTVL and pause status) |
| `previewDeposit(uint256 assets)` | Preview shares for deposit (rate-based) |
| `previewMint(uint256 shares)` | Preview assets for mint (rate-based) |

**⚠️ Important Notes**: 
- Standard `withdraw()` and `redeem()` are **disabled** - use `redeemShares()` instead for request-based withdrawals
- All conversions use the **rate-based system**, not standard pool-based ratios
- See [Architecture](./ARCHITECTURE.md) for details on rate-based implementation

### Internal Conversion Functions

The vault overrides the default ERC-4626 conversion functions to implement rate-based conversion:

| Function | Description |
|----------|-------------|
| `_convertToShares(uint256 assets, Math.Rounding)` | Internal function that converts assets to shares using `shares = assets × rate` |
| `_convertToAssets(uint256 shares, Math.Rounding rounding)` | Internal function that converts shares to assets using `assets = shares ÷ rate` (with ceiling rounding support) |

**Implementation Details:**
- `_convertToShares`: Uses `FixedPointMath.mul(assets, rate)` for rate-based conversion
- `_convertToAssets`: Uses `FixedPointMath.divCeil()` for Ceil rounding (mint operations) and `FixedPointMath.div()` for Down rounding (withdraw operations)
- These override the default OpenZeppelin ERC4626 pool-based conversion formulas
- All public ERC-4626 functions (`convertToShares`, `convertToAssets`, `previewDeposit`, `previewMint`, etc.) use these internal functions

### Custom Withdrawal Operations

| Function | Access | Description |
|----------|--------|-------------|
| `redeemShares(uint256 shares, address receiver)` | Public | Creates a withdrawal request (replaces standard redeem) |
| `cancelPendingWithdrawalRequest(uint256 requestSequenceNumber)` | Public | Cancels a pending withdrawal request |
| `processWithdrawalRequests(uint256 numRequests)` | Operator | Processes withdrawal requests from queue |
| `withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)` | Operator | Withdraws to whitelisted sub-account without redeeming shares |

### View Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `totalAssets()` | uint256 | Returns the current total value locked (TVL) of the vault |
| `getPendingWithdrawal(uint256 index)` | WithdrawalRequest | Gets pending withdrawal request at index |
| `getPendingWithdrawalsLength()` | uint256 | Gets the effective length of the pending withdrawals queue |
| `getAccountState(address accountAddress)` | (uint256, uint256[], uint256[]) | Gets the account state for a given address |
| `vaultName()` | string | Returns the vault name |
| `version()` | string | Returns the contract version |

### Vault Configuration Functions

Called via EmberProtocolConfig only:

| Function | Access | Description |
|----------|--------|-------------|
| `setMaxTVL(address caller, uint256 newMaxTVL)` | Admin | Sets the maximum total value locked |
| `setRateUpdateInterval(address caller, uint256 newInterval)` | Admin | Sets the vault rate update interval |
| `setAdmin(address caller, address newAdmin)` | Owner | Sets the vault admin |
| `setOperator(address caller, address newOperator)` | Admin | Sets the vault operator |
| `setRateManager(address caller, address newRateManager)` | Admin | Sets the vault rate manager |
| `setFeePercentage(address caller, uint256 newFeePercentage)` | Admin | Sets the vault fee percentage |
| `setVaultName(address caller, string calldata newName)` | Admin | Updates the vault name |
| `setMinWithdrawableShares(address caller, uint256 newMinWithdrawableShares)` | Admin | Updates the minimum withdrawable shares amount |
| `setSubAccountStatus(address caller, address account, bool isSubAccount)` | Admin | Sets or removes a sub-account |
| `setPausedStatus(address caller, string memory operation, bool paused)` | Admin | Pauses/unpauses operations |

### Rate Manager Functions

| Function | Description |
|----------|-------------|
| `updateVaultRate(uint256 newRate)` | Updates the vault rate within configured bounds |

### Operator Functions

| Function | Description |
|----------|-------------|
| `collectPlatformFee()` | Collects accrued platform fees and transfers to recipient |
| `processWithdrawalRequests(uint256 numRequests)` | Processes pending withdrawal requests from queue |
| `withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)` | Withdraws to whitelisted sub-account |

---

## EmberProtocolConfig.sol

Protocol-wide configuration contract that stores system parameters and manages blacklisted accounts.

### Configuration Updates (Owner Only)

| Function | Description |
|----------|-------------|
| `pauseNonAdminOperations(bool pauseFlag)` | Pauses or unpauses non-admin operations |
| `updatePlatformFeeRecipient(address recipient)` | Updates where platform fees are sent |
| `updateMinRate(uint256 minRate_)` | Updates the minimum allowable rate |
| `updateMaxRate(uint256 maxRate_)` | Updates the maximum allowable rate |
| `updateDefaultRate(uint256 defaultRate_)` | Updates the default rate applied to new vaults |
| `updateMaxFeePercentage(uint256 maxFeePercentage_)` | Updates the maximum fee percentage |
| `updateMinRateInterval(uint256 minRateInterval_)` | Updates the minimum interval for rate changes |
| `updateMaxRateInterval(uint256 maxRateInterval_)` | Updates the maximum interval for rate changes |
| `setBlacklistedAccount(address account, bool blacklisted)` | Adds or removes an account from the blacklist |

### Vault Admin Functions

Called by vault admin/owner:

| Function | Access | Description |
|----------|--------|-------------|
| `updateVaultMaxTVL(address vault, uint256 newMaxTVL)` | Vault Admin | Updates the maximum TVL of a vault |
| `updateVaultRateUpdateInterval(address vault, uint256 newInterval)` | Vault Admin | Changes the vault rate update interval |
| `updateVaultAdmin(address vault, address newAdmin)` | Vault Owner | Changes the vault admin |
| `updateVaultOperator(address vault, address newOperator)` | Vault Admin | Changes the vault operator |
| `updateVaultRateManager(address vault, address newRateManager)` | Vault Admin | Updates the vault rate manager |
| `updateVaultFeePercentage(address vault, uint256 newFeePercentage)` | Vault Admin | Updates the vault fee percentage |
| `updateVaultName(address vault, string calldata newName)` | Vault Admin | Updates the vault name |
| `updateVaultMinWithdrawableShares(address vault, uint256 newMinWithdrawableShares)` | Vault Admin | Updates the minimum withdrawable shares amount |
| `setVaultSubAccount(address vault, address account, bool isSubAccount)` | Vault Admin | Sets or removes a vault sub-account |
| `setVaultPausedStatus(address vault, string memory operation, bool paused)` | Vault Admin | Sets the pause status for vault operations |

### View Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `getProtocolPauseStatus()` | bool | Returns whether the protocol is paused for non-admins |
| `getPlatformFeeRecipient()` | address | Returns the current platform fee recipient |
| `getMinRate()` | uint256 | Returns the minimum rate |
| `getMaxRate()` | uint256 | Returns the maximum rate |
| `getDefaultRate()` | uint256 | Returns the default rate |
| `getMinRateInterval()` | uint256 | Returns the minimum rate interval |
| `getMaxRateInterval()` | uint256 | Returns the maximum rate interval |
| `getMaxAllowedFeePercentage()` | uint256 | Returns the maximum allowed fee percentage |
| `isAccountBlacklisted(address account)` | bool | Checks if an account is blacklisted |
| `verifyProtocolNotPaused()` | void | Reverts if the protocol is paused |
| `verifyAccountNotBlacklisted(address account)` | void | Reverts if the account is blacklisted |
| `version()` | string | Returns the contract version |

---

## FixedPointMath Library

Fixed-point math library for precise vault calculations. All numbers use uint256 with BASE = 1e18 for fixed-point precision.

**Location:** `contracts/libraries/Math.sol`

### Usage

```solidity
using FixedPointMath for uint256;

uint256 result = value.mul(otherValue);
```

### Library Functions

| Function | Description | Formula |
|----------|-------------|---------|
| `mul(uint256 a, uint256 b)` | Multiplies two values with fixed-point precision | `(a * b) / BASE` |
| `div(uint256 a, uint256 b)` | Divides two values with fixed-point precision | `(a * BASE) / b` |
| `divCeil(uint256 a, uint256 b)` | Divides and rounds up to nearest integer | `ceil(a * BASE / b)` |
| `diffAbs(uint256 a, uint256 b)` | Calculates absolute difference | `\|a - b\|` |
| `percentChangeFrom(uint256 a, uint256 b)` | Calculates percentage change | `\|a - b\| * BASE / a` |

### Constants

- `BASE = 1e18` - Base unit for fixed-point arithmetic

### Notes

- As of v1.5.0, this is a library (not a contract)
- Functions are inlined during compilation for gas efficiency
- No separate deployment required
- All operations include overflow/underflow checks

---

## ERC20Token.sol (Testing)

**Location:** `contracts/testing/ERC20Token.sol`

Upgradeable ERC20 token implementation using UUPS proxy pattern, used for testing purposes.

### Public Functions

| Function | Access | Description |
|----------|--------|-------------|
| `decimals()` | Public | Returns the number of decimals for the token |
| `mint(address to, uint256 amount)` | Owner | Mints tokens to a specified address |
| `burn(address from, uint256 amount)` | Owner | Burns tokens from a specified address |
| `version()` | Public | Returns the contract version |
| `initialize(address initialOwner, string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals, uint256 initialSupply)` | Public | Initializes the token |

**Note:** Also inherits all standard ERC20 functions from OpenZeppelin's ERC20Upgradeable: `transfer`, `transferFrom`, `approve`, `allowance`, `balanceOf`, `totalSupply`.

---

## Custom Errors

The contracts use custom errors for gas-efficient error handling.

### EmberProtocolConfig Errors

| Error | Description |
|-------|-------------|
| `Unauthorized()` | Caller doesn't have required permissions |
| `ZeroAddress()` | Address parameter is zero address |
| `InvalidValue()` | Parameter value is invalid |
| `SameValue()` | New value is same as current value |
| `ProtocolPaused()` | Protocol operations are paused |
| `Blacklisted()` | Account is blacklisted |
| `InvalidInterval()` | Time interval is invalid |
| `InvalidRate()` | Rate value is invalid |
| `InvalidFeePercentage()` | Fee percentage exceeds maximum |
| `ZeroValue()` | Value must be greater than zero |
| `MustHaveZeroSupply()` | Token must have zero supply |

### EmberVault Errors

| Error | Description |
|-------|-------------|
| `OperationPaused()` | Specific operation is paused |
| `InsufficientBalance()` | Account has insufficient balance |
| `InsufficientShares()` | Account has insufficient shares |
| `TransferFailed()` | Token transfer failed |
| `InvalidRequest()` | Request parameters are invalid |
| `MaxTVLReached()` | Vault has reached maximum TVL |
| `ZeroAmount()` | Amount must be greater than zero |
| `IndexOutOfBounds()` | Array index out of bounds |
| `UseRedeemShares()` | Must use redeemShares for withdrawals |

---

**See Also:**
- [Architecture Overview](./ARCHITECTURE.md)
- [Access Control & Roles](./ACCESS_CONTROL.md)
- [Deployment Guide](./DEPLOYMENT.md)
