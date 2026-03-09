# Ember Vaults Documentation

Welcome to the Ember Vaults documentation! This directory contains comprehensive guides for understanding, deploying, and developing with Ember Vaults.

## 📚 Documentation Structure

### [Architecture Overview](./ARCHITECTURE.md)
**Understanding the Custom Rate-Based ERC-4626 Implementation**

Learn about Ember's unique rate-based share conversion system and how it differs from standard ERC-4626 vaults. Essential reading for integrators.

**Topics covered:**
- Rate-based vs pool-based conversion
- How `totalAssets()` differs from actual balance
- Operator withdrawals to sub-accounts
- Integration guidelines and best practices
- Example scenarios

### [Contract API Reference](./CONTRACTS.md)
**Complete API Documentation**

Detailed reference for all smart contracts, functions, and errors in the Ember Vaults system.

**Contracts covered:**
- EmberVault.sol - Main vault contract
- EmberProtocolConfig.sol - Protocol configuration
- FixedPointMath Library - Fixed-point arithmetic
- ERC20Token.sol - Testing token
- Custom errors reference

### [Deployment Guide](./DEPLOYMENT.md)
**How to Deploy and Interact**

Step-by-step guide for deploying contracts and interacting with vaults.

**Topics covered:**
- Deployment scripts and order
- Environment configuration
- Network setup
- Interaction scripts
- Deployment file structure
- Troubleshooting

### [Development Guide](./DEVELOPMENT.md)
**Setup, Testing, and Development Workflow**

Complete guide for developers working on Ember Vaults.

**Topics covered:**
- Prerequisites and installation
- Development workflow
- Testing and coverage
- Security auditing with Slither
- Code quality and formatting
- Upgradeability patterns
- Project structure

### [Access Control & Roles](./ACCESS_CONTROL.md)
**Multi-Role System and Permissions**

Understanding the sophisticated role-based access control system.

**Topics covered:**
- Role overview and hierarchy
- Owner, Admin, Operator, Rate Manager, Sub-Accounts
- Role validation and restrictions
- Role management and best practices
- Emergency actions

## 🚀 Quick Navigation

**New to Ember Vaults?**
1. Start with [Architecture](./ARCHITECTURE.md) to understand the rate-based system
2. Review [Access Control](./ACCESS_CONTROL.md) to understand roles
3. Follow [Deployment Guide](./DEPLOYMENT.md) to deploy your first vault

**Integrating with Ember Vaults?**
1. Read [Architecture](./ARCHITECTURE.md) - Critical for understanding differences
2. Check [Contract API Reference](./CONTRACTS.md) for available methods
3. Review integration guidelines in Architecture doc

**Developing on Ember Vaults?**
1. Follow [Development Guide](./DEVELOPMENT.md) for setup
2. Reference [Contract API](./CONTRACTS.md) for implementation details
3. Use [Access Control](./ACCESS_CONTROL.md) for role management

## 📊 Documentation Stats

- **Total Documentation Lines:** ~1,500 lines
- **Main README:** 298 lines (down from 723!)
- **5 Focused Guides:** Architecture, Contracts, Deployment, Development, Access Control

## 🔗 External Resources

- [Main README](../README.md)
- [OpenZeppelin Upgrades](https://docs.openzeppelin.com/upgrades-plugins/1.x/)
- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Hardhat Documentation](https://hardhat.org/docs)
- [Ember Protocol Website](https://ember.so)

---

**Questions or Issues?**
Contact: support@ember.so
