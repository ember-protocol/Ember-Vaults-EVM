# EmberETHVault Deployment Guide

Complete guide for deploying EmberETHVault on testnet and mainnet.

## Overview

**EmberETHVault** is an ERC-4626 compliant vault that:
- Stores WETH (ERC20) as the underlying asset
- Accepts both native ETH and WETH deposits
- Wraps ETH → WETH on deposit
- Unwraps WETH → ETH on user withdrawals
- Sends WETH (not ETH) to sub-accounts

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Testnet Deployment](#testnet-deployment)
3. [Mainnet Deployment](#mainnet-deployment)
4. [Verification](#verification)
5. [Testing](#testing)

## Prerequisites

### 1. Protocol Config Deployed
EmberETHVault requires EmberProtocolConfig to be deployed first.

```bash
# Check if protocol config exists
cat deployments/<network>-deployment.json | grep protocolConfig

# If not deployed, deploy it first
yarn deploy:protocol-config --network <network>
```

### 2. WETH Contract Address

#### Mainnet
Use real WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

⚠️ **Important**: Real WETH does NOT support ERC20 Permit on mainnet.

#### Testnet
Deploy MockWETH for testing (includes permit support):
```bash
yarn deploy:mock-weth --network sepolia
```

### 3. Environment Configuration

Create or update `.env` file with required variables:

```bash
# Network Configuration
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
PRIVATE_KEY=your_private_key_here

# Etherscan (for verification)
ETHERSCAN_API_KEY=your_etherscan_key

# Vault Configuration
VAULT_NAME="Ember ETH Vault"
VAULT_RECEIPT_TOKEN_SYMBOL="eETH"
VAULT_WETH_ADDRESS="0x..."  # See above
VAULT_ADMIN="0x..."
VAULT_OPERATOR="0x..."
VAULT_RATE_MANAGER="0x..."

# Optional (with defaults)
VAULT_OWNER="0x..."                      # Defaults to deployer
VAULT_MAX_RATE_CHANGE="10000000000000000"     # 1% (0.01e18)
VAULT_FEE_PERCENTAGE="1000000000000000"       # 0.1% (0.001e18)
VAULT_MIN_WITHDRAWABLE_SHARES="1000000"       # 1e6
VAULT_RATE_UPDATE_INTERVAL="3600001"          # 1 hour in ms
VAULT_MAX_TVL="1000000000000000000000000000000"  # 1e30 (very large)
VAULT_SUB_ACCOUNTS="0x...,0x..."              # Comma-separated
```

## Testnet Deployment

### Step 1: Deploy MockWETH

```bash
yarn deploy:mock-weth --network sepolia
```

**Output:**
```
✅ MockWETH deployed to: 0x1234...
📦 Deployed in block: 5432109
```

Copy the MockWETH address for next step.

### Step 2: Set Environment Variables

```bash
export VAULT_NAME="Ember ETH Vault"
export VAULT_RECEIPT_TOKEN_SYMBOL="eETH"
export VAULT_WETH_ADDRESS="0x1234..."  # From step 1
export VAULT_ADMIN="0xYourAdminAddress"
export VAULT_OPERATOR="0xYourOperatorAddress"
export VAULT_RATE_MANAGER="0xYourRateManagerAddress"

# Optional: Set sub-accounts
export VAULT_SUB_ACCOUNTS="0xSubAccount1,0xSubAccount2"
```

### Step 3: Deploy EmberETHVault

```bash
yarn deploy:eth-vault --network sepolia
```

**Output:**
```
✅ EmberETHVault Proxy deployed to: 0x5678...
📝 Implementation address: 0x9abc...
📌 Contract version: v1.0.0-eth
```

### Step 4: Verify Deployment

```bash
# Check deployment file
cat deployments/sepolia-deployment.json

# Should contain:
{
  "contracts": {
    "protocolConfig": { ... },
    "depositTokens": {
      "WETH": {
        "address": "0x1234...",
        "isMock": true,
        "supportsPermit": true
      }
    },
    "ethVaults": {
      "emberEthVault": {
        "proxyAddress": "0x5678...",
        "wethAddress": "0x1234...",
        "version": "v1.0.0-eth"
      }
    }
  }
}
```

### Step 5: Test Basic Operations

```bash
# Use hardhat console
npx hardhat console --network sepolia

# In console:
const vault = await ethers.getContractAt("EmberETHVault", "0x5678...");
const weth = await ethers.getContractAt("MockWETH", "0x1234...");

// Test ETH deposit (wraps to WETH)
await vault.depositETH(deployer.address, { value: ethers.parseEther("0.1") });

// Check shares
console.log("Shares:", await vault.balanceOf(deployer.address));

// Verify vault holds WETH (ETH was wrapped)
console.log("WETH in vault:", await weth.balanceOf(vault.address));
```

## Mainnet Deployment

### Step 1: Validate Configuration

```bash
# Use real WETH address on mainnet
export VAULT_WETH_ADDRESS="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

# Verify all addresses are correct
echo "WETH Address: $VAULT_WETH_ADDRESS"
echo "Admin: $VAULT_ADMIN"
echo "Operator: $VAULT_OPERATOR"
echo "Rate Manager: $VAULT_RATE_MANAGER"
echo "Owner: $VAULT_OWNER"
```

### Step 2: Deploy to Mainnet

```bash
# ⚠️ CAUTION: This will deploy to mainnet and cost real ETH!
yarn deploy:eth-vault --network mainnet
```

### Step 3: Verify on Etherscan

```bash
# Verify proxy
npx hardhat verify --network mainnet <PROXY_ADDRESS>

# Verify implementation
npx hardhat verify --network mainnet <IMPLEMENTATION_ADDRESS>
```

### Step 4: Security Checklist

Before depositing real funds:

- [ ] Verify all role addresses (admin, operator, rate manager)
- [ ] Verify protocol config address is correct
- [ ] Verify WETH address is correct mainnet WETH
- [ ] Verify max TVL is appropriate
- [ ] Verify fee percentage is correct
- [ ] Verify rate update interval is correct
- [ ] Test with small amount first
- [ ] Verify contract on Etherscan
- [ ] Audit deployment transaction
- [ ] Check sub-accounts are whitelisted correctly

## Post-Deployment Configuration

### 1. Initial Rate Setup

The vault is initialized with the default rate from ProtocolConfig. To set a custom initial rate:

```bash
# As rate manager
npx hardhat run scripts/interact/update-vault-rate.ts --network <network>
```

### 2. Configure Sub-Accounts

If you need to add/remove sub-accounts after deployment:

```typescript
// Via ProtocolConfig as admin
await protocolConfig.setVaultSubAccount(
  vaultAddress,
  subAccountAddress,
  true  // true = add, false = remove
);
```

### 3. Test Deposits

Test all deposit methods:

```bash
# Native ETH deposit (wraps to WETH internally)
await vault.depositETH(receiver, { value: ethers.parseEther("0.01") });

# Standard WETH deposit (ERC4626 compatible)
await weth.approve(vaultAddress, amount);
await vault.deposit(amount, receiver);

# Verify vault stores WETH
console.log("WETH:", await weth.balanceOf(vaultAddress));
```

### 4. Set Up Monitoring

Monitor key events:
- `VaultDeposit` - Track all deposits (both ETH and WETH)
- `ETHWrapped` - Track when ETH is converted to WETH
- `RequestRedeemed` - Track withdrawal requests
- `RequestProcessed` - Track processed withdrawals (users receive ETH)
- `VaultRateUpdated` - Track rate changes
- `VaultPlatformFeeCollected` - Track fee collection (recipient gets WETH)

## Common Issues

### Issue: "Invalid interval" during initialization
**Cause**: Rate update interval outside protocol bounds  
**Solution**: Check `protocolConfig.getMinRateInterval()` and `getMaxRateInterval()`

### Issue: "Deployment at address X is not registered"
**Cause**: Using `upgrades.upgradeProxy()` with manually deployed implementation  
**Solution**: Use upgrade scripts in `scripts/upgrade/` which handle manual deployment

### Issue: WETH permit fails on mainnet
**Cause**: Real WETH doesn't support permit  
**Solution**: Use standard approve + depositWETH, or use depositETH instead

### Issue: Contract size too large
**Cause**: Too many features or debug code  
**Solution**: Remove unused functions, optimize code, use external libraries

## Upgrade Path

EmberETHVault is upgradeable via UUPS pattern:

```bash
# 1. Make changes to EmberETHVault.sol

# 2. Test upgrade on testnet first
yarn upgrade:eth-vault --network sepolia

# 3. Generate multisig transaction for mainnet
yarn upgrade:eth-vault:generate-tx --network mainnet

# 4. Submit to multisig (if owner is multisig)
```

## Security Best Practices

### Before Mainnet Deployment
1. ✅ Complete test suite passing
2. ✅ Testnet deployment successful
3. ✅ External audit (recommended for large TVL)
4. ✅ Rate limiting appropriate
5. ✅ Fee parameters validated
6. ✅ All role addresses are secure (multisig preferred)

### After Mainnet Deployment
1. ✅ Verify source code on Etherscan
2. ✅ Test with small amounts first
3. ✅ Monitor events and transactions
4. ✅ Set up alerts for large deposits/withdrawals
5. ✅ Prepare emergency pause procedures
6. ✅ Document operator runbooks

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Users                               │
│                                                             │
│  Deposit ETH ──┐                    ┌── Withdraw ETH       │
│                │                    │   (unwrapped)        │
│  Deposit WETH ─┤                    ├── Request redemption │
│                │                    │                      │
└────────────────┼────────────────────┼──────────────────────┘
                 │                    │
                 ▼                    ▼
         ┌───────────────────────────────────────┐
         │      EmberETHVault Proxy              │
         │  ┌─────────────────────────────────┐  │
         │  │  EmberETHVault Implementation   │  │
         │  │  (ERC4626Upgradeable)           │  │
         │  │                                 │  │
         │  │  Deposits:                      │  │
         │  │  • ETH → Wrap to WETH          │  │
         │  │  • WETH → Store directly       │  │
         │  │                                 │  │
         │  │  Storage: WETH (ERC20)         │  │
         │  │                                 │  │
         │  │  Withdrawals:                   │  │
         │  │  • Users: WETH → Unwrap to ETH │  │
         │  │  • Sub-accounts: WETH (ERC20)  │  │
         │  └─────────────────────────────────┘  │
         └─────────┬─────────────────────────────┘
                   │
                   │ WETH withdrawals
                   │ (no unwrapping)
                   ▼
         ┌─────────────────────┐
         │   Sub-Accounts      │
         │                     │
         │ • Receive WETH      │
         │ • Use in DeFi       │
         └─────────────────────┘

         ┌─────────────────────────┐
         │ EmberProtocolConfig     │
         │                         │
         │ • updateVaultFee()      │
         │ • setVaultSubAccount()  │
         │ • updateVaultMaxTVL()   │
         └─────────────────────────┘

External Contracts:
┌──────────────────┐
│ WETH Contract    │
│                  │
│ deposit() ←───── ETH wrapping
│ withdraw() ←──── ETH unwrapping
└──────────────────┘
```

## File Structure

```
contracts/
  ├── EmberETHVault.sol          # Main ETH vault contract
  ├── interfaces/
  │   ├── IWETH.sol              # WETH interface
  │   └── IEmberProtocolConfig.sol
  └── test/
      └── MockWETH.sol           # Testing WETH implementation

scripts/
  ├── deploy/
  │   ├── mock-weth.ts           # Deploy MockWETH
  │   └── ember-eth-vault.ts     # Deploy EmberETHVault
  └── upgrade/
      └── eth-vault.ts           # (TODO) Upgrade script

docs/
  ├── EmberETHVault.README.md    # Main differences doc
  └── EmberETHVault.DEPLOYMENT.md # This file
```

## Resources

- [EmberETHVault vs EmberVault Differences](../contracts/EmberETHVault.README.md)
- [MockWETH Documentation](../contracts/test/MockWETH.README.md)
- [WETH on Etherscan](https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2)
- [EIP-2612: Permit Extension](https://eips.ethereum.org/EIPS/eip-2612)
