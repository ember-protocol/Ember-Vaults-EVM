# EmberETHVault vs EmberVault: Key Differences

This document outlines the differences between `EmberETHVault.sol` (specialized ETH/WETH vault) and `EmberVault.sol` (standard ERC20 vault).

## Overview

**EmberETHVault** is a specialized vault designed for ETH/WETH deposits. It maintains full ERC-4626 compliance by storing WETH as the underlying asset, while providing user-friendly ETH deposit and withdrawal functions.

### Design Philosophy

- **Stores**: WETH (ERC20) - maintains ERC-4626 standard compliance
- **User Deposits**: Accept both native ETH and WETH
  - ETH deposits are automatically wrapped to WETH
  - WETH deposits work like standard ERC4626
- **User Withdrawals**: Send native ETH (WETH unwrapped before sending)
- **Sub-Account Withdrawals**: Send WETH (for DeFi strategy compatibility)
- **Fee Collection**: Sends WETH to fee recipient

## 1. Inheritance

### Both Contracts
```solidity
contract EmberVault is
  Initializable,
  ERC4626Upgradeable,      // ✅ Both inherit ERC4626
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable

contract EmberETHVault is
  Initializable,
  ERC4626Upgradeable,      // ✅ Same inheritance structure
  UUPSUpgradeable,
  OwnableUpgradeable,
  ReentrancyGuardUpgradeable
```

**Result**: Both contracts are fully ERC-4626 compliant.

## 2. Asset Storage

| Aspect | EmberVault | EmberETHVault |
|--------|------------|---------------|
| **Asset Type** | Any ERC20 token | WETH (ERC20) |
| **Storage Method** | ERC20 balance | WETH (ERC20) balance |
| **Deposit Accepts** | Single ERC20 token | ETH **or** WETH |
| **User Withdrawals Send** | ERC20 tokens | Native ETH (unwrapped) |
| **Sub-Account Withdrawals Send** | ERC20 tokens | WETH (not unwrapped) |
| **Fee Collection Sends** | ERC20 tokens | WETH |

## 3. Initialization Parameters

### Both Contracts Use Identical VaultInitParams
```solidity
struct VaultInitParams {
  string name;
  string receiptTokenSymbol;
  address collateralToken;    // Any ERC20 (EmberVault) or WETH (EmberETHVault)
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

**Note**: For EmberETHVault, `collateralToken` must be a WETH contract address.

## 4. Deposit Functions

### EmberVault - ERC20 Deposits Only
- `deposit(uint256 assets, address receiver)` - Standard ERC20 deposit
- `depositWithPermit(...)` - ERC20 deposit with permit signature
- `mint(uint256 shares, address receiver)` - Mint exact shares with ERC20
- `mintWithPermit(...)` - Mint with permit signature

### EmberETHVault - ETH or WETH Deposits
- ✅ `deposit(uint256 assets, address receiver)` - **Standard WETH deposit** (unchanged)
- ✅ `depositWithPermit(...)` - **WETH deposit with permit** (unchanged)
- ✅ `mint(uint256 shares, address receiver)` - **Mint with WETH** (unchanged)
- ✅ `mintWithPermit(...)` - **Mint with WETH permit** (unchanged)
- ✅ **NEW**: `depositETH(address receiver) payable` - Deposit native ETH (wraps to WETH)
- ✅ **NEW**: `mintWithETH(uint256 shares, address receiver) payable` - Mint with ETH (wraps to WETH)

**Key Point**: All standard ERC4626 functions work identically. Additional ETH-specific functions provide convenience.

## 5. ETH Wrapping Behavior

When users call `depositETH()` or `mintWithETH()`:

1. User sends native ETH with transaction
2. Vault calls `IWETH(asset()).deposit{value: amount}()` to wrap ETH → WETH
3. WETH is stored in vault (ERC20 balance)
4. `ETHWrapped` event is emitted
5. Shares are minted based on WETH amount
6. `VaultDeposit` event is emitted

**Result**: Vault holds WETH (ERC20), user gets receipt tokens.

## 6. WETH Unwrapping Behavior

When operator calls `processWithdrawalRequests()`:

1. Shares are burned from vault
2. WETH amount is calculated based on shares and rate
3. **Vault calls `IWETH(asset()).withdraw(amount)` to unwrap WETH → ETH**
4. Native ETH is sent to user via `call{value}()`
5. `RequestProcessed` event is emitted

**Result**: User receives native ETH, not WETH.

## 7. Withdrawal Functions

### User Withdrawals (Receive ETH)

**EmberVault**:
```solidity
function processWithdrawalRequests(uint256 numRequests)
  // Transfers ERC20 tokens to users
  IERC20(asset()).safeTransfer(request.receiver, withdrawAmount);
