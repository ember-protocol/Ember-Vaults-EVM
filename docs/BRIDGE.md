# EmberVault OFT Bridge

This document describes how to bridge EmberVault receipt tokens between EVM chains and Sui (and other LayerZero-supported chains) using the LayerZero V2 OFT (Omnichain Fungible Token) standard.

## Overview

The EmberVault bridge uses a **Mint/Burn model** where receipt tokens are burned on the source chain and minted on the destination chain. This enables seamless cross-chain movement of vault shares across unified vaults.

### Architecture

```
EVM Chain                           Sui (or other chain)
┌──────────────────┐               ┌──────────────────┐
│  EmberVault      │               │  Sui Vault       │
│  (Receipt Token) │               │  (Receipt Token) │
└────────┬─────────┘               └────────┬─────────┘
         │                                  │
         ▼                                  ▼
┌──────────────────┐               ┌──────────────────┐
│  MintBurnAdapter │◄─────────────►│  OFT Module      │
│  (Burn on Send)  │   LayerZero   │  (Mint on Recv)  │
│  (Mint on Recv)  │      V2       │  (Burn on Send)  │
└──────────────────┘               └──────────────────┘
```

**How it works:**
- **Sending (EVM → Sui)**: Burns receipt tokens on EVM, LayerZero delivers message, Sui mints equivalent tokens
- **Receiving (Sui → EVM)**: Burns receipt tokens on Sui, LayerZero delivers message, EVM mints equivalent tokens

**This architecture enables:**
- Vaults on multiple chains sharing the same underlying deposit token
- 1:1 backing computed across all vaults combined
- Users can deposit on one chain and redeem on another

## Contracts

### EmberVaultMintBurnOFTAdapter

Located at: `contracts/EmberVaultMintBurnOFTAdapter.sol`

This adapter burns and mints receipt tokens directly for cross-chain transfers using the vault's `bridgeMint()` and `bridgeBurn()` functions.

**Key features:**
- Built on LayerZero V2 OApp for cross-chain messaging
- Uses shared decimals (6 by default) for cross-chain compatibility
- Owner-controlled peer configuration
- Optional message inspector for validation

**Requirements:**
- The vault must authorize the adapter via `setBridgeAdapter()` through ProtocolConfig
- The adapter calls `bridgeMint()` on receive and `bridgeBurn()` on send

### IBridgeable Interface

The vault must implement the `IBridgeable` interface:

```solidity
interface IBridgeable {
    function bridgeMint(address to, uint256 amount) external;
    function bridgeBurn(address from, uint256 amount) external;
}
```

## Configuration

### LayerZero Endpoints

The LayerZero configuration is in `config/layerzero.config.ts`:

| Network | Endpoint ID | Endpoint Address |
|---------|-------------|------------------|
| Ethereum Mainnet | 30101 | 0x1a44076050125825900e736c501f859c50fE728c |
| Sepolia Testnet | 40161 | 0x6EDCE65403992e310A62460808c4b910D972f10f |
| Sui Mainnet | 30280 | (Package ID based) |
| Sui Testnet | 40280 | (Package ID based) |

## Deployment

### 1. Deploy OFT Adapter on EVM

```bash
# Set the vault key from your deployment file
export VAULT_KEY=emberExusdcVault

# Deploy the mint-burn adapter
yarn deploy:oft-adapter --network sepolia
```

The script will:
1. Read the vault address from the deployment file
2. Deploy the EmberVaultMintBurnOFTAdapter contract
3. Configure it with the LayerZero endpoint
4. Save deployment info to the deployment JSON file

### 2. Authorize the Adapter on the Vault

The adapter must be authorized to call `bridgeMint()` and `bridgeBurn()` on the vault:

```bash
# Via ProtocolConfig (admin only)
# Call this function on the ProtocolConfig contract:
protocolConfig.setVaultBridgeAdapter(vaultAddress, adapterAddress)
```

This is a one-time setup that grants the adapter permission to mint and burn vault shares.

### 3. Deploy OFT on Sui

On the Sui side, deploy a Move OFT package using LayerZero's Sui SDK:

```typescript
import { initOftMoveCall, registerOAppMoveCall } from "@layerzerolabs/oft-move";

// Initialize the OFT on Sui
const initTx = initOftMoveCall({
  oftConfig: {
    decimals: 6,
    symbol: "exUSDC",
    name: "Ember exUSDC Receipt Token",
  },
  // ... other config
});

// Register as OApp with LayerZero
const registerTx = registerOAppMoveCall({
  // ... config
});
```

