# EmberETHVault vs EmberVault: Key Differences

This document outlines the differences between `EmberETHVault.sol` (specialized ETH vault) and `EmberVault.sol` (standard ERC20 vault).

## Overview

**EmberETHVault** is a specialized vault designed specifically for ETH/WETH deposits. While it maintains the same core vault mechanics as `EmberVault`, it has significant differences in how it handles deposits, withdrawals, and asset storage.

## 1. Inheritance Changes

### EmberVault
```solidity
contract EmberVault is
  Initializable,
  ERC4626Upgradeable,      // ← ERC-4626 standard
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
```

### EmberETHVault
```solidity
contract EmberETHVault is
  Initializable,
  ERC20Upgradeable,        // ← Only ERC20, not ERC4626
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
```

**Why**: ERC-4626 expects ERC20 tokens, but EmberETHVault stores native ETH. We implement a custom vault with ERC-4626-like functions manually.

## 2. Asset Storage

| Aspect | EmberVault | EmberETHVault |
|--------|------------|---------------|
| **Asset Type** | Any ERC20 token | Native ETH only |
| **Storage Method** | ERC20 balance (`IERC20.balanceOf(vault)`) | Native ETH balance (`address(this).balance`) |
| **Deposit Token** | Flexible (set in `collateralToken` param) | Fixed to ETH/WETH |
| **Asset Transfer** | `safeTransfer()` / `safeTransferFrom()` | Native ETH transfers (`call{value: amount}()`) |

## 3. Initialization Parameters

### EmberVault.VaultInitParams
```solidity
struct VaultInitParams {
  string name;
  string receiptTokenSymbol;
  address collateralToken;    // ← Any ERC20 token
  address admin;
  address operator;
  address rateManager;
  uint256 maxRateChangePerUpdate;
  uint256 feePercentage;
  uint256 minWithdrawableShares;
  uint256 rateUpdateInterval;
  uint256 maxTVL;
}
```

### EmberETHVault.VaultInitParams
```solidity
struct VaultInitParams {
  string name;
  string receiptTokenSymbol;
  address wethAddress;        // ← WETH address (not arbitrary token)
  address admin;
  address operator;
  address rateManager;
  uint256 maxRateChangePerUpdate;
  uint256 feePercentage;
  uint256 minWithdrawableShares;
  uint256 rateUpdateInterval;
  uint256 maxTVL;
}
```

**Change**: `collateralToken` → `wethAddress` (fixed to WETH address on mainnet: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`)

## 4. Deposit Functions

### EmberVault - ERC20 Deposits
- `deposit(uint256 assets, address receiver)` - Standard ERC20 deposit
- `depositWithPermit(...)` - ERC20 deposit with permit signature
- `mint(uint256 shares, address receiver)` - Mint exact shares with ERC20
- `mintWithPermit(...)` - Mint with permit signature

### EmberETHVault - ETH/WETH Deposits
- ✅ **NEW**: `depositETH(address receiver) payable` - Deposit native ETH
- ✅ **NEW**: `depositWETH(uint256 assets, address receiver)` - Deposit WETH (auto-unwraps)
- ✅ **NEW**: `depositWETHWithPermit(...)` - Deposit WETH with permit
- ✅ **NEW**: `mintWithETH(uint256 shares, address receiver) payable` - Mint with ETH
- ✅ **NEW**: `mintWithWETH(uint256 shares, address receiver)` - Mint with WETH
- ✅ **NEW**: `mintWithWETHPermit(...)` - Mint with WETH permit
- ❌ **REMOVED**: `deposit()` - No longer exists
- ❌ **REMOVED**: `depositWithPermit()` - Replaced by `depositWETHWithPermit()`
- ❌ **REMOVED**: `mint()` - No longer exists
- ❌ **REMOVED**: `mintWithPermit()` - Replaced by `mintWithWETHPermit()`

## 5. WETH Unwrapping Behavior

When users deposit WETH via `depositWETH()`, `depositWETHWithPermit()`, `mintWithWETH()`, or `mintWithWETHPermit()`:

1. WETH is transferred from user to vault via `safeTransferFrom()`
2. Vault immediately calls `weth.withdraw(assets)` to unwrap WETH → ETH
3. ETH is stored in the vault's native balance
4. Shares are minted based on the ETH amount

**Result**: Vault always holds native ETH, never WETH.

## 6. Withdrawal Functions

### EmberVault
```solidity
function withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)
  // Transfers ERC20 tokens using SafeERC20
  IERC20(asset()).safeTransfer(subAccount, amount);