```

**EmberETHVault**:
```solidity
function processWithdrawalRequests(uint256 numRequests)
  // Unwraps WETH and transfers ETH to users
  IWETH(asset()).withdraw(withdrawAmount);
  (bool success, ) = request.receiver.call{value: withdrawAmount}("");
  if (!success) revert ETHTransferFailed();
```

### Sub-Account Withdrawals (Receive WETH)

**EmberVault**:
```solidity
function withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)
  // Transfers ERC20 tokens
  IERC20(asset()).safeTransfer(subAccount, amount);
```

**EmberETHVault**:
```solidity
function withdrawFromVaultWithoutRedeemingShares(address subAccount, uint256 amount)
  // Transfers WETH (NOT unwrapped)
  IERC20(asset()).safeTransfer(subAccount, amount);
```

**Key Point**: Sub-accounts receive WETH so they can use it in DeFi protocols. Only end-users receive ETH.

## 8. Fee Collection

**EmberVault**:
```solidity
function collectPlatformFee() external returns (uint256)
  // Transfers ERC20 to fee recipient
  IERC20(asset()).safeTransfer(feeRecipient, feeAmount);
```

**EmberETHVault**:
```solidity
function collectPlatformFee() external returns (uint256)
  // Transfers WETH to fee recipient (NOT unwrapped)
  IERC20(asset()).safeTransfer(feeRecipient, amount);
