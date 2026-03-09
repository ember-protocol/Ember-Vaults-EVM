# Fuzzing Guide for EmberVault

Complete guide for property-based testing and fuzzing of EmberVault smart contracts.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Foundry Fuzzing](#foundry-fuzzing)
- [Echidna Testing](#echidna-testing)
- [Properties Tested](#properties-tested)
- [Interpreting Results](#interpreting-results)
- [Advanced Usage](#advanced-usage)

## Overview

Fuzzing helps discover edge cases and vulnerabilities by automatically generating random inputs and testing invariant properties. This project includes two fuzzing approaches:

1. **Foundry (Forge)** - Fast, integrated with existing test framework
2. **Echidna** - Advanced coverage-guided fuzzing

## Quick Start

### Setup

```bash
# Run setup script
bash scripts/setup-fuzzing.sh

# Or manually install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install Echidna (macOS)
brew install echidna
```

### Run Tests

```bash
# Foundry fuzz tests (quick)
yarn fuzz

# Foundry with more iterations
yarn fuzz:ci

# Echidna tests (if installed)
yarn fuzz:echidna
```

## Foundry Fuzzing

### Configuration

Fuzzing settings are in `foundry.toml`:

```toml
[profile.default]
fuzz_runs = 10000              # Number of test runs
fuzz_max_test_rejects = 65536  # Max rejections before giving up

[profile.ci]
fuzz_runs = 50000              # More thorough testing for CI
```

### Running Tests

```bash
# Run all fuzz tests
forge test --match-contract Fuzz

# Run specific test
forge test --match-test testFuzz_ConversionRoundTrip

# With verbose output
forge test --match-contract Fuzz -vvv

# Generate gas report
forge test --match-contract Fuzz --gas-report

# With specific number of runs
forge test --match-contract Fuzz --fuzz-runs 50000
```

### Test Files

- `test/fuzz/EmberVaultConversions.t.sol` - Conversion and rounding properties

### Writing Fuzz Tests

```solidity
function testFuzz_MyProperty(uint256 randomInput) public {
    // Bound input to reasonable range
    randomInput = bound(randomInput, 1, type(uint128).max);
    
    // Test property
    uint256 result = vault.myFunction(randomInput);
    
    // Assert invariant
    assertTrue(result > 0, "Result should be positive");
}
```

## Echidna Testing

### Configuration

Settings are in `echidna.config.yaml`:

```yaml
testMode: property      # Test boolean properties
testLimit: 50000        # Number of test sequences
seqLen: 100            # Transactions per sequence
coverage: true         # Enable coverage guidance
```

### Running Tests

```bash
# Basic run
echidna-test . --contract EmberVaultProperties --config echidna.config.yaml

# With Docker
docker run -it --rm -v $PWD:/src trailofbits/eth-security-toolbox
echidna-test /src --contract EmberVaultProperties --config /src/echidna.config.yaml

# With custom test limit
echidna-test . --contract EmberVaultProperties --test-limit 100000

# Save corpus for reproducibility
echidna-test . --contract EmberVaultProperties --corpus-dir test/echidna/corpus
```

### Test Files

- `test/echidna/EmberVaultProperties.sol` - Invariant properties

### Understanding Echidna Output

```
echidna_rate_never_zero: passed! 💚 (50000 runs)
echidna_total_assets_consistent: passed! 💚 (50000 runs)
echidna_tvl_never_exceeds_max: FAILED! 💔

Counterexample:
  1. deposit(1000000000)
  2. mint(5000000)
```

## Properties Tested

### Core Invariants

| Property | Description | Severity |
|----------|-------------|----------|
| `rate_never_zero` | Rate must always be > 0 | CRITICAL |
| `total_assets_consistent` | totalAssets() = convertToAssets(totalSupply()) | HIGH |
| `tvl_never_exceeds_max` | TVL <= maxTVL | HIGH |
| `rate_within_bounds` | minRate <= rate <= maxRate | MEDIUM |

### Conversion Properties

| Property | Description | Test Type |
|----------|-------------|-----------|
| `round_trip_precision` | assets → shares → assets ≈ original | Foundry/Echidna |
| `zero_conversions` | Converting 0 gives 0 | Echidna |
| `conversions_monotonic` | More input = more output | Both |
| `deposit_rounds_down` | User gets <= perfect shares | Foundry |
| `mint_rounds_up` | User pays >= perfect assets | Foundry |

### Accounting Invariants

| Property | Description | Severity |
|----------|-------------|----------|
| `fees_never_exceed_tvl` | Fees <= TVL | HIGH |
| `balance_lte_supply` | User balance <= total supply | HIGH |
| `min_shares_positive` | Min withdrawable > 0 | LOW |

### Access Control Invariants

| Property | Description | Severity |
|----------|-------------|----------|
| `roles_non_zero` | All roles are set | HIGH |
| `owner_non_zero` | Owner exists | CRITICAL |

## Interpreting Results

### Successful Test

```
✓ testFuzz_ConversionRoundTrip (runs: 10000, μ: 45000, ~: 45000)
```

- ✅ All 10,000 random inputs passed
- Average gas: 45,000
- Median gas: 45,000

### Failed Test

```
✗ testFuzz_DepositRoundsDown (runs: 256, μ: 50000, ~: 50000)
    
    Counterexample: calldata=0x..., args=[12345678901234567890]
    
    Failing assertion: Deposit should round down
```

**Action items:**
1. Review the counterexample input
2. Manually test with the specific input
3. Investigate why the property failed
4. Fix the code or adjust the property

### Echidna Counterexample

```
echidna_rate_within_bounds: FAILED!
  
Call sequence:
  1. deposit(1000000)
  2. updateRate(5000000000000000000000)  ← Rate too high
  3. withdraw(500000)
```

**How to reproduce:**
1. Copy the call sequence
2. Create a manual test in Hardhat
3. Debug step by step

## Advanced Usage

### Custom Invariants

Add your own properties to `test/echidna/EmberVaultProperties.sol`:

```solidity
function echidna_my_property() public view returns (bool) {
    // Your invariant here
    return myCondition == true;
}
```

### Stateful Fuzzing

Test with accumulated state:

```solidity
uint256 public totalDeposited;

function deposit(uint256 amount) public {
    vault.deposit(amount, address(this));
    totalDeposited += amount;
}

function echidna_deposits_tracked() public view returns (bool) {
    return vault.totalAssets() >= totalDeposited;
}
```

### Coverage-Guided Fuzzing

Echidna automatically prioritizes inputs that increase code coverage:

```bash
# Run with coverage
echidna-test . --contract EmberVaultProperties --coverage

# View coverage report
cat coverag/*.txt
```

### Continuous Fuzzing

Integrate into CI/CD:

```yaml
# .github/workflows/fuzz.yml
name: Fuzzing
on: [push, pull_request]

jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@v1
      - name: Run fuzz tests
        run: forge test --match-contract Fuzz --fuzz-runs 50000
```

## Troubleshooting

### Issue: "Too many rejections"

```
Bound inputs more carefully:
randomInput = bound(randomInput, MIN, MAX);
```

### Issue: "Echidna not finding properties"

Check that functions start with `echidna_`:
```solidity
function echidna_my_test() public view returns (bool) { ... }
```

### Issue: "Gas limit exceeded"

Reduce sequence length or transaction complexity:
```yaml
seqLen: 50  # Reduce from 100
```

### Issue: "Slow Echidna execution"

Use Medusa (faster alternative):
```bash
medusa fuzz --target contracts/EmberVault.sol
```

## Best Practices

### 1. Start Small
Begin with simple properties and gradually add complexity.

### 2. Meaningful Bounds
```solidity
// Good
amount = bound(amount, 1, vault.maxDeposit(user));

// Bad (too wide, will reject often)
amount = bound(amount, 0, type(uint256).max);
```

### 3. Test One Property Per Function
```solidity
// Good
function testFuzz_RoundTrip(uint256 x) { ... }
function testFuzz_Monotonic(uint256 x, uint256 y) { ... }

// Bad (tests multiple things)
function testFuzz_Everything(uint256 x) { ... }
```

### 4. Use Assumptions Carefully
```solidity
// Prefer bound()
amount = bound(amount, 1, MAX);

// Use vm.assume() sparingly (causes rejections)
vm.assume(amount > 0 && amount < MAX);
```

### 5. Document Expected Failures
```solidity
/// @dev This property may fail at extreme values due to precision
function testFuzz_PrecisionEdgeCase(uint256 x) { ... }
```

## Resources

- [Foundry Book - Fuzz Testing](https://book.getfoundry.sh/forge/fuzz-testing)
- [Echidna Documentation](https://github.com/crytic/echidna)
- [Property-Based Testing Guide](https://www.youtube.com/watch?v=InNjntT5I6Y)
- [Trail of Bits Blog](https://blog.trailofbits.com/)

## Questions?

For questions about fuzzing EmberVault:
1. Check existing test files for examples
2. Review this documentation
3. Contact the development team

---

**Remember:** Fuzzing is not a silver bullet. Combine with:
- ✅ Unit tests
- ✅ Integration tests
- ✅ Static analysis (Slither)
- ✅ Manual code review
- ✅ External audits

