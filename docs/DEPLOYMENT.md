# Deployment Guide

This guide covers deployment and interaction with Ember Vault contracts.

## Table of Contents

- [Deployment Scripts](#deployment-scripts)
- [Interaction Scripts](#interaction-scripts)
- [Deployment File Structure](#deployment-file-structure)
- [Network Configuration](#network-configuration)

## Deployment Scripts

The project includes comprehensive deployment scripts for all contracts. Deployment information is saved to `deployments/<network>-deployment.json`.

### 1. Deploy Protocol Config

First, deploy the protocol configuration contract:

```bash
# Set environment variables in .env:
# - PROTOCOL_CONFIG_OWNER: Owner address
# - PLATFORM_FEE_RECIPIENT: Address to receive platform fees

yarn deploy:protocol-config --network sepolia
```

**What it does:**
- Deploys EmberProtocolConfig as a UUPS upgradeable proxy
- Sets protocol-wide parameters (rates, fees, intervals)
- Configures platform fee recipient

### 2. Deploy Deposit Token (ERC20)

Deploy or configure the ERC20 token to be used as vault collateral:

```bash
# Set environment variables in .env:
# - TOKEN_OWNER: Token owner address
# - TOKEN_NAME: Token name (e.g., "Circle USDC")
# - TOKEN_SYMBOL: Token symbol (e.g., "USDC")
# - TOKEN_DECIMALS: Token decimals (e.g., 6)

yarn deploy:deposit-token --network sepolia
```

**What it does:**
- Deploys an upgradeable ERC20 token (for testing)
- Records token address in deployment file
- Can be skipped if using existing token

### 3. Deploy Ember Vault

Deploy the main vault contract:

```bash
# Set environment variables in .env:
# - VAULT_NAME: Vault name (e.g., "Ember USDC Vault")
# - VAULT_RECEIPT_TOKEN_SYMBOL: Receipt token symbol (e.g., "eUSDC")
# - VAULT_COLLATERAL_TOKEN: Address of collateral token
# - VAULT_ADMIN: Admin address
# - VAULT_OPERATOR: Operator address
# - VAULT_RATE_MANAGER: Rate manager address
# - VAULT_PROTOCOL_CONFIG: Protocol config contract address
# - VAULT_OWNER: Vault owner address (optional, defaults to deployer)
# - VAULT_MAX_RATE_CHANGE: Max rate change per update (optional)
# - VAULT_FEE_PERCENTAGE: Fee percentage (optional)
# - VAULT_MIN_WITHDRAWABLE_SHARES: Minimum withdrawable shares (optional)
# - VAULT_RATE_UPDATE_INTERVAL: Rate update interval in ms (optional)
# - VAULT_MAX_TVL: Maximum TVL (optional)
# - VAULT_SUB_ACCOUNTS: Comma-separated sub-account addresses (optional)

yarn deploy:vault --network sepolia
```

**What it does:**
- Deploys EmberVault as a UUPS upgradeable proxy
- Initializes with configured parameters
- Sets up roles (admin, operator, rate manager)
- Configures optional sub-accounts

## Interaction Scripts

### Mint Tokens

Mint deposit tokens for testing:

```bash
# Mint tokens to a specific address
TOKEN=USDC RECIPIENT=0x... AMOUNT=1000 yarn interact:mint-tokens --network sepolia
```

**Parameters:**
- `TOKEN`: Token symbol from deployment file
- `RECIPIENT`: Address to receive tokens
- `AMOUNT`: Amount to mint (in token units)

### Deposit to Vault

Deposit tokens into a vault:

```bash
# Deposit tokens into a vault
# VAULT should be the vault key in lowerCamelCase (e.g., "emberUsdcVault")
VAULT=emberUsdcVault TOKEN=USDC AMOUNT=100 yarn interact:deposit-to-vault --network sepolia
```

**Parameters:**
- `VAULT`: Vault key from deployment file (lowerCamelCase)
- `TOKEN`: Token symbol to deposit
- `AMOUNT`: Amount to deposit (in token units)

**What it does:**
1. Approves vault to spend tokens
2. Calls `deposit()` function
3. Displays minted shares and transaction details

## Deployment File Structure

After deployment, contract addresses and details are stored in `deployments/<network>-deployment.json`:

```json
{
  "network": "sepolia",
  "chainId": "11155111",
  "contracts": {
    "protocolConfig": {
      "proxyAddress": "0x...",
      "implementationAddress": "0x...",
      "ownerAddress": "0x...",
      "version": "v1.0.0",
      "deployedAt": "2026-01-02T11:44:26.682Z",
      "deploymentBlockNumber": 9964742
    },
    "depositTokens": {
      "USDC": {
        "proxyAddress": "0x...",
        "name": "Circle USDC",
        "symbol": "USDC",
        "decimals": 6
      }
    },
    "vaults": {
      "emberUsdcVault": {
        "proxyAddress": "0x...",
        "implementationAddress": "0x...",
        "name": "Ember USDC Vault",
        "receiptTokenSymbol": "eUSDC",
        "collateralToken": "0x...",
        "admin": "0x...",
        "operator": "0x...",
        "rateManager": "0x...",
        "subAccounts": ["0x..."],
        "deployedAt": "2026-01-02T12:08:46.891Z",
        "deploymentBlockNumber": 9964981
      }
    }
  }
}
```

## Network Configuration

### Supported Networks

The project supports multiple networks via Hardhat configuration:

- **hardhat**: Local development network
- **localhost**: Local Hardhat node
- **sepolia**: Ethereum Sepolia testnet
- **mainnet**: Ethereum mainnet (configure in hardhat.config.ts)

### Environment Variables

Required variables in `.env`:

```bash
# Network selection
DEPLOY_ON=sepolia

# Wallet configuration
PRIVATE_KEY=your_private_key_here

# RPC endpoints
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY

# Protocol Config deployment
PROTOCOL_CONFIG_OWNER=0x...
PLATFORM_FEE_RECIPIENT=0x...

# Token deployment (for testing)
TOKEN_OWNER=0x...
TOKEN_NAME="Circle USDC"
TOKEN_SYMBOL="USDC"
TOKEN_DECIMALS=6

# Vault deployment
VAULT_NAME="Ember USDC Vault"
VAULT_RECEIPT_TOKEN_SYMBOL="eUSDC"
VAULT_COLLATERAL_TOKEN=0x...
VAULT_ADMIN=0x...
VAULT_OPERATOR=0x...
VAULT_RATE_MANAGER=0x...
VAULT_PROTOCOL_CONFIG=0x...
VAULT_OWNER=0x...  # Optional
```

### Deployment Order

1. **Protocol Config** - Deploy first (required by vault)
2. **Deposit Token** - Deploy or use existing token
3. **Vault** - Deploy with references to above contracts

### Upgradeability

All contracts use UUPS upgradeable pattern:

- Proxy addresses remain constant across upgrades
- Implementation can be upgraded via `upgradeTo()`
- Owner controls upgrades for protocol config
- Vault owner controls vault upgrades

### Verification

After deployment, verify contracts on block explorer:

```bash
yarn verify --network sepolia
```

## Deployment Checklist

- [ ] Configure `.env` with all required variables
- [ ] Deploy Protocol Config
- [ ] Record Protocol Config address
- [ ] Deploy or identify Deposit Token
- [ ] Record Deposit Token address
- [ ] Update vault environment variables
- [ ] Deploy Vault
- [ ] Verify all contracts on block explorer
- [ ] Test with small deposit
- [ ] Document all addresses

## Troubleshooting

### Common Issues

**"Invalid network"**
- Ensure `DEPLOY_ON` matches a network in `hardhat.config.ts`

**"Insufficient funds"**
- Ensure deployer wallet has enough ETH for gas

**"Contract verification failed"**
- Wait a few minutes after deployment
- Ensure API keys are configured in `hardhat.config.ts`

**"Invalid rate parameters"**
- Check rate intervals against protocol min/max
- Verify fee percentage doesn't exceed max

---

**See Also:**
- [Contract API Reference](./CONTRACTS.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [Development Guide](./DEVELOPMENT.md)

