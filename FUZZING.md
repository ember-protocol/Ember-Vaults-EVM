# 🔍 Fuzzing & Property Testing Guide

Comprehensive guide for running fuzz tests on EmberVault smart contracts.

## 📋 Overview

This project includes two complementary fuzzing approaches:

1. **Foundry Forge** - Fast, integrated fuzz testing with Solidity
2. **Echidna** - Advanced property-based testing with coverage-guided fuzzing

## 🚀 Quick Start

### Automated Setup

```bash
# Run interactive setup script
./scripts/setup-fuzzing.sh
```

The script will:
- ✅ Check for required tools
- ✅ Install Foundry (if needed)
- ✅ Install forge-std library (required)
- ✅ Install Echidna (if needed)  
- ✅ Run fuzz tests
- ✅ Generate coverage reports

### Manual Setup

#### 1. Install Foundry

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Verify installation
forge --version

# Install forge-std library (REQUIRED)
forge install foundry-rs/forge-std --no-commit
```

#### 2. Install Echidna

**macOS:**
```bash
brew install echidna
```

**Linux:**
```bash
# Download latest release
wget https://github.com/crytic/echidna/releases/latest/download/echidna-test-Linux.tar.gz
tar -xzf echidna-test-Linux.tar.gz
sudo mv echidna-test /usr/local/bin/
```

**Docker:**
```bash
docker pull trailofbits/eth-security-toolbox
```

## 🧪 Running Tests

### Foundry Fuzz Tests

```bash
# Run all fuzz tests (10k runs)
forge test --match-contract Fuzz --fuzz-runs 10000

# Run specific test with more runs
forge test --match-test testFuzz_ConversionRoundTrip --fuzz-runs 100000

# Run with verbose output
forge test --match-contract Fuzz -vvv

# Generate coverage
forge coverage --match-contract Fuzz
```

### Echidna Property Tests

```bash
# Run Echidna with default config
echidna-test . --contract EmberVaultProperties --config echidna.yaml

# Run with more test sequences
echidna-test . --contract EmberVaultProperties --test-limit 100000