```

### EmberETHVault
```solidity
function withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)
  // Transfers native ETH
  (bool success, ) = subAccount.call{value: amount}("");
  if (!success) revert ETHTransferFailed();
```

**Change**: All withdrawals send native ETH instead of ERC20 tokens.

### User Withdrawal Processing

In `_processRequest()`:

**EmberVault**:
```solidity
IERC20(asset()).safeTransfer(request.receiver, withdrawAmount);
```

**EmberETHVault**:
```solidity
(bool success, ) = request.receiver.call{value: withdrawAmount}("");
if (!success) revert ETHTransferFailed();
```

## 7. Fee Collection

### EmberVault
```solidity
function collectPlatformFee() external nonReentrant onlyOperator returns (uint256)
  // Transfers ERC20 tokens to fee recipient
  IERC20(asset()).safeTransfer(feeRecipient, feeAmount);
```

### EmberETHVault
```solidity
function collectPlatformFee() external nonReentrant onlyOperator returns (uint256)
  // Transfers native ETH to fee recipient
  (bool success, ) = feeRecipient.call{value: amount}("");
  if (!success) revert ETHTransferFailed();
```

## 8. View Functions

### `totalAssets()`

**EmberVault**:
```solidity
function totalAssets() public view returns (uint256) {
  uint256 shares = totalSupply();
  if (shares == 0) return 0;
  return convertToAssets(shares);  // Rate-based calculation
}
```

**EmberETHVault**:
```solidity
function totalAssets() public view returns (uint256) {
  return address(this).balance;  // Direct ETH balance
}
```

**Change**: ETH vault directly returns contract's ETH balance instead of calculating from shares.

### `asset()`

**EmberVault**:
```solidity
function asset() public view returns (address) {
  // Returns actual collateral token (from ERC4626Upgradeable)
}
```

**EmberETHVault**:
```solidity
function asset() public view returns (address) {
  return address(weth);  // Returns WETH address for interface compatibility
}
```

**Note**: Even though the vault stores ETH, `asset()` returns WETH address for external integrations expecting an ERC20 address.

## 9. Custom Errors

### New Error in EmberETHVault
- `ETHTransferFailed()` - Emitted when native ETH transfer via `call{value}()` fails

### Removed Errors
- `InvalidDepositToken()` - Not needed since deposit token is fixed to ETH/WETH

## 10. State Variables

### Removed from EmberETHVault
- No longer uses `asset()` from ERC4626 (custom implementation)

### Added to EmberETHVault
```solidity
IWETH public weth;  // WETH contract reference
```

### Storage Structure
Both vaults use similar storage layout for:
- `platformFee`, `rate`, `roles`, `pauseStatus`
- `sequenceNumber`, `withdrawalQueueStartIndex`
- `pendingWithdrawals` array
- `accounts` mapping
- `subAccounts` mapping

## 11. Version Identifier

- **EmberVault**: `"v1.1.0"`
- **EmberETHVault**: `"v1.0.0-eth"`

## 12. Admin Functions (via ProtocolConfig)

All admin functions remain **identical** between both vaults:
- `setFeePercentage()`, `setVaultName()`, `setMaxTVL()`
- `setRateUpdateInterval()`, `setMinWithdrawableShares()`
- `setAdmin()`, `setOperator()`, `setRateManager()`
- `setSubAccountStatus()`, `setPausedStatus()`

**Result**: EmberProtocolConfig can manage both vault types using the same interface.

## 13. Withdrawal Request System

Both vaults use **identical** request-based withdrawal systems:
- `redeemShares()` - Create withdrawal request
- `cancelPendingWithdrawalRequest()` - Cancel request
- `processWithdrawalRequests()` - Batch process requests (operator only)
- Queue-based with `pendingWithdrawals` array
- Account tracking with `Account` struct

**Only difference**: ETH vault sends native ETH on processing, not ERC20 tokens.

## 14. Rate Management

**Identical** in both vaults:
- `updateVaultRate()` - Update vault rate (rate manager only)
- Rate-based share conversion using `FixedPointMath` library
- Same validation rules and interval checks

## 15. Removed ERC-4626 Standard Functions

Since `EmberETHVault` doesn't inherit `ERC4626Upgradeable`, these standard ERC-4626 functions are **removed**:

- `withdraw(uint256 assets, address receiver, address owner)` - Already disabled in EmberVault
- `redeem(uint256 shares, address receiver, address owner)` - Already disabled in EmberVault
- `maxWithdraw(address owner)` - Not applicable

These were already disabled in `EmberVault` (reverted with `UseRedeemShares()` error), so no functional change for users.

## 16. ETH Handling Safety

### No Arbitrary ETH Reception
❌ **EmberETHVault does NOT have**:
- `receive() external payable` 
- `fallback() external payable`

**Why**: To prevent accidental or malicious direct ETH transfers that would increase `totalAssets()` without minting shares, breaking vault accounting.

✅ **ETH can only enter via**:
- Proper deposit functions (`depositETH`, `mintWithETH`)
- WETH unwrapping (internal operation)

### ETH Refunds
`mintWithETH()` includes refund logic:
```solidity
if (msg.value > assets) {
  uint256 refund = msg.value - assets;
  (bool success, ) = msg.sender.call{value: refund}("");
  if (!success) revert ETHTransferFailed();
}
```

## 17. Gas Considerations

### EmberETHVault
- ✅ Native ETH transfers are cheaper than ERC20 transfers
- ✅ No ERC20 approval required for ETH deposits
- ⚠️ WETH deposits still require approval (use `depositWETHWithPermit` for gasless)
- ⚠️ Unwrapping WETH → ETH costs additional gas (~5,000 gas per unwrap)

### EmberVault
- Standard ERC20 transfer costs (~35,000-50,000 gas)
- Requires approval before deposit (or use `depositWithPermit`)

## 18. Event Differences

### EmberVault Events
- Standard ERC-4626 and vault events
- `VaultCreated` includes `collateralToken` address

### EmberETHVault Events
- **Modified**: `VaultCreated` now includes `wethAddress` instead of `collateralToken`
- **Removed**: No `ETHReceived` event (vault doesn't accept arbitrary ETH)
- **Removed**: No `WETHUnwrapped` event (implementation detail, redundant with `VaultDeposit`)
- All other events remain identical

## 19. Interface Compatibility

### EmberProtocolConfig Compatibility
✅ Both vaults are **fully compatible** with `EmberProtocolConfig` for admin operations.

### IEmberVault Interface
⚠️ `EmberETHVault` may need interface updates if `IEmberVault` is used for type-safe calls. Key considerations:
- `IEmberVault.asset()` should return WETH address (works)
- Transfer expectations should handle ETH, not ERC20

### External Integrations
- **ERC-4626 Integrations**: ⚠️ May not work correctly since ETH vault doesn't strictly follow ERC-4626 (uses custom deposit functions)
- **DeFi Protocols**: ⚠️ Protocols expecting standard `deposit()` / `mint()` won't work - they need to use ETH-specific functions

## 20. Migration Path

### From EmberVault → EmberETHVault
❌ **Not possible** - These are fundamentally different contracts. You cannot upgrade an existing ERC20 vault to an ETH vault.

### Deployment
Both vaults are deployed identically:
1. Deploy implementation contract
2. Deploy proxy with `initialize()` call
3. Implementation is upgradeable via UUPS

## 21. Security Considerations

### EmberETHVault-Specific Risks
1. **ETH Transfer Failures**: All ETH transfers use low-level `call{value}()` which can fail. Contract properly checks for failures and reverts.
2. **Reentrancy**: Protected by `nonReentrant` modifier on all state-changing functions.
3. **WETH Unwrap**: Assumes WETH contract is legitimate and won't fail on `withdraw()`.

### Shared Security Features
- Same access control (owner, admin, operator, rate manager)
- Same pause mechanisms
- Same blacklist integration
- Same TVL caps
- Same rate-based accounting

## 22. Testing Considerations

### EmberVault Tests
- Mock ERC20 tokens
- Test approvals and transfers
- Test `depositWithPermit()` and `mintWithPermit()`

### EmberETHVault Tests (TODO)
- Test native ETH deposits (`depositETH`, `mintWithETH`)
- Test WETH deposits with unwrapping
- Test ETH transfer failures (use malicious receiver contracts)
- Test ETH refunds in `mintWithETH()`
- Mock WETH contract for testing
- Test that direct ETH sends are rejected

## 23. Function Mapping

### Deposit Functions

| EmberVault | EmberETHVault | Notes |
|------------|---------------|-------|
| `deposit(assets, receiver)` | `depositWETH(assets, receiver)` | WETH version only |
| - | `depositETH(receiver) payable` | **NEW**: Native ETH deposit |
| `depositWithPermit(...)` | `depositWETHWithPermit(...)` | WETH version only |
| `mint(shares, receiver)` | `mintWithWETH(shares, receiver)` | WETH version only |
| - | `mintWithETH(shares, receiver) payable` | **NEW**: Native ETH mint |
| `mintWithPermit(...)` | `mintWithWETHPermit(...)` | WETH version only |

### Withdrawal Functions

| EmberVault | EmberETHVault | Notes |
|------------|---------------|-------|
| `redeemShares(shares, receiver)` | `redeemShares(shares, receiver)` | ✅ Identical signature, sends ETH not ERC20 |
| `cancelPendingWithdrawalRequest(seqNum)` | `cancelPendingWithdrawalRequest(seqNum)` | ✅ Identical |
| `processWithdrawalRequests(numRequests)` | `processWithdrawalRequests(numRequests)` | ✅ Identical signature, sends ETH not ERC20 |
| `withdrawFromVaultWithoutRedeemingShares(subAccount, amount)` | `withdrawFromVaultWithoutRedeemingShares(subAccount, amount)` | ✅ Identical signature, sends ETH not ERC20 |
| `withdraw()` | - | ❌ Removed (was already disabled) |
| `redeem()` | - | ❌ Removed (was already disabled) |

### Admin & View Functions
All admin setters, rate management, and view functions are **identical** between both vaults.

## 24. Summary of Key Differences

| Feature | EmberVault | EmberETHVault |
|---------|------------|---------------|
| **Asset Type** | Any ERC20 | ETH only |
| **Inheritance** | ERC4626Upgradeable | ERC20Upgradeable (custom vault) |
| **Deposit Methods** | 4 (ERC20-based) | 6 (3 ETH, 3 WETH) |
| **Asset Storage** | ERC20 balance | Native ETH balance |
| **Withdrawals** | ERC20 transfers | Native ETH transfers |
| **WETH Handling** | N/A | Auto-unwraps to ETH |
| **ERC-4626 Compliant** | ✅ Yes | ❌ No (custom) |
| **Permit Support** | ✅ Collateral token | ✅ WETH only |
| **Admin Functions** | ✅ Via ProtocolConfig | ✅ Via ProtocolConfig (identical) |
| **Withdrawal Queue** | ✅ Yes | ✅ Yes (identical) |

## 25. When to Use Which Vault

### Use EmberVault when:
- Working with ERC20 tokens (USDC, USDT, DAI, etc.)
- Need ERC-4626 standard compliance
- Integrating with DeFi protocols expecting ERC-4626

### Use EmberETHVault when:
- Working specifically with ETH/WETH
- Want lower gas costs for ETH operations
- Users prefer native ETH deposits
- Need flexibility for both ETH and WETH deposits

## 26. Implementation Notes

### WETH Address
Mainnet WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

### Permit Support
- ⚠️ WETH on mainnet **does NOT support** ERC20 Permit (EIP-2612)
- The `depositWETHWithPermit()` and `mintWithWETHPermit()` functions will **revert** if called
- These functions are included for future compatibility if WETH upgrades or wrapped tokens with permit are used

### Gas Refunds
`mintWithETH()` refunds excess ETH if `msg.value > required assets`. This prevents users from losing ETH due to overpayment.

## 27. Storage Layout Compatibility

Both vaults maintain similar storage layouts for upgradeability:
- 50-slot `__gap` for future variables
- Storage variables ordered consistently
- Mappings and arrays use same patterns

**Important**: EmberVault and EmberETHVault are **separate contracts** and cannot be upgraded into each other. They must be deployed independently.
