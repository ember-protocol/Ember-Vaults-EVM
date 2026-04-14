# MockWETH - Testing Contract for EmberETHVault

## Overview

`MockWETH.sol` is a testing implementation of Wrapped Ether (WETH) designed for deploying and testing `EmberETHVault` on testnets.

### EmberETHVault Integration

**EmberETHVault** is an ERC-4626 compliant vault that:
- **Stores WETH** as the underlying ERC20 asset
- **Wraps ETH**: Calls `IWETH.deposit()` when users deposit ETH
- **Unwraps to ETH**: Calls `IWETH.withdraw()` when processing user withdrawals
- **Sends WETH**: Sub-accounts receive WETH (not unwrapped) for DeFi strategies

## Features

### 1. Standard WETH Functionality
- ✅ **Wrap ETH → WETH**: Deposit native ETH to receive WETH tokens
- ✅ **Unwrap WETH → ETH**: Burn WETH tokens to receive native ETH
- ✅ **Standard ERC20**: Full ERC20 implementation (transfer, approve, etc.)

### 2. ERC20 Permit Support (EIP-2612)
- ✅ **Gasless Approvals**: Sign off-chain messages to approve spending
- ✅ **EIP-712 Domain**: Proper domain separator for signature verification
- ⚠️ **Note**: Real WETH on mainnet does NOT support permit!

### 3. Multiple Deposit Methods
- `deposit()` - Wrap ETH explicitly
- `receive()` - Wrap ETH by sending to contract
- `fallback()` - Wrap ETH through fallback

## Differences from Real WETH

| Feature | Real WETH (Mainnet) | MockWETH (Testing) |
|---------|---------------------|-------------------|
| **Permit Support** | ❌ No | ✅ Yes (EIP-2612) |
| **Base Contract** | Custom implementation | OpenZeppelin ERC20 + ERC20Permit |
| **Upgradeability** | ❌ Not upgradeable | ❌ Not upgradeable |
| **Address (Mainnet)** | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | Deploy on testnet |

## Deployment

### Prerequisites
1. Deploy `EmberProtocolConfig` first
2. Have sufficient ETH for deployment

### Deploy MockWETH

```bash
# Deploy on Sepolia testnet
yarn deploy:mock-weth --network sepolia

# Deploy on local hardhat network
yarn deploy:mock-weth --network localhost
```

The deployment script will:
- Deploy MockWETH contract
- Save address to `deployments/<network>-deployment.json`
- Display deployment details

### Deploy EmberETHVault with MockWETH

```bash
# Set environment variables
export VAULT_NAME="Ember ETH Vault"
export VAULT_RECEIPT_TOKEN_SYMBOL="eETH"
export VAULT_WETH_ADDRESS="0x..." # MockWETH address from previous step
export VAULT_ADMIN="0x..."
export VAULT_OPERATOR="0x..."
export VAULT_RATE_MANAGER="0x..."

# Deploy EmberETHVault
yarn deploy:eth-vault --network sepolia
```

## Usage Examples

### 1. Wrap ETH to WETH

```typescript
const mockWETH = await ethers.getContractAt("MockWETH", wethAddress);

// Method 1: Using deposit()
await mockWETH.deposit({ value: ethers.parseEther("1.0") });

// Method 2: Sending ETH directly
await deployer.sendTransaction({
  to: wethAddress,
  value: ethers.parseEther("1.0")
});
```

### 2. Unwrap WETH to ETH

```typescript
const mockWETH = await ethers.getContractAt("MockWETH", wethAddress);

await mockWETH.withdraw(ethers.parseEther("1.0"));
```

### 3. Approve with Permit (Gasless)

```typescript
import { signERC2612Permit } from "eth-permit";

const mockWETH = await ethers.getContractAt("MockWETH", wethAddress);
const vault = await ethers.getContractAt("EmberETHVault", vaultAddress);

// Sign permit off-chain
const result = await signERC2612Permit(
  signer,
  wethAddress,
  signer.address,
  vaultAddress,
  ethers.parseEther("1.0").toString()
);

// Use permit signature in deposit
await vault.depositWETHWithPermit(
  ethers.parseEther("1.0"),
  receiver,
  result.deadline,
  result.v,
  result.r,
  result.s
);
```

