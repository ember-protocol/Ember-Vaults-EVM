# Ember Vaults - EVM Smart Contracts

[![Build Status](https://github.com/fireflyprotocol/ember-vaults-evm-smart-contracts/actions/workflows/ci.yml/badge.svg)](https://github.com/fireflyprotocol/ember-vaults-evm-smart-contracts/actions)
[![Coverage](https://img.shields.io/badge/coverage-97.97%25-brightgreen)](https://github.com/fireflyprotocol/ember-vaults-evm-smart-contracts)

ERC-4626 compliant vaults with advanced features including **custom rate-based share conversion**, request-based withdrawals, multi-role access control, and configurable fee structures.

> **⚠️ Important for Integrators:** Ember Vaults use a **custom rate-based share conversion system** instead of the standard pool-based ERC-4626 conversion. This means `totalAssets()` returns a calculated value that may differ from actual token balance. See [Architecture Documentation](./docs/ARCHITECTURE.md) for full details.

## 📚 Documentation

- **[Architecture Overview](./docs/ARCHITECTURE.md)** - Understanding the custom rate-based ERC-4626 implementation
- **[Contract API Reference](./docs/CONTRACTS.md)** - Complete API documentation for all contracts
- **[Deployment Guide](./docs/DEPLOYMENT.md)** - How to deploy and interact with contracts
- **[Development Guide](./docs/DEVELOPMENT.md)** - Setup, testing, and development workflow
- **[Access Control & Roles](./docs/ACCESS_CONTROL.md)** - Multi-role system and permissions

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
yarn install

# Copy environment template
cp .env.example .env

# Set DEPLOY_ON=hardhat in .env for local development

# Compile contracts
yarn compile

# Run tests
yarn test --network hardhat

# Run with coverage
yarn coverage
```

### Deploy Contracts

```bash
# 1. Deploy protocol configuration
yarn deploy:protocol-config --network sepolia

# 2. Deploy or use existing ERC20 token
yarn deploy:deposit-token --network sepolia

# 3. Deploy vault
yarn deploy:vault --network sepolia
```

See [Deployment Guide](./docs/DEPLOYMENT.md) for detailed instructions and configuration.

## 🏗️ Key Features

### Custom Rate-Based Conversion

Unlike standard ERC-4626 vaults that use pool-based ratios, Ember Vaults use a **fixed-rate conversion system**:

```solidity
// Standard ERC-4626: shares = assets × totalSupply / totalAssets
// Ember Vaults:      shares = assets × rate
```

**Why this matters:**
- `totalAssets()` is **calculated** from shares and rate (not actual balance)
- Operators can withdraw to sub-accounts without redeeming shares
- Rate can be updated by rate manager within bounds
- Enables institutional operations and capital efficiency

📖 **[Read full architecture documentation →](./docs/ARCHITECTURE.md)**

### Request-Based Withdrawals

Standard `withdraw()` and `redeem()` are disabled. Users must:
1. Call `redeemShares()` to create withdrawal request
2. Wait for operator to process via `processWithdrawalRequests()`

### Multi-Role Access Control

- **Owner** - Contract upgrades, set admin
- **Admin** - Configure vault, manage roles
- **Operator** - Process withdrawals, collect fees, manage sub-accounts
- **Rate Manager** - Update vault rate within bounds
- **Sub-Accounts** - Whitelisted addresses for institutional operations

📖 **[Read access control documentation →](./docs/ACCESS_CONTROL.md)**

### Additional Features

- ✅ ERC-4626 compliant with custom rate system
- ✅ UUPS upgradeable proxy pattern
- ✅ Reentrancy protection on all state-changing functions
- ✅ SafeERC20 for all token operations
- ✅ Configurable fee structures
- ✅ Emergency pause capabilities
- ✅ Blacklist mechanism via protocol config
- ✅ Maximum TVL limits
- ✅ Fixed-point math library for precision

## 📁 Repository Structure

```
ember-vaults-evm-smart-contracts/
├── contracts/                              # Solidity smart contracts
│   ├── interfaces/                         # Contract interfaces
│   ├── libraries/                          # Math library (FixedPointMath)
│   ├── testing/                            # Testing contracts
│   ├── EmberVault.sol                      # Main ERC-4626 vault
│   └── EmberProtocolConfig.sol             # Protocol configuration
├── docs/                                   # Documentation
│   ├── ARCHITECTURE.md                     # Rate-based system explained
│   ├── CONTRACTS.md                        # API reference
│   ├── DEPLOYMENT.md                       # Deployment guide
│   ├── DEVELOPMENT.md                      # Development guide
│   └── ACCESS_CONTROL.md                   # Roles and permissions
├── scripts/                                # Deployment & interaction
│   ├── deploy/                             # Deployment scripts
│   └── interact/                           # Interaction scripts
├── test/                                   # Test suite (707 tests, ~98% coverage)
├── deployments/                            # Deployment records
└── README.md                               # This file
```

## 🛠️ Available Scripts

### Development
```bash
yarn compile              # Compile contracts
yarn test                 # Run tests
yarn coverage             # Test coverage
yarn size                 # Check contract sizes
yarn format               # Format code
yarn typecheck            # Type check
```

### Security
```bash
yarn audit:setup          # Setup Slither
yarn audit:slither        # Run static analysis
```

### Deployment
```bash
yarn deploy:protocol-config  # Deploy protocol config
yarn deploy:deposit-token    # Deploy ERC20 token
yarn deploy:vault            # Deploy vault
```

### Interaction
```bash
yarn interact:mint-tokens       # Mint test tokens
yarn interact:deposit-to-vault  # Deposit to vault
```

📖 **[See full development guide →](./docs/DEVELOPMENT.md)**

## 📊 Test Suite

**707 passing tests** covering:

- ✅ Vault deployment and initialization
- ✅ Deposit and mint operations (rate-based)
- ✅ Request-based withdrawals
- ✅ Withdrawal queue processing
- ✅ Fee accrual and collection
- ✅ Rate management and updates
- ✅ Access control and authorization
- ✅ Pause mechanisms
- ✅ Sub-account operations
- ✅ Edge cases and error conditions
- ✅ Protocol configuration
- ✅ ERC-4626 compliance
- ✅ Fixed-point math operations

**Test Coverage:** ~98%

```bash
# Run all tests
yarn test --network hardhat

# Run with coverage
yarn coverage

# View coverage report
open coverage/index.html
```

## 🔐 Security

### Auditing

The protocol has undergone:
- ✅ Static analysis with Slither
- ✅ Internal security reviews
- ✅ Comprehensive test coverage
- ✅ OpenZeppelin best practices

### Security Features

- Reentrancy guards on all state-changing functions
- SafeERC20 for token operations
- Role-based access control with validation
- Emergency pause mechanisms
- Blacklist support
- Rate change limits and intervals
- Custom errors for gas efficiency

### Run Security Analysis

```bash
# Setup Slither
yarn audit:setup

# Run analysis
yarn audit:slither
```

## 📖 Smart Contracts

### EmberVault.sol

Main ERC-4626 compliant vault with custom rate-based conversion system.

**Key Methods:**
- `deposit()` / `mint()` - Deposit assets using rate-based conversion
- `redeemShares()` - Create withdrawal request
- `processWithdrawalRequests()` - Process queued withdrawals (Operator)
- `updateVaultRate()` - Update conversion rate (Rate Manager)
- `collectPlatformFee()` - Collect fees (Operator)

📖 **[Full API reference →](./docs/CONTRACTS.md)**

### EmberProtocolConfig.sol

Protocol-wide configuration and access control.

**Key Methods:**
- `updateVaultAdmin()` / `updateVaultOperator()` / `updateVaultRateManager()`
- `updateVaultMaxTVL()` / `updateVaultFeePercentage()`
- `updateVaultName()` / `updateVaultMinWithdrawableShares()`
- `setBlacklistedAccount()` / `pauseNonAdminOperations()`

📖 **[Full API reference →](./docs/CONTRACTS.md)**

### FixedPointMath Library

Fixed-point arithmetic with 1e18 precision.

**Functions:** `mul()`, `div()`, `divCeil()`, `diffAbs()`, `percentChangeFrom()`


## 🌐 Resources

### Documentation
- [OpenZeppelin Upgrades](https://docs.openzeppelin.com/upgrades-plugins/1.x/)
- [UUPS Pattern](https://eips.ethereum.org/EIPS/eip-1822)
- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Hardhat Documentation](https://hardhat.org/docs)

### Security
- [Slither](https://github.com/crytic/slither)
- [OpenZeppelin Security](https://docs.openzeppelin.com/contracts/5.x/security)

### Ember Protocol
- Website: [ember.so](https://ember.so)
- Support: support@ember.so

## 📄 License

```
This repository is licensed under a Proprietary Smart Contract License held by Ember Protocol Inc.
The source code is published for transparency and verification purposes only and may not be reused,
modified, or redeployed without written permission. For inquiries, contact support@ember.so.
```

## 🤝 Contributing

This is a proprietary codebase. For bug reports or security issues, please contact support@ember.so.

---

**Quick Links:**
- [📐 Architecture](./docs/ARCHITECTURE.md) - Rate-based system explained
- [📘 API Reference](./docs/CONTRACTS.md) - All contract methods
- [🚀 Deployment](./docs/DEPLOYMENT.md) - Deploy and interact
- [💻 Development](./docs/DEVELOPMENT.md) - Setup and testing
- [🔐 Access Control](./docs/ACCESS_CONTROL.md) - Roles and permissions
