# Interaction Scripts

Scripts to interact with deployed EmberVault contracts.

## 🔐 Deposit with Permit

Test the new `depositWithPermit` method that combines approval and deposit into a single transaction using EIP-2612 signatures.

### Usage

```bash
VAULT=<vault_name> AMOUNT=<amount> yarn interact:deposit-with-permit --network <network>
```

### Examples

```bash
# Test with emberExusdcVault on Sepolia
VAULT=emberExusdcVault AMOUNT=100 yarn interact:deposit-with-permit --network sepolia

# Test with emberErcusdcVault
VAULT=emberErcusdcVault AMOUNT=50 yarn interact:deposit-with-permit --network sepolia
```

### Requirements

1. **Vault must be upgraded** with `permitMethodsEnabled: true`
2. **Collateral token must support EIP-2612 permit**
3. **User must have sufficient token balance**

### What it does

1. ✅ Loads vault and collateral token from deployment file
2. ✅ Verifies vault has permit methods enabled
3. ✅ Checks if collateral token supports EIP-2612
4. ✅ Creates EIP-2612 permit signature (off-chain)
5. ✅ Calls `depositWithPermit()` in a single transaction
6. ✅ Displays results including shares received

### Benefits

- **Single transaction**: No separate approve needed
- **Gas savings**: One transaction instead of two
- **Better UX**: One-click deposits
- **Gasless approvals**: Signature created off-chain

### Troubleshooting

**"Vault doesn't have permit methods enabled"**
- Upgrade the vault first: `VAULT_KEYS=<vault> yarn upgrade:vaults --network <network>`

**"Collateral token does not support EIP-2612 permit"**
- Use the regular `interact:deposit-to-vault` script instead

**"Insufficient token balance"**
- Mint tokens first: `TOKEN=<token> AMOUNT=<amount> yarn interact:mint-tokens --network <network>`

---

## 💰 Regular Deposit

Use the traditional two-step deposit (approve + deposit).

### Usage

```bash
VAULT=<vault_name> TOKEN=<token_name> AMOUNT=<amount> yarn interact:deposit-to-vault --network <network>
```

### Example

```bash
VAULT=emberExusdcVault TOKEN=xUSDC AMOUNT=100 yarn interact:deposit-to-vault --network sepolia
```

---

## 🪙 Mint Tokens

Mint test tokens to your address for testing deposits.

### Usage

```bash
TOKEN=<token_name> AMOUNT=<amount> yarn interact:mint-tokens --network <network>
```

### Example

```bash
TOKEN=xUSDC AMOUNT=1000 yarn interact:mint-tokens --network sepolia
```

---

## Available Networks

- `sepolia` - Sepolia testnet
- `mainnet` - Ethereum mainnet
- `hardhat` - Local hardhat network

## Environment Setup

Make sure your `.env` file has:

```bash
PRIVATE_KEY=your_private_key_here
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_API_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_API_KEY
```