```

**Key Point**: Fee recipient receives WETH, not ETH.

## 9. Custom Events

### New Events in EmberETHVault
```solidity
event ETHWrapped(uint256 amount);  // Emitted when ETH is wrapped to WETH
```

### All Other Events
Identical to EmberVault (same event signatures and parameters, including `VaultCreated`).

## 10. Custom Errors

### New Error in EmberETHVault
- `ETHTransferFailed()` - Emitted when native ETH transfer fails

### All Other Errors
Identical to EmberVault.

## 11. Function Mapping

### Deposit Functions

| Function | EmberVault | EmberETHVault | Notes |
|----------|------------|---------------|-------|
| `deposit(assets, receiver)` | ✅ ERC20 | ✅ WETH | Identical behavior |
| `depositWithPermit(...)` | ✅ ERC20 | ✅ WETH | Identical behavior |
| `mint(shares, receiver)` | ✅ ERC20 | ✅ WETH | Identical behavior |
| `mintWithPermit(...)` | ✅ ERC20 | ✅ WETH | Identical behavior |
| `depositETH(receiver)` | ❌ N/A | ✅ **NEW** | Wraps ETH → WETH, then deposits |
| `mintWithETH(shares, receiver)` | ❌ N/A | ✅ **NEW** | Wraps ETH → WETH, then mints |

### Withdrawal Functions

| Function | EmberVault | EmberETHVault | Notes |
|----------|------------|---------------|-------|
| `redeemShares(shares, receiver)` | ✅ Creates request | ✅ Creates request | Identical (users get ETH when processed) |
| `cancelPendingWithdrawalRequest(seqNum)` | ✅ Cancel | ✅ Cancel | Identical |
| `processWithdrawalRequests(numRequests)` | Sends ERC20 | **Sends ETH** | ETH vault unwraps WETH → ETH |
| `withdrawFromVaultWithoutRedeemingShares()` | Sends ERC20 | **Sends WETH** | Sub-accounts get WETH for DeFi |

### Admin & View Functions
All admin setters, rate management, and view functions are **identical** between both vaults.

## 12. ERC-4626 Compliance

### EmberVault
✅ Fully ERC-4626 compliant with any ERC20 token

### EmberETHVault
✅ Fully ERC-4626 compliant with WETH as the asset

**Important**: 
- `asset()` returns WETH address
- Standard `deposit()` and `mint()` work with WETH
- Additional ETH functions are convenience methods
- All ERC-4626 view functions work correctly

## 13. Internal Deposit Implementation

### Key Difference in `_deposit()`

**EmberVault**:
```solidity
function _deposit(uint256 assets, address receiver, address depositor) internal {
  // ...
  IERC20(asset()).safeTransferFrom(depositor, address(this), assets);
  // ...
}
```

**EmberETHVault**:
```solidity
function _deposit(uint256 assets, address receiver, address depositor) internal {
  // ...
  // Skip transfer if depositor is vault itself (for ETH wrapping case)
  if (depositor != address(this)) {
    IERC20(asset()).safeTransferFrom(depositor, address(this), assets);
  }
  // ...
}
```

**Why**: When `depositETH()` is called, vault wraps ETH to WETH first, then calls `_deposit()` with `depositor = address(this)`. This prevents the vault from trying to transfer from itself.

## 14. Wrapping/Unwrapping Flow Diagrams

### Deposit ETH Flow
```
User sends ETH
    ↓
depositETH() called
    ↓
IWETH.deposit{value: msg.value}() 
    ↓ [ETH → WETH conversion]
Vault now holds WETH
    ↓
_deposit(amount, receiver, address(this))
    ↓
Shares minted to receiver
    ↓
emit VaultDeposit
```

### Withdraw ETH Flow (User)
```
User calls redeemShares()
    ↓
Shares transferred to vault
    ↓
Request queued
    ↓
Operator calls processWithdrawalRequests()
    ↓
Shares burned
    ↓
IWETH.withdraw(amount)
    ↓ [WETH → ETH conversion]
Vault holds ETH temporarily
    ↓
ETH sent to user via call{value}()
    ↓
emit RequestProcessed
```

### Withdraw WETH Flow (Sub-Account)
```
Operator calls withdrawFromVaultWithoutRedeemingShares()
    ↓
WETH transferred to sub-account
    ↓ [NO unwrapping]
Sub-account receives WETH
    ↓