### 4. Test EmberETHVault Integration

```typescript
const mockWETH = await ethers.getContractAt("MockWETH", wethAddress);
const ethVault = await ethers.getContractAt("EmberETHVault", vaultAddress);

// Wrap some ETH to WETH
await mockWETH.deposit({ value: ethers.parseEther("10.0") });

// Approve vault to spend WETH
await mockWETH.approve(vaultAddress, ethers.parseEther("5.0"));

// Deposit WETH (vault will unwrap to ETH)
const tx = await ethVault.depositWETH(
  ethers.parseEther("5.0"),
  user.address
);

console.log("Shares minted:", await ethVault.balanceOf(user.address));
console.log("ETH in vault:", await ethers.provider.getBalance(vaultAddress));
```

## Testing Scenarios

### Test Case 1: ETH Deposit Flow
```typescript
// User deposits native ETH
await ethVault.depositETH(user.address, { 
  value: ethers.parseEther("1.0") 
});

// Check vault received ETH
const vaultBalance = await ethers.provider.getBalance(vaultAddress);
expect(vaultBalance).to.equal(ethers.parseEther("1.0"));
```

### Test Case 2: WETH Deposit + Unwrap
```typescript
// User wraps ETH to WETH
await mockWETH.deposit({ value: ethers.parseEther("2.0") });

// User approves vault
await mockWETH.approve(vaultAddress, ethers.parseEther("2.0"));

// User deposits WETH
await ethVault.depositWETH(ethers.parseEther("2.0"), user.address);

// Verify vault holds ETH, not WETH
const wethBalance = await mockWETH.balanceOf(vaultAddress);
expect(wethBalance).to.equal(0); // Vault has 0 WETH

const ethBalance = await ethers.provider.getBalance(vaultAddress);
expect(ethBalance).to.equal(ethers.parseEther("2.0")); // Vault has ETH
```

### Test Case 3: WETH Permit Deposit
```typescript
// Wrap ETH to WETH
await mockWETH.deposit({ value: ethers.parseEther("1.0") });

// Get permit signature
const deadline = Math.floor(Date.now() / 1000) + 3600;
const { v, r, s } = await getPermitSignature(
  signer,
  wethAddress,
  vaultAddress,
  ethers.parseEther("1.0"),
  deadline
);

// Deposit with permit (no approval needed)
await ethVault.depositWETHWithPermit(
  ethers.parseEther("1.0"),
  user.address,
  deadline,
  v,
  r,
  s
);

// Verify shares minted
const shares = await ethVault.balanceOf(user.address);
expect(shares).to.be.gt(0);
```

### Test Case 4: ETH Withdrawal
```typescript
// Request redemption
const tx = await ethVault.redeemShares(
  ethers.parseEther("1.0"),
  user.address
);

// Operator processes withdrawal
const userBalanceBefore = await ethers.provider.getBalance(user.address);

await ethVault.connect(operator).processWithdrawalRequests(1);

// Verify user received ETH
const userBalanceAfter = await ethers.provider.getBalance(user.address);
expect(userBalanceAfter).to.be.gt(userBalanceBefore);
```

## Contract Interface

### MockWETH Functions

```solidity
// Wrapping
function deposit() external payable;
receive() external payable;
fallback() external payable;

// Unwrapping
function withdraw(uint256 amount) external;

// Standard ERC20
function transfer(address to, uint256 amount) external returns (bool);
function approve(address spender, uint256 amount) external returns (bool);
function transferFrom(address from, address to, uint256 amount) external returns (bool);
function balanceOf(address account) external view returns (uint256);

// ERC20 Permit (EIP-2612)
function permit(
  address owner,
  address spender,
  uint256 value,
  uint256 deadline,
  uint8 v,
  bytes32 r,
  bytes32 s
) external;

function nonces(address owner) external view returns (uint256);
function DOMAIN_SEPARATOR() external view returns (bytes32);
```

## Important Notes