See [LayerZero Sui OFT Docs](https://docs.layerzero.network/v2/developers/sui/oft/overview) for details.

### 4. Configure Peer Connections

Both sides must be configured to trust each other:

**On EVM (set Sui as peer):**
```bash
export ADAPTER_KEY=emberExusdcVaultOFTAdapter
export DST_ENDPOINT_ID=40280  # Sui Testnet
export PEER_ADDRESS=0x...     # Sui OFT package address (as bytes32)

yarn bridge:set-peer --network sepolia
```

**On Sui (set EVM as peer):**
```typescript
import { setPeerMoveCall } from "@layerzerolabs/oft-move";

const tx = setPeerMoveCall({
  eid: 40161, // Sepolia
  peer: "0x..." // EVM adapter address as bytes32
});
```

## Usage

### Quote Bridge Fee

Before sending, check the required fee:

```bash
export ADAPTER_KEY=emberExusdcVaultOFTAdapter
export DST_ENDPOINT_ID=40280
export AMOUNT=100
export RECIPIENT=0x...

yarn bridge:quote --network sepolia
```

Output:
```
OFT Quote:
  Amount Sent: 100 exUSDC
  Amount Received: 100 exUSDC
  
Messaging Fee:
  Native Fee: 0.001 ETH
  Estimated USD: ~$2.50
```

### Send Tokens to Sui

```bash
export ADAPTER_KEY=emberExusdcVaultOFTAdapter
export DST_ENDPOINT_ID=40280
export AMOUNT=100
export RECIPIENT=0x...  # Sui address

yarn bridge:send --network sepolia
```

The script will:
1. Check token balance
2. Quote the messaging fee
3. Burn the tokens and send LayerZero message
4. Provide a LayerZero Scan link to track the transaction

### Track Transaction

After sending, track your transaction at:
```
https://layerzeroscan.com/tx/<TX_HASH>
```

## Security Considerations

### Single Adapter Rule

⚠️ **Important**: Only ONE OFTAdapter should exist per vault globally. Having multiple adapters for the same token breaks unified liquidity across chains.

### Bridge Adapter Authorization

- Only the admin can authorize a bridge adapter via ProtocolConfig
- The vault's `bridgeMint` and `bridgeBurn` functions are restricted to the authorized adapter
- Changing the adapter requires a new `setVaultBridgeAdapter` call

### Peer Configuration

- Only the adapter owner can set peers
- Verify peer addresses carefully before configuration
- Use bytes32 format for cross-chain address compatibility

### Decimals

- The adapter uses 6 shared decimals by default
- Tokens with fewer than 6 decimals will revert on deployment
- Dust may be lost in conversions between local and shared decimals

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_KEY` | Yes | Key of the vault in deployment file |
| `OFT_DELEGATE` | No | Delegate address for OApp config (default: deployer) |
| `ADAPTER_KEY` | Yes | Key of the OFT adapter in deployment file |
| `DST_ENDPOINT_ID` | Yes | LayerZero endpoint ID of destination chain |
| `PEER_ADDRESS` | Yes | Address of peer OFT on destination chain |
| `PEER_FORMAT` | No | "bytes32" or "address" (default: bytes32) |
| `AMOUNT` | Yes | Amount of tokens to bridge |
| `RECIPIENT` | Yes | Recipient address on destination chain |
| `MIN_AMOUNT` | No | Minimum amount to receive (slippage protection) |
| `REFUND_ADDRESS` | No | Address for refunds (default: sender) |
| `QUOTE_ONLY` | No | Set to "true" to only get fee quote |

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Deploy OFT Adapter | `yarn deploy:oft-adapter` | Deploy adapter for a vault |
| Set Peer | `yarn bridge:set-peer` | Configure peer connection |
| Quote Send | `yarn bridge:quote` | Get fee estimate for bridging |
| Send Tokens | `yarn bridge:send` | Bridge tokens to destination chain |

## Troubleshooting

### "No peer configured for endpoint"
The adapter doesn't have a trusted peer set for the destination chain. Run `yarn bridge:set-peer` first.

### "Unauthorized" when minting/burning
The adapter is not authorized on the vault. Call `protocolConfig.setVaultBridgeAdapter()` with the admin account.

### "Insufficient token balance"
The sender doesn't have enough receipt tokens. Deposit more collateral into the vault first.

### "Insufficient ETH for messaging fee"
The sender doesn't have enough ETH to pay the LayerZero messaging fee.

### "InvalidLocalDecimals"
The receipt token has fewer decimals than the shared decimals (6). This is rare for USDC-based tokens.

## Resources

- [LayerZero V2 Documentation](https://docs.layerzero.network/v2)
- [LayerZero OFT Quickstart](https://docs.layerzero.network/v2/developers/evm/oft/quickstart)
- [LayerZero Sui OFT](https://docs.layerzero.network/v2/developers/sui/oft/overview)
- [LayerZero Scan](https://layerzeroscan.com)