emit VaultWithdrawalWithoutRedeemingShares
```

## 15. Why This Design?

### ERC-4626 Compliance
✅ **Maintains standard compliance** - WETH is an ERC20 token, so the vault is a proper ERC4626 vault
✅ **Interoperability** - Can integrate with DeFi protocols expecting ERC4626
✅ **Composability** - Standard interfaces work without custom logic

### User Experience
✅ **ETH Deposits** - Users can deposit native ETH without wrapping manually
✅ **ETH Withdrawals** - Users receive native ETH (more intuitive than WETH)
✅ **Flexibility** - Users can choose ETH or WETH deposit methods

### Sub-Account Strategy Execution
✅ **WETH for DeFi** - Sub-accounts receive WETH which is widely supported in DeFi
✅ **No Unwrapping Cost** - Sub-accounts don't pay gas to unwrap if they need WETH anyway
✅ **Standard ERC20** - Can use WETH with any protocol expecting ERC20

## 16. Gas Considerations

### ETH Deposits
| Operation | EmberVault | EmberETHVault |
|-----------|------------|---------------|
| **Wrap ETH** | User does manually (~45k gas) | Vault does automatically (~45k gas) |
| **Approve** | Required (~45k gas) | Not required for ETH deposits |
| **Deposit** | ~100k gas | ~100k gas |
| **Total** | ~190k gas (2 tx) | ~145k gas (1 tx) |

**Savings**: EmberETHVault saves gas and reduces friction for ETH deposits.

### WETH Deposits
Identical gas costs - both use standard ERC20 transfers.

### Withdrawals to Users
| Operation | EmberVault | EmberETHVault |
|-----------|------------|---------------|
| **Process Request** | ~80k gas | ~90k gas |
| **Unwrap WETH** | N/A | Included |
| **Transfer** | ERC20 | Native ETH (~2.1k gas) |

**Cost**: EmberETHVault adds ~10k gas per withdrawal for unwrapping.

### Withdrawals to Sub-Accounts
Identical - both send ERC20 tokens (WETH in EmberETHVault case).

## 17. WETH Addresses

### Mainnet
```
WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
```

### Testnet (Use MockWETH)
Deploy `MockWETH.sol` for testing:
```bash
yarn deploy:mock-weth --network sepolia
```

## 18. Deployment Differences

### EmberVault Deployment
```bash
export VAULT_COLLATERAL_TOKEN="0x..."  # Any ERC20
yarn deploy:vault --network <network>
```

### EmberETHVault Deployment
```bash
export VAULT_COLLATERAL_TOKEN="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"  # Must be WETH
yarn deploy:eth-vault --network <network>
```

**Important**: EmberETHVault uses the same `collateralToken` parameter but it must be a WETH contract address.

## 19. Usage Examples

### Example 1: User Deposits ETH

```typescript
const ethVault = await ethers.getContractAt("EmberETHVault", vaultAddress);

// User sends ETH (automatically wrapped to WETH internally)
const tx = await ethVault.depositETH(user.address, {
  value: ethers.parseEther("1.0")
});

// Vault now holds WETH
const vaultWETHBalance = await weth.balanceOf(vaultAddress);
console.log("Vault WETH:", ethers.formatEther(vaultWETHBalance)); // 1.0

// User has shares
const userShares = await ethVault.balanceOf(user.address);
console.log("User shares:", ethers.formatEther(userShares));
```

### Example 2: User Deposits WETH (Standard ERC4626)

```typescript
const weth = await ethers.getContractAt("IWETH", wethAddress);
const ethVault = await ethers.getContractAt("EmberETHVault", vaultAddress);

// Standard ERC4626 deposit flow (no difference from EmberVault)
await weth.approve(vaultAddress, ethers.parseEther("1.0"));
await ethVault.deposit(ethers.parseEther("1.0"), user.address);
```

### Example 3: User Withdraws (Receives ETH)

```typescript
// Request redemption
await ethVault.approve(vaultAddress, shares);
await ethVault.redeemShares(shares, user.address);

// Operator processes (user receives ETH, not WETH)
const userETHBefore = await ethers.provider.getBalance(user.address);

await ethVault.connect(operator).processWithdrawalRequests(1);

const userETHAfter = await ethers.provider.getBalance(user.address);
console.log("ETH received:", ethers.formatEther(userETHAfter - userETHBefore));
```

### Example 4: Sub-Account Receives WETH

```typescript
// Operator withdraws to sub-account (receives WETH)
await ethVault.connect(operator).withdrawFromVaultWithoutRedeemingShares(
  subAccount,
  ethers.parseEther("10.0")
);

// Sub-account has WETH (not ETH)
const subAccountWETH = await weth.balanceOf(subAccount);
console.log("Sub-account WETH:", ethers.formatEther(subAccountWETH)); // 10.0

