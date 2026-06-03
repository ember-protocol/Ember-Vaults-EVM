# Bridge Scripts

Operational scripts for the LayerZero V2 OFT bridge that lets vault receipt tokens move between EVM chains and Sui.

All scripts read `deployments/<network>-deployment.json` and look up the OFT adapter under `contracts.oftAdapters[ADAPTER_KEY]` (or the vault under `contracts.vaults[VAULT_KEY]`). Run them with the standard hardhat `--network <name>` flag.

## Setup workflow (new pathway)

When wiring a new EVM ↔ remote pathway, run these in order:

1. **`bridge:set-adapter`** — register the OFT adapter with the vault so it's authorized to mint/burn the receipt token.
2. **`bridge:set-peer`** — point the EVM adapter at its peer OFT on the destination chain (and run the equivalent on the destination side too).
3. **`bridge:set-delegate`** — set the delegate that's allowed to push endpoint config; required before `set-dvn-config` works.
4. **`bridge:set-dvn-config`** — write the DVN + executor config onto the LayerZero endpoint for this pathway. Without this, sends are blocked with "Config Error".
5. **`bridge:set-enforced-options`** — set the minimum gas LayerZero must enforce on the destination side.
6. **`bridge:verify-peers`** — sanity-check both ends agree.

After that, `bridge:quote` → `bridge:send` is the user-facing flow, and `bridge:diagnose` / `bridge:lz-scan` are used for debugging stuck or failing messages.

## Scripts

### Setup / config

#### `bridge:set-adapter` — `set-vault-bridge-adapter.ts`
Authorizes the OFT adapter on a vault so it can mint/burn the receipt token for bridging.
- **Required:** `VAULT_KEY`
- **One of:** `ADAPTER_KEY` (lookup) or `ADAPTER_ADDRESS` (raw) — omit both to disable bridging (zero address).

#### `bridge:set-peer` — `set-peer.ts`
Configures the trusted peer OFT on the destination endpoint. Must be set on both sides of a pathway.
- **Required:** `ADAPTER_KEY`, `DST_ENDPOINT_ID`, `PEER_ADDRESS`
- **Optional:** `PEER_FORMAT` (`"bytes32"` default, or `"address"`)

#### `bridge:set-delegate` — `set-delegate.ts`
Sets the LayerZero delegate on the OApp. The delegate is the address authorized to call `setConfig` / `setSendLibrary` / `setReceiveLibrary` on the endpoint on the OApp's behalf. Only the OApp owner can change it.
- **Required:** `ADAPTER_KEY`
- **Optional:** `DELEGATE_ADDRESS` (defaults to signer)

#### `bridge:set-dvn-config` — `set-dvn-config.ts`
Writes the DVN + executor config onto the LayerZero endpoint for the (OApp, dstEid) pair. Required before any send works.
- **Required:** `ADAPTER_KEY`, `DST_ENDPOINT_ID`
- **Optional:** `DVN_ADDRESS` (single override; default uses the per-network list inside the script), `EXECUTOR_ADDRESS`, `ULN_ONLY=true` (skip the executor config — useful when combining the two reverts)

#### `bridge:set-enforced-options` — `set-enforced-options.ts`
Sets the minimum gas the destination must use when executing `lzReceive` for this pathway.
- **Required:** `ADAPTER_KEY`, `DST_ENDPOINT_ID`
- **Optional:** `GAS_LIMIT` (default `200000`), `MSG_TYPE` (`1` = SEND, `2` = SEND_AND_CALL; omit for both)

### Operations

#### `bridge:set-adapter-paused` — `set-adapter-paused.ts`
Pauses or unpauses the OFT adapter. Pausing blocks new outbound sends; in-flight inbound messages still process so funds aren't stuck.
- **Required:** `ADAPTER_KEY`, `PAUSE` (`"true"` or `"false"`)

#### `bridge:quote` — `quote-send.ts`
Read-only — quotes the LZ messaging fee for a send without sending.
- **Required:** `ADAPTER_KEY`, `DST_ENDPOINT_ID`, `AMOUNT`, `RECIPIENT`
- **Optional:** `MIN_AMOUNT`, `EXTRA_OPTIONS`

#### `bridge:send` — `send-tokens.ts`
Bridges receipt tokens to the destination chain.
- **Required:** `ADAPTER_KEY`, `DST_ENDPOINT_ID`, `AMOUNT`, `RECIPIENT`
- **Optional:** `MIN_AMOUNT` (slippage), `EXTRA_OPTIONS`, `COMPOSE_MSG`, `REFUND_ADDRESS` (default sender), `QUOTE_ONLY=true` (skip the actual send)

### Diagnostics

#### `bridge:verify-peers` — `verify-peers.ts`
Verifies that the EVM and Sui sides of a pathway trust each other.
- **Required:** `VAULT_KEY`, `PEER_ADDRESS` (Sui OFT adapter object ID, bytes32)
- **Optional:** `SUI_DEPLOYMENT_FILE` (auto-lookup peer)

#### `bridge:diagnose` — `diagnose-bridge.ts`
Checks peer config, bridge adapter authorization, and adapter state for a vault.
- **Required:** `VAULT_KEY`

#### `bridge:lz-scan` — `query-lz-scan.ts`
Looks up a transaction's status on LayerZero Scan.
- **Required:** `TX_HASH`
- **Optional:** `NETWORK` (`"testnet"` default, or `"mainnet"`), `SRC_CHAIN` (e.g. `"sui"`, `"sepolia"`)

## Examples

```bash
# 1. Authorize the adapter on the vault
VAULT_KEY=emberExusdcVault ADAPTER_KEY=emberExusdcVaultOFTAdapter \
  yarn bridge:set-adapter --network sepolia

# 2. Wire peers (run on both sides — Sui side uses the equivalent Move script)
ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 \
  PEER_ADDRESS=0x... PEER_FORMAT=address \
  yarn bridge:set-peer --network sepolia

# 3. Make the signer the LayerZero delegate, then push DVN/executor config
ADAPTER_KEY=emberExusdcVaultOFTAdapter \
  yarn bridge:set-delegate --network sepolia
ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 \
  yarn bridge:set-dvn-config --network sepolia

# 4. Enforce a destination gas floor
ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 GAS_LIMIT=300000 \
  yarn bridge:set-enforced-options --network sepolia

# Quote then send
ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 \
  AMOUNT=100 RECIPIENT=0x... \
  yarn bridge:quote --network sepolia
ADAPTER_KEY=emberExusdcVaultOFTAdapter DST_ENDPOINT_ID=40378 \
  AMOUNT=100 RECIPIENT=0x... \
  yarn bridge:send --network sepolia

# Emergency: pause / unpause outbound sends
ADAPTER_KEY=emberExusdcVaultOFTAdapter PAUSE=true \
  yarn bridge:set-adapter-paused --network mainnet
ADAPTER_KEY=emberExusdcVaultOFTAdapter PAUSE=false \
  yarn bridge:set-adapter-paused --network mainnet
```

## Notes

- The DVN list inside `set-dvn-config.ts` is per-network. **Update both this list and the equivalent on the Sui side together** — required DVNs must match across the pathway or the receive library rejects the message.
- `set-dvn-config.ts` calls `setDelegate` itself if the signer isn't already the delegate, so running `set-delegate` separately is mostly useful when handing the role to a different address (e.g. a multisig).
- Most write scripts only succeed when run as the OApp owner; pause/unpause and `setDelegate` are `onlyOwner`. `setConfig` requires `delegate` (which the owner can be).
