# Development Guide

Complete guide for developing, testing, and auditing Ember Vaults smart contracts.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Security & Auditing](#security--auditing)
- [Code Quality](#code-quality)
- [Available Scripts](#available-scripts)
- [Upgradeability](#upgradeability)
- [Project Structure](#project-structure)

## Prerequisites

- **Node.js** >= 20.0.0
- **Yarn** package manager
- **Python** >= 3.8 (for security tools)
- **Git** for version control

## Installation

```bash
# Clone the repository
git clone https://github.com/fireflyprotocol/ember-vaults-evm-smart-contracts.git
cd ember-vaults-evm-smart-contracts

# Install dependencies
yarn install

# Copy environment variables template
cp .env.example .env

# Edit .env and configure for local development
# Set DEPLOY_ON=hardhat for local testing
```

## Development Workflow

### 1. Compile Contracts

```bash
# Compile all contracts
yarn compile

# Clean and recompile
yarn clean-compile
```

**Output:**
- Compiled artifacts in `artifacts/`
- TypeScript types in `typechain-types/`
- Compilation cache in `cache/`

### 2. Run Tests

```bash
# Run all tests on Hardhat network
yarn test --network hardhat

# Run specific test file
yarn test test/EmberVault.test.ts --network hardhat

# Run with gas reporting
REPORT_GAS=true yarn test --network hardhat
```

### 3. Check Coverage

```bash
# Generate coverage report
yarn coverage

# View coverage report
open coverage/index.html
```

**Current Coverage:** ~98% (707 passing tests)

### 4. Format Code

```bash
# Format all Solidity and TypeScript files
yarn format

# Check formatting without modifying
yarn format:check

# Format only Solidity
yarn format:solidity
```

### 5. Type Checking

```bash
# Type check TypeScript files
yarn typecheck
```

### 6. Check Contract Sizes

```bash
# Display contract sizes
yarn size
```

**Size Limits:**
- Maximum contract size: 24KB (EIP-170)
- Contracts approaching limit should be optimized or split

## Testing

### Test Structure

Tests are organized by functionality:

```
test/
├── EmberVault.test.ts                        # Core vault tests
├── EmberProtocolConfig.test.ts               # Protocol config tests
├── DepositAssets.test.ts                     # Deposit functionality
├── MintShares.test.ts                        # Mint functionality
├── RedeemShares.test.ts                      # Redemption tests
├── ProcessWithdrawals.test.ts                # Withdrawal processing
├── CancelPendingWithdrawal.test.ts           # Cancellation tests
├── WithdrawFromVaultWithoutRedeemingShares.test.ts  # Sub-account withdrawals
├── Math.test.ts                              # Fixed-point math
└── ERC20Token.test.ts                        # ERC20 token tests
```

### Test Coverage

The test suite includes:

- ✅ Contract deployment and initialization
- ✅ Deposit and mint operations
- ✅ Request-based withdrawals and cancellations
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

### Running Specific Tests

```bash
# Test only deposits
yarn test test/DepositAssets.test.ts

# Test with verbose output
yarn test --verbose

# Test with stack traces
yarn test --stack-trace

# Test and show gas usage
REPORT_GAS=true yarn test
```

### Writing Tests

Tests use Hardhat, Chai, and ethers.js v6:

```typescript
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

describe("EmberVault", function () {
  let vault: EmberVault;
  let owner: SignerWithAddress;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    
    const EmberVault = await ethers.getContractFactory("EmberVault");
    vault = await upgrades.deployProxy(EmberVault, [
      // initialization params
    ]) as EmberVault;
  });

  it("should deposit assets", async function () {
    const assets = ethers.parseUnits("100", 6);
    await vault.deposit(assets, owner.address);
    expect(await vault.balanceOf(owner.address)).to.be.gt(0);
  });
});
```

## Security & Auditing

### Setup Audit Tools

```bash
# Setup Python virtual environment and install Slither
yarn audit:setup
```

**What it installs:**
- Python virtual environment in `venv/`
- Slither static analysis tool
- Solc version manager

### Run Slither Analysis

```bash
# Run Slither on all contracts
yarn audit:slither
```

**Output:** Comprehensive security analysis including:
- Reentrancy vulnerabilities
- Arithmetic issues
- Access control problems
- Uninitialized storage
- Dangerous operations
- Code quality issues

### Slither Report

View the latest report:

```bash
cat slither-report.txt
```

### Security Best Practices

1. **Always run Slither before committing**
2. **Review all HIGH and MEDIUM findings**
3. **Document intentional design decisions**
4. **Use SafeERC20 for token operations**
5. **Add reentrancy guards to state-changing functions**
6. **Validate all inputs**
7. **Use custom errors for gas efficiency**
8. **Follow checks-effects-interactions pattern**

## Code Quality

### Linting

Solidity files are formatted with Prettier:

```bash
# Format all files
yarn format

# Check without modifying
yarn format:check
```

### Code Style

- Use NatSpec comments for all public/external functions
- Document complex logic with inline comments
- Use custom errors instead of require strings
- Prefer explicit over implicit
- Keep functions small and focused

### Documentation

Update NatSpec comments when modifying functions:

```solidity
/**
 * @notice Deposits assets into the vault
 * @dev Mints shares using rate-based conversion
 * @param assets The amount of assets to deposit
 * @param receiver The address to receive the shares
 * @return shares The amount of shares minted
 */
function deposit(uint256 assets, address receiver) 
  external 
  returns (uint256 shares) 
{
  // Implementation
}
```

## Available Scripts

### Compilation

```bash
yarn compile              # Compile all contracts
yarn clean-compile        # Clean and recompile
yarn typecheck            # Type check TypeScript
```

### Testing

```bash
yarn test                 # Run test suite
yarn coverage             # Run with coverage
yarn size                 # Check contract sizes
```

### Code Quality

```bash
yarn format               # Format all files
yarn format:check         # Check formatting
yarn format:solidity      # Format Solidity only
```

### Security

```bash
yarn audit:setup          # Setup audit tools
yarn audit:slither        # Run Slither
```

### Deployment

```bash
yarn deploy:protocol-config  # Deploy protocol config
yarn deploy:deposit-token    # Deploy ERC20 token
yarn deploy:vault            # Deploy vault
```

### Interaction

```bash
yarn interact:mint-tokens       # Mint tokens
yarn interact:deposit-to-vault  # Deposit to vault
```

### Verification

```bash
yarn verify               # Verify on block explorer
```

## Upgradeability

### UUPS Pattern

Contracts use the UUPS (Universal Upgradeable Proxy Standard) pattern:

```solidity
contract EmberVault is 
  Initializable,
  ERC4626Upgradeable,
  OwnableUpgradeable,
  UUPSUpgradeable,
  ReentrancyGuardUpgradeable
{
  // State variables
  
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }
  
  function initialize(...) public initializer {
    __ERC4626_init(...);
    __Ownable_init(...);
    __UUPSUpgradeable_init();
    __ReentrancyGuard_init();
  }
  
  function _authorizeUpgrade(address) internal override onlyOwner {}
}
```

### Upgrade Rules

**DO:**
- Add new state variables at the end
- Use `reinitializer(version)` for upgrade logic
- Test upgrades on testnet first
- Verify storage layout compatibility

**DON'T:**
- Change existing variable types or order
- Remove state variables
- Change inheritance hierarchy
- Use regular constructors

### Storage Gaps

Contracts include storage gaps for future upgrades:

```solidity
uint256[50] private __gap;  // Reserve 50 slots
```

When adding state variables, reduce gap size accordingly.

### Testing Upgrades

```typescript
import { upgrades } from "hardhat";

// Deploy V1
const V1 = await ethers.getContractFactory("EmberVault");
const proxy = await upgrades.deployProxy(V1, [...]);

// Upgrade to V2
const V2 = await ethers.getContractFactory("EmberVaultV2");
const upgraded = await upgrades.upgradeProxy(proxy.address, V2);

// Verify state preserved
expect(await upgraded.version()).to.equal("2.0.0");
```

## Project Structure

```
ember-vaults-evm-smart-contracts/
├── contracts/                  # Solidity contracts
│   ├── interfaces/            # Contract interfaces
│   ├── libraries/             # Reusable libraries
│   ├── testing/               # Test-only contracts
│   ├── EmberVault.sol         # Main vault
│   └── EmberProtocolConfig.sol # Protocol config
├── test/                      # Test suite
├── scripts/                   # Deployment & interaction
│   ├── deploy/               # Deployment scripts
│   └── interact/             # Interaction scripts
├── docs/                      # Documentation
├── deployments/               # Deployment records
├── artifacts/                 # Compiled artifacts
├── typechain-types/           # TypeScript types
└── coverage/                  # Coverage reports
```

## Recent Refactors

### v1.5.0 Changes

1. **Math Library Conversion**
   - `Math.sol` contract → `FixedPointMath` library
   - No separate deployment needed
   - Gas savings through inlining

2. **Manager → Operator Rename**
   - All "manager" references → "operator"
   - Better clarity on responsibilities

3. **Proxies Struct Removal**
   - Removed wrapper struct
   - Direct state variable access

See [Architecture](./ARCHITECTURE.md) for details.

## Troubleshooting

### Common Issues

**"Contract too large"**
```bash
# Check contract sizes
yarn size

# Solution: Optimize or split contract
```

**"Test fails on Hardhat but passes locally"**
```bash
# Clear cache and recompile
yarn clean-compile
yarn test
```

**"Slither not found"**
```bash
# Reinstall audit tools
yarn audit:setup
```

**"Type errors in tests"**
```bash
# Regenerate TypeChain types
yarn compile
```

---

**See Also:**
- [Deployment Guide](./DEPLOYMENT.md)
- [Contract API Reference](./CONTRACTS.md)
- [Architecture Overview](./ARCHITECTURE.md)