// Sub-account can use WETH in DeFi protocols
await weth.connect(subAccountSigner).approve(defiProtocol, amount);
await defiProtocol.stake(amount);
```

## 20. When to Use Which Vault

### Use EmberVault when:
- Working with standard ERC20 tokens (USDC, USDT, DAI, etc.)
- Token is not ETH/WETH
- Users prefer the native token format

### Use EmberETHVault when:
- Working specifically with ETH/WETH
- Want to accept both ETH and WETH deposits
- Users prefer native ETH for withdrawals
- Sub-accounts need WETH for DeFi strategies

## 21. Testing Considerations

### Additional Tests for EmberETHVault

1. **ETH Wrapping**
   - Test `depositETH()` wraps correctly
   - Test `mintWithETH()` wraps correctly
   - Verify vault holds WETH after ETH deposit
   - Test ETH refunds in `mintWithETH()`

2. **WETH Unwrapping**
   - Test user withdrawals receive ETH (not WETH)
   - Test failed ETH transfers revert properly
   - Verify vault WETH balance decreases correctly

3. **Sub-Account WETH**
   - Test sub-accounts receive WETH (not ETH)
   - Verify no unwrapping for sub-account withdrawals

4. **Standard ERC4626**
   - Test `deposit()` and `mint()` work with WETH
   - Test `depositWithPermit()` and `mintWithPermit()` work
   - Verify all view functions match ERC4626 spec

5. **Mixed Deposits**
   - Deposit ETH, then WETH, verify accounting
   - Test multiple users with different deposit methods

## 22. Limitations & Considerations

### WETH Permit Support
⚠️ **Real WETH on mainnet does NOT support ERC20 Permit (EIP-2612)**

- `depositWithPermit()` and `mintWithPermit()` will **revert** on mainnet WETH
- These functions work with MockWETH on testnet (which has permit)
- Users must use standard approve + deposit flow on mainnet

### ETH Transfer Failures
If a user's address cannot receive ETH (e.g., contract without payable function), `processWithdrawalRequests()` will:
- Revert for that specific request
- Mark it as "skipped"
- Return shares to owner
- Operator can retry later

### Contract Must Hold ETH for Unwrapping
The vault needs to be able to receive ETH when unwrapping WETH. This is safe because:
- No `receive()` or `fallback()` functions that accept arbitrary ETH
- ETH only enters via WETH unwrapping (controlled operation)
- ETH is immediately sent to users (not stored)

## 23. Security Considerations

### Identical to EmberVault
- Same access control mechanisms
- Same pause mechanisms
- Same blacklist integration
- Same rate-based accounting
- Same reentrancy protection

### ETH-Specific Security
1. **ETH Transfer Failures**: Handled with proper error checking
2. **WETH Contract Trust**: Assumes WETH contract is legitimate (standard mainnet WETH is well-audited)
3. **No Arbitrary ETH**: Contract cannot receive ETH except from WETH unwrapping

## 24. Admin Functions (via ProtocolConfig)

All admin functions are **100% identical** between EmberVault and EmberETHVault:

- `setFeePercentage()`, `setVaultName()`, `setMaxTVL()`
- `setRateUpdateInterval()`, `setMinWithdrawableShares()`
- `setAdmin()`, `setOperator()`, `setRateManager()`
- `setSubAccountStatus()`, `setPausedStatus()`

**Result**: EmberProtocolConfig can manage both vault types identically.

## 25. Upgrade Compatibility

### From EmberVault → EmberETHVault
❌ **Not possible** - Different underlying assets (arbitrary ERC20 vs WETH)

### EmberETHVault Upgrades
✅ **Fully upgradeable** using UUPS pattern
- Can add new features
- Can optimize existing functions
- Cannot change underlying asset (WETH) without migration

## 26. Integration Guide

### For Frontend/UI
```typescript
// Detect if vault is ETH vault
const asset = await vault.asset();
const isETHVault = asset.toLowerCase() === WETH_ADDRESS.toLowerCase();