# Run with coverage
echidna-test . --contract EmberVaultProperties --coverage
```

## 📊 Test Categories

### 1. Conversion Round-Trip Tests

**Tests:** `testFuzz_ConversionRoundTrip_*`

Verifies that converting assets→shares→assets (or reverse) preserves value within rounding tolerance.

```solidity
// Example
assets = 1000e6
shares = convertToShares(assets)  // 1000e6
backToAssets = convertToAssets(shares)  // ~1000e6 (±1 wei)
```

**Properties Tested:**
- ✅ Round-trip preserves value (±1 wei tolerance)
- ✅ No catastrophic precision loss
- ✅ Conversions are reversible

### 2. Rounding Direction Tests

**Tests:** `testFuzz_*Rounding_*`

Ensures rounding always favors the vault (ERC-4626 compliant).

**Properties Tested:**
- ✅ `deposit()` rounds DOWN (user gets ≤ shares)
- ✅ `mint()` rounds UP (user pays ≥ assets)
- ✅ `withdraw()` rounds DOWN (user gets ≤ assets)
- ✅ Floor rounding in all withdrawal estimates

### 3. Monotonicity Tests

**Tests:** `testFuzz_Conversion_Monotonic_*`

Verifies conversions are strictly increasing.

**Properties Tested:**
- ✅ More assets → more shares (always)
- ✅ More shares → more assets (always)
- ✅ No inversions or discontinuities

### 4. TVL Limit Tests

**Tests:** `testFuzz_Deposit_RespectsMaxTVL`

Ensures deposits respect maximum TVL limits.

**Properties Tested:**
- ✅ Cannot deposit beyond maxTVL
- ✅ TVL never exceeds configured limit
- ✅ `maxDeposit()` returns correct bounds

### 5. Precision Loss Tests

**Tests:** `testFuzz_PrecisionLoss_Bounded`

Verifies precision loss is within acceptable bounds.

**Properties Tested:**
- ✅ Precision loss < 0.01% (1 basis point)
- ✅ Loss bounded for all input ranges
- ✅ No unexpected precision degradation

### 6. Invariant Tests (Echidna)

**Tests:** `echidna_*`

Critical invariants that must always hold.

**Invariants:**
- ✅ Rate never zero
- ✅ totalAssets() consistent with calculated value
- ✅ TVL ≤ maxTVL
- ✅ Fees ≤ TVL
- ✅ Total supply never overflows
- ✅ Individual balance ≤ total supply

## 📈 Coverage Goals

Target coverage for fuzz tests:

| Category | Target | Current |
|----------|--------|---------|
| Conversion Functions | 100% | ✅ |
| Rounding Logic | 100% | ✅ |
| TVL Checks | 100% | ✅ |
| Edge Cases | 95%+ | 🔄 |
| Error Conditions | 90%+ | 🔄 |

## 🐛 Common Issues Found by Fuzzing

### Issue 1: Rounding Inconsistency
**Found by:** `testFuzz_ConversionRoundTrip`  
**Fix:** Changed `redeemShares()` from CEIL to FLOOR

### Issue 2: Precision Loss in Edge Cases
**Found by:** `testFuzz_PrecisionLoss_Bounded`  
**Fix:** Verified precision loss always < 0.01%

### Issue 3: TVL Boundary Conditions
**Found by:** `testFuzz_Deposit_RespectsMaxTVL`  
**Fix:** Ensured proper boundary checks

## ⚙️ Configuration

### Foundry Configuration (`foundry.toml`)

```toml
[fuzz]
runs = 10000              # Number of test runs
max_test_rejects = 65536  # Max rejected inputs
seed = '0x1234'          # Reproducible seed
dictionary_weight = 40    # Weight for dictionary values
```

### Echidna Configuration (`echidna.yaml`)

```yaml
testMode: assertion      # Use assertion mode
testLimit: 50000        # Number of sequences
seqLen: 100            # Transactions per sequence
coverage: true         # Enable coverage
```

## 📝 Writing New Fuzz Tests

### Foundry Pattern

```solidity
function testFuzz_YourProperty(uint256 input) public {
    // 1. Bound input to valid range
    input = bound(input, 1e6, 1000000e6);
    
    // 2. Perform operation
    uint256 result = vault.someOperation(input);
    
    // 3. Assert property
    assertTrue(result > 0, "Result should be positive");
}
```

### Echidna Pattern

```solidity
function echidna_your_invariant() public view returns (bool) {
    // Return true if invariant holds, false otherwise
    return vault.someValue() > 0;
}
```

## 🎯 Best Practices

1. **Bound Inputs Carefully**
   ```solidity
   // Good: Bounded to reasonable range
   amount = bound(amount, 1e6, type(uint96).max);
   
   // Bad: Unbounded (may cause overflow)
   uint256 result = amount * rate;
   ```

2. **Test Edge Cases**
   ```solidity
   // Test zero
   testFuzz_ZeroInput()
   
   // Test maximum
   testFuzz_MaximumInput()
   
   // Test boundary
   testFuzz_BoundaryConditions()
   ```

3. **Use Descriptive Names**
   ```solidity
   // Good
   testFuzz_ConversionRoundTrip_AssetsToShares()
   
   // Bad
   testFuzz_Conv()
   ```

4. **Document Properties**
   ```solidity
   /// @notice Test that conversions are reversible
   /// @dev Allows 1 wei precision loss
   function testFuzz_Reversibility() ...
   ```

## 📊 Interpreting Results

### Foundry Output

```bash
[PASS] testFuzz_ConversionRoundTrip (runs: 10000, μ: 12345, ~: 12000)
```

- **runs**: Number of fuzz runs
- **μ**: Mean gas used
- **~**: Median gas used

### Echidna Output

```bash
echidna_rate_never_zero: passed! (50000 tests)
echidna_totalAssets_consistent: passed! (50000 tests)
echidna_tvl_within_limit: failed! (counterexample found)
```

- **passed**: Property held for all tests
- **failed**: Counterexample found
- Echidna will provide the failing input

## 🔧 Troubleshooting

### Foundry Issues

**Issue:** Tests timeout
```bash
# Reduce fuzz runs
forge test --fuzz-runs 1000
```

**Issue:** Out of memory
```bash
# Reduce parallel jobs
forge test --fuzz-runs 10000 -j 1
```

### Echidna Issues

**Issue:** "No contract found"
```bash
# Check contract name matches
echidna-test . --contract EmberVaultProperties
```

**Issue:** Compilation errors
```bash
# Check solc version
solc --version

# Update remappings
crytic-compile . --solc-remaps @openzeppelin/contracts/=node_modules/@openzeppelin/contracts/
```

## 📚 Resources

### Foundry
- [Foundry Book](https://book.getfoundry.sh/)
- [Fuzz Testing Guide](https://book.getfoundry.sh/forge/fuzz-testing)
- [Invariant Testing](https://book.getfoundry.sh/forge/invariant-testing)

### Echidna
- [Echidna Documentation](https://github.com/crytic/echidna)
- [Building Secure Contracts](https://secure-contracts.com/)
- [Echidna Tutorial](https://github.com/crytic/building-secure-contracts/tree/master/program-analysis/echidna)

### General
- [Smart Contract Fuzzing](https://blog.trailofbits.com/2018/03/09/echidna-a-smart-fuzzer-for-ethereum/)
- [Property-Based Testing](https://fsharpforfunandprofit.com/posts/property-based-testing/)

## 🤝 Contributing

When adding new features to EmberVault:

1. ✅ Add corresponding fuzz tests
2. ✅ Verify existing tests still pass
3. ✅ Add new invariants if applicable
4. ✅ Update this documentation

## 📞 Support

For issues or questions:
- Review existing tests in `test/foundry/` and `test/echidna/`
- Check [Foundry troubleshooting](https://book.getfoundry.sh/troubleshooting)
- Check [Echidna issues](https://github.com/crytic/echidna/issues)

---

**Happy Fuzzing!** 🐛🔍

