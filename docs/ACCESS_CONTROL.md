# Access Control & Roles

Ember Vaults implement a sophisticated multi-role access control system with strict validation and separation of concerns.

## Table of Contents

- [Role Overview](#role-overview)
- [Role Descriptions](#role-descriptions)
- [Role Validation](#role-validation)
- [Role Management](#role-management)

## Role Overview

The EmberVault implements five distinct roles, each with specific permissions and responsibilities:

```
┌─────────────────────────────────────────────────────────┐
│                         Owner                           │
│  • Ultimate authority                                   │
│  • Contract upgrades                                    │
│  • Set admin                                            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                         Admin                           │
│  • High-level configuration                             │
│  • Set operator, rate manager                           │
│  • Manage fees, TVL, pause states                       │
│  • Manage sub-accounts                                  │
└───────────┬─────────────────────┬───────────────────────┘
            │                     │
            ▼                     ▼
┌───────────────────────┐ ┌─────────────────────────────┐
│      Operator         │ │     Rate Manager            │
│  • Process withdrawals│ │  • Update vault rate        │
│  • Collect fees       │ │  • Within bounds            │
│  • Sub-account ops    │ │                             │
└───────────────────────┘ └─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────┐
│                    Sub-Accounts                         │
│  • Whitelisted addresses                                │
│  • Receive operator withdrawals                         │
│  • For institutional operations                         │
└─────────────────────────────────────────────────────────┘
```

## Role Descriptions

### 1. Owner

The Owner has ultimate authority over the vault.

**Capabilities:**
- Upgrade the contract implementation (UUPS)
- Set the vault admin
- Transfer ownership

**Restrictions:**
- Cannot be a role holder (admin, operator, rate manager)
- Cannot be a sub-account
- Cannot be blacklisted by protocol

**Set via:**
- `transferOwnership()` (inherited from OwnableUpgradeable)
- `EmberProtocolConfig.updateVaultAdmin()` to set admin

**Key Methods:**
- `_authorizeUpgrade()` - Control upgrades
- Via EmberProtocolConfig: `updateVaultAdmin()`

### 2. Admin

The Admin handles high-level vault configuration.

**Capabilities:**
- Set operator and rate manager
- Configure fee parameters
- Set maximum TVL limits
- Manage pause states for operations
- Add/remove sub-accounts
- Configure rate update intervals

**Restrictions:**
- Cannot be owner
- Cannot hold other roles (operator, rate manager)
- Cannot be a sub-account
- Cannot be blacklisted by protocol

**Set via:**
- `EmberProtocolConfig.updateVaultAdmin()` (by vault owner)

**Key Methods (via EmberProtocolConfig):**
- `updateVaultOperator()`
- `updateVaultRateManager()`
- `updateVaultFeePercentage()`
- `updateVaultMaxTVL()`
- `setVaultSubAccount()`
- `setVaultPausedStatus()`
- `updateVaultRateUpdateInterval()`

### 3. Operator

The Operator manages day-to-day vault operations.

**Capabilities:**
- Process withdrawal requests from queue
- Collect platform fees
- Withdraw funds to whitelisted sub-accounts (without redeeming shares)

**Restrictions:**
- Cannot be owner or admin
- Cannot hold other roles (rate manager)
- Cannot be a sub-account
- Cannot be blacklisted by protocol

**Set via:**
- `EmberProtocolConfig.updateVaultOperator()` (by admin)

**Key Methods:**
- `processWithdrawalRequests()`
- `collectPlatformFee()`
- `withdrawFromVaultWithoutRedeemingShares()`

### 4. Rate Manager

The Rate Manager updates the vault rate within configured bounds.

**Capabilities:**
- Update vault rate
- Subject to rate change limits
- Subject to interval requirements

**Restrictions:**
- Cannot be owner or admin
- Cannot hold other roles (operator)
- Cannot be a sub-account
- Cannot be blacklisted by protocol
- Rate changes bounded by `maxRateChangePerUpdate`
- Updates limited by `rateUpdateInterval`

**Set via:**
- `EmberProtocolConfig.updateVaultRateManager()` (by admin)

**Key Methods:**
- `updateVaultRate()`

**Rate Change Constraints:**
```solidity
// Rate must be within protocol bounds
minRate <= newRate <= maxRate

// Rate change must not exceed maximum allowed
|newRate - oldRate| / oldRate <= maxRateChangePerUpdate

// Sufficient time must have passed since last update
block.timestamp >= lastRateUpdate + rateUpdateInterval
```

### 5. Sub-Accounts

Sub-Accounts are whitelisted addresses for institutional operations.

**Capabilities:**
- Receive withdrawals from operator without share redemption
- Enable liquidity management and strategy deployment

**Restrictions:**
- Cannot be owner
- Cannot hold any role (admin, operator, rate manager)
- Cannot be blacklisted by protocol

**Set via:**
- `EmberProtocolConfig.setVaultSubAccount()` (by admin)

**Use Cases:**
- Trading accounts for active strategy deployment
- DeFi protocol integrations
- Reserve management
- Liquidity provision to external venues

## Role Validation

All role assignments go through strict validation:

### Address Uniqueness
```solidity
// No address can hold multiple roles
if (newOperator == admin || newOperator == rateManager) revert Unauthorized();
if (newAdmin == operator || newAdmin == rateManager) revert Unauthorized();
```

### Owner Separation
```solidity
// Roles cannot be held by owner
if (newAdmin == owner()) revert Unauthorized();
```

### Sub-Account Separation
```solidity
// Roles cannot be sub-accounts
if (roles.subAccounts[newOperator]) revert Unauthorized();
```

### Blacklist Check
```solidity
// No role can be assigned to blacklisted accounts
protocolConfig.verifyAccountNotBlacklisted(newRole);
```

### Zero Address Check
```solidity
// No zero addresses allowed
if (newRole == address(0)) revert ZeroAddress();
```

### Uniqueness Check
```solidity
// New role must differ from current
if (newRole == currentRole) revert SameValue();
```

## Role Management

### Setting Roles

All role changes must go through `EmberProtocolConfig`:

```solidity
// Set admin (by owner)
protocolConfig.updateVaultAdmin(vaultAddress, newAdmin);

// Set operator (by admin)
protocolConfig.updateVaultOperator(vaultAddress, newOperator);

// Set rate manager (by admin)
protocolConfig.updateVaultRateManager(vaultAddress, newRateManager);

// Add sub-account (by admin)
protocolConfig.setVaultSubAccount(vaultAddress, subAccount, true);
```

### Events

Role changes emit events for tracking:

```solidity
event VaultAdminChanged(address indexed oldAdmin, address indexed newAdmin);
event VaultOperatorChanged(address indexed oldOperator, address indexed newOperator);
event VaultRateManagerChanged(address indexed oldRateManager, address indexed newRateManager);
event SubAccountStatusChanged(address indexed account, bool isSubAccount);
```

### Best Practices

1. **Use Multi-Sig for Owner/Admin**
   - Owner and admin should be multi-sig wallets
   - Reduces single point of failure

2. **Separate Hot/Cold Wallets**
   - Owner/Admin: Cold wallets (rarely used)
   - Operator/Rate Manager: Hot wallets (frequent use)

3. **Monitor Role Changes**
   - Subscribe to role change events
   - Alert on unexpected changes

4. **Document Sub-Accounts**
   - Keep registry of all sub-accounts and their purposes
   - Audit regularly

5. **Rate Manager Controls**
   - Use automated system with strict bounds
   - Implement additional off-chain checks

## Emergency Actions

### Pause Operations

Admin can pause specific operations:

```solidity
// Pause deposits
protocolConfig.setVaultPausedStatus(vault, "deposit", true);

// Pause minting
protocolConfig.setVaultPausedStatus(vault, "mint", true);

// Pause withdrawals (redemptions)
protocolConfig.setVaultPausedStatus(vault, "redeem", true);
```

### Protocol-Wide Pause

Owner can pause all non-admin operations:

```solidity
protocolConfig.pauseNonAdminOperations(true);
```

### Upgrade Contract

Owner can upgrade vault implementation:

```solidity
vault.upgradeTo(newImplementation);
```

---

**See Also:**
- [Contract API Reference](./CONTRACTS.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [Deployment Guide](./DEPLOYMENT.md)