if (isETHVault) {
  // Show both ETH and WETH deposit options
  // Show "You will receive ETH" on withdrawal UI
} else {
  // Show single token deposit option
  // Show token name on withdrawal UI
}
```

### For DeFi Integration
```typescript
// Standard ERC4626 integration works for both vaults
const vault = await ethers.getContractAt("IERC4626", vaultAddress);

// These work identically
await token.approve(vaultAddress, amount);
await vault.deposit(amount, receiver);

// View functions work identically
const totalAssets = await vault.totalAssets();
const sharePrice = await vault.convertToAssets(ethers.parseEther("1.0"));
```

## 27. Summary of Key Differences

| Feature | EmberVault | EmberETHVault |
|---------|------------|---------------|
| **Asset Stored** | Any ERC20 | WETH (ERC20) |
| **ERC-4626 Compliant** | ✅ Yes | ✅ Yes |
| **Deposit Methods** | 4 (ERC20 only) | 6 (4 WETH + 2 ETH) |
| **User Deposits** | ERC20 | ETH or WETH |
| **User Withdrawals** | ERC20 | **ETH** (unwrapped) |
| **Sub-Account Withdrawals** | ERC20 | **WETH** (not unwrapped) |
| **Fee Collection** | ERC20 | WETH |
| **Admin Functions** | ✅ Via ProtocolConfig | ✅ Via ProtocolConfig (identical) |
| **Withdrawal Queue** | ✅ Yes | ✅ Yes (identical) |
| **Rate-Based Conversion** | ✅ Yes | ✅ Yes (identical) |

## 28. Code Size Comparison

- **EmberVault**: ~1,834 lines
- **EmberETHVault**: ~900 lines (much simpler!)

**Why smaller?**: EmberETHVault reuses most EmberVault logic. Only changes are:
- ETH wrapping in deposits
- WETH unwrapping in user withdrawals
- Modified `_deposit()` to handle vault-as-depositor case

## 29. Testing Checklist

Before mainnet deployment, test:

- [ ] Deploy MockWETH on testnet
- [ ] Deploy EmberETHVault with MockWETH
- [ ] Test `depositETH()` - verify WETH balance increases
- [ ] Test `depositWETH()` - verify works like standard vault
- [ ] Test `mintWithETH()` - verify refunds work
- [ ] Test `depositWithPermit()` - verify permit works (MockWETH only)
- [ ] Test withdrawal processing - verify users receive ETH
- [ ] Test sub-account withdrawals - verify they receive WETH
- [ ] Test fee collection - verify fee recipient gets WETH
- [ ] Test all admin functions via ProtocolConfig
- [ ] Test pause mechanisms
- [ ] Test rate updates
- [ ] Verify contract on Etherscan
- [ ] Test with different user scenarios

## 30. Migration from Standard Vault

If you have an existing EmberVault and want to create an ETH version:

1. **Deploy new EmberETHVault** (cannot upgrade existing vault)
2. **Migrate users manually** (optional):
   - Users withdraw from old vault
   - Users deposit to new ETH vault
3. **Update integrations** to point to new vault address
4. **Update documentation** to reflect ETH vault availability

## 31. Best Practices

### For Users
- ✅ Use `depositETH()` for simplicity (no approval needed)
- ✅ Use `depositWithPermit()` with MockWETH on testnet for gasless approvals
- ✅ Expect to receive ETH on withdrawal (not WETH)

### For Sub-Accounts
- ✅ Expect to receive WETH (not ETH)
- ✅ Can use WETH directly in DeFi protocols
- ✅ Can unwrap to ETH manually if needed

### For Operators
- ✅ Process withdrawals when users request
- ✅ Ensure vault has sufficient WETH balance before processing
- ✅ Monitor ETH transfer failures and retry if needed
- ✅ Collect fees regularly (receives WETH)

### For Admins
- ✅ Set appropriate TVL caps considering ETH volatility
- ✅ Monitor vault utilization
- ✅ Adjust fees via ProtocolConfig
- ✅ Ensure sub-accounts are properly whitelisted