### ⚠️ Testing Only
- **DO NOT** use MockWETH on mainnet
- Real WETH contract is at `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- Real WETH does NOT support permit

### Security Considerations
1. **No Access Control**: Anyone can wrap/unwrap ETH
2. **No Pause Mechanism**: Cannot pause in emergencies
3. **Simple Implementation**: Minimal error handling
4. **Not Audited**: For testing purposes only

### Gas Costs
- `deposit()`: ~45,000 gas
- `withdraw()`: ~35,000 gas
- `permit()`: ~75,000 gas (first time)

## Deployment Addresses

### Mainnet (Use Real WETH)
```
WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
```

### Testnets (Deploy MockWETH)
MockWETH addresses will be saved in `deployments/<network>-deployment.json` under:
```json
{
  "contracts": {
    "depositTokens": {
      "WETH": {
        "address": "0x...",
        "isMock": true,
        "supportsPermit": true
      }
    }
  }
}
```

## Troubleshooting

### Issue: "ETH transfer failed" on withdraw
**Cause**: Receiver contract doesn't accept ETH or gas limit too low  
**Solution**: Ensure receiver can accept ETH or is an EOA

### Issue: "Insufficient WETH balance"
**Cause**: Not enough WETH to unwrap  
**Solution**: Wrap more ETH first using `deposit()`

### Issue: Permit signature fails
**Cause**: Wrong domain or nonce  
**Solution**: Query `DOMAIN_SEPARATOR()` and `nonces(owner)` from contract

## Integration with EmberETHVault

MockWETH is designed to work seamlessly with EmberETHVault:

1. **Deploy MockWETH** on testnet
2. **Deploy EmberETHVault** with MockWETH address
3. **Test all deposit flows**:
   - Native ETH deposits
   - WETH deposits (with auto-unwrap)
   - WETH permit deposits
4. **Test withdrawals**: Verify ETH is sent correctly
5. **Test edge cases**: Refunds, failures, permit invalidation

## Example Test Suite Structure

```typescript
describe("EmberETHVault with MockWETH", function() {
  let mockWETH: MockWETH;
  let ethVault: EmberETHVault;
  let deployer, user, operator;

  beforeEach(async function() {
    // Deploy MockWETH
    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    mockWETH = await MockWETHFactory.deploy();
    
    // Deploy EmberETHVault
    // ... deployment code ...
  });

  describe("ETH Deposits", function() {
    it("Should accept native ETH deposits", async function() {
      // Test depositETH()
    });
    
    it("Should accept ETH for minting shares", async function() {
      // Test mintWithETH()
    });
  });

  describe("WETH Deposits", function() {
    it("Should unwrap WETH to ETH on deposit", async function() {
      // Test depositWETH() + verify unwrapping
    });
    
    it("Should support WETH permit deposits", async function() {
      // Test depositWETHWithPermit()
    });
  });

  describe("Withdrawals", function() {
    it("Should send ETH on withdrawal processing", async function() {
      // Test processWithdrawalRequests() sends ETH
    });
    
    it("Should send ETH to sub-accounts", async function() {
      // Test withdrawFromVaultWithoutRedeemingShares()
    });
  });
});
```

## Quick Start Example

```bash
# 1. Deploy MockWETH on Sepolia
yarn deploy:mock-weth --network sepolia

# 2. Note the WETH address from output, then deploy ETH vault
export VAULT_NAME="Ember ETH Vault"
export VAULT_RECEIPT_TOKEN_SYMBOL="eETH"
export VAULT_WETH_ADDRESS="0x..." # From step 1
export VAULT_ADMIN="0x..."
export VAULT_OPERATOR="0x..."
export VAULT_RATE_MANAGER="0x..."

yarn deploy:eth-vault --network sepolia

# 3. Interact with the vault
# See scripts/interact/ for examples
```

## API Reference

### Constructor
```solidity
constructor()
```
Initializes MockWETH with:
- Name: "Wrapped Ether"
- Symbol: "WETH"
- Decimals: 18
- EIP-2612 permit support enabled

### Events
```solidity
event Deposit(address indexed dst, uint256 wad);
event Withdrawal(address indexed src, uint256 wad);
event Approval(address indexed owner, address indexed spender, uint256 value);
event Transfer(address indexed from, address indexed to, uint256 value);
```

## See Also
- [EmberETHVault README](../EmberETHVault.README.md) - Main vault documentation
- [IWETH Interface](../interfaces/IWETH.sol) - WETH interface specification
- Real WETH: https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
