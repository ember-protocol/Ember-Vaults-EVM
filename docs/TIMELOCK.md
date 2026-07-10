# Timelock Operations Guide

End-to-end workflow for putting the protocol's `onlyOwner` and `onlyAdmin`
methods behind a 24-hour timelock, and then operating against it from the
Fordefi multisig.

## What gets timelocked

Two `OZ TimelockController`s are deployed so upgrade authority is separated
from day-to-day vault operations:

- **Owner timelock** becomes the **owner** of every upgradeable proxy
  (`EmberProtocolConfig`, every vault, `EmberVaultValidator`,
  `EmberVaultMintBurnOFTAdapter`).  
  → all `onlyOwner` methods (incl. `upgradeToAndCall`) require schedule + delay + execute.  
  Proposer: the upgrade multisig (audited, e.g. includes OtterSec).
- **Admin timelock** becomes the **admin** (`roles.admin`) of every vault.  
  → all vault `onlyAdmin` methods (`setOperator`, `setRateManager`,
  `setMaxTVL`, `setSubAccountStatus`, `setVaultValidator`, …)
  require schedule + delay + execute.  
  Proposer: the operations multisig.

Both are recorded under `contracts.timelocks.{owner,admin}` in the
deployment file; every script selects which one via `TIMELOCK_KEY`.

`setPausedStatus` is intentionally **not** timelocked — it is gated by the
protocol guardian (`EmberProtocolConfig.guardian()`), not vault admin, so
emergency pause stays instant even after the admin role moves behind the
timelock. The guardian EOA is set via `EmberProtocolConfig.setGuardian` and
can be rotated or cleared by the owner.

Operator and rate-manager roles are intentionally untouched — they remain on
EOAs for frequent operational use.

## Roles after deployment

The `scripts/deploy/timelock.ts` script bakes the following into the
constructor of **each** timelock — there is no follow-up step to renounce
admin or set executor to "open":

| Role            | Holder                                | Why                                                 |
| --------------- | ------------------------------------- | --------------------------------------------------- |
| `PROPOSER`      | the timelock's `PROPOSER` multisig    | Only the multisig can `schedule`/`cancel`.          |
| `CANCELLER`     | same multisig (granted with PROPOSER) | Same body can cancel a scheduled op.                |
| `EXECUTOR`      | `address(0)`                          | "Open" — anyone can `execute` after the delay.      |
| `DEFAULT_ADMIN` | `address(0)` + the timelock itself    | No EOA admin. Role changes go through the timelock. |
| `minDelay`      | `86400` seconds (24 h)                | Configurable via `MIN_DELAY` env at deploy time.    |

For the two-timelock split the proposers differ: the **owner timelock**'s
proposer is the upgrade multisig, the **admin timelock**'s proposer is the
operations multisig.

Setting `admin = address(0)` to the constructor renounces external admin in
one step. Future role rotations (adding a proposer, changing the delay)
must themselves be scheduled through the timelock — see [Adjusting timelock
roles later](#adjusting-timelock-roles-later) below.

## Prerequisite: consolidate ownership

Some contracts on mainnet are owned by a hot wallet
(`0xEED5…`) — the ETH vaults and the OFT adapter. Before any of the
following steps work, transfer their ownership to the multisig
`0xE9F9…` from the hot wallet (one `transferOwnership(0xE9F9…)` per
contract). The ownership-transfer generator script will skip them
otherwise.

## End-to-end deployment flow (two-timelock split)

`ADMIN_MS` = current owner / ops multisig (also the admin-timelock proposer).
`OWNER_MS` = upgrade multisig (owner-timelock proposer).

```bash
# 0. Make sure deployments/<network>-deployment.json reflects current state.

# 1. Deploy both timelocks. TIMELOCK_KEY routes each into contracts.timelocks.<key>.
TIMELOCK_KEY=admin PROPOSER=$ADMIN_MS MIN_DELAY=86400 \
  yarn deploy:timelock --network mainnet
TIMELOCK_KEY=owner PROPOSER=$OWNER_MS MIN_DELAY=86400 \
  yarn deploy:timelock --network mainnet
# → writes contracts.timelocks.admin and contracts.timelocks.owner

# 2. Generate updateVaultAdmin txs (vault admin → ADMIN timelock).
#    MUST happen before step 3 — while the vault owner is still ADMIN_MS.
yarn admin:gen-timelock-admin-transfers --network mainnet
# → deployments/mainnet-timelock-admin-transfers.json
# Submit each `transfers[]` entry from ADMIN_MS to the protocolConfig
# address. These are instant — no timelock involved yet.

# 3. Generate transferOwnership txs (proxy owner → OWNER timelock).
#    EXPECTED_SENDER is the CURRENT owner (ADMIN_MS), not the owner-timelock
#    proposer — the new owner is the owner timelock, but the tx is sent by
#    whoever owns the proxy today.
EXPECTED_SENDER=$ADMIN_MS \
  yarn admin:gen-timelock-transfers --network mainnet
# → deployments/mainnet-timelock-transfers.json
# Submit each `transfers[]` entry from ADMIN_MS. Each entry's `to` is the
# proxy itself.
```

After step 3, every vault `onlyAdmin` method is gated by the admin timelock
and every `onlyOwner` method (incl. upgrades) is gated by the owner timelock.

### Why this order

`updateVaultAdmin(vault, newAdmin)` on `EmberProtocolConfig` forwards
`msg.sender` to the vault, which checks `caller == owner()`. While the
multisig is still the vault owner, the multisig can call this directly
(instant). After step 3 the vault owner is the timelock, so changing
`roles.admin` would itself need to be scheduled through the timelock —
slow and roundabout if done in the wrong order.

## Verify state after each step

```bash
# Step 1 verifies post-deploy roles automatically and exits non-zero on
# mismatch. To re-check later from a console:
yarn hardhat console --network mainnet
> const tl = await ethers.getContractAt("TimelockController", "<addr>");
> await tl.getMinDelay();                         // 86400n
> await tl.hasRole(await tl.PROPOSER_ROLE(), "0xE9F9…")  // true
> await tl.hasRole(await tl.EXECUTOR_ROLE(), ethers.ZeroAddress) // true
> await tl.hasRole(await tl.DEFAULT_ADMIN_ROLE(), tl.target)     // true (self-admin)
```

## Operating: schedule → wait → execute

### Upgrade a UUPS proxy

```bash
# Generates schedule + execute tx-bytes for one upgrade. Routes through the
# OWNER timelock by default (override with TIMELOCK_KEY).
CONTRACT_NAME=EmberProtocolConfig \
PROXY_ADDRESS=0x1Dc4836E5A0A95105BeE1899e3b6bbB1714480fB \
  yarn admin:gen-timelock-upgrade --network mainnet
```

Output goes to
`deployments/mainnet-timelock-upgrade-<proxyShort>-<unix>.json` and
contains:

```jsonc
{
  "schedule": { "to": "<timelock>", "value": "0", "data": "0x..." },
  "execute": { "to": "<timelock>", "value": "0", "data": "0x..." },
  "operationId": "0x...", // useful for status checks
  "delaySeconds": "86400",
  "salt": "0x...",
  "newImpl": "0x...",
}
```

Submission flow:

1. **Schedule (now)** — Fordefi multisig (`0xE9F9…`) submits the
   `schedule` tx. `to` = timelock, `data` = `schedule(target, 0, payload, 0x0, salt, 86400)`.
2. **Wait 24 h** — confirm with `tl.isOperationReady(operationId)`.
3. **Execute (after delay)** — anyone (any EOA, any multisig signer)
   submits the `execute` tx. The new implementation address is then live
   on the proxy.

### Schedule any other timelocked call (admin / config)

The upgrade generator is a special case. For any other timelocked call,
encode the destination calldata yourself and wrap it in the same
`schedule` / `execute` pattern. One-liner using ethers v6:

```ts
import { ethers } from "hardhat";

const target = "0x1Dc4…"; // protocolConfig (or vault, etc.)
const value = 0n;
const payload = new ethers.Interface([
  "function setBlacklistedAccount(address,bool)",
]).encodeFunctionData("setBlacklistedAccount", ["0xVictim…", true]);

const predecessor = ethers.ZeroHash;
const salt = ethers.keccak256(ethers.toUtf8Bytes("blacklist:0xVictim:2026-05-15"));

const tl = new ethers.Interface([
  "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "function execute(address,uint256,bytes,bytes32,bytes32) payable",
]);
const scheduleData = tl.encodeFunctionData("schedule", [
  target,
  value,
  payload,
  predecessor,
  salt,
  86400n,
]);
const executeData = tl.encodeFunctionData("execute", [target, value, payload, predecessor, salt]);
```

Then:

- Multisig submits `{to: timelockAddr, value: 0, data: scheduleData}`.
- Wait 24 h.
- Anyone submits `{to: timelockAddr, value: 0, data: executeData}`.

The `salt` keeps the operation hash unique. If you ever need to retry an
identical-payload op (e.g. after a cancel), bump the salt.

### Cancelling a scheduled op

The proposer (also granted `CANCELLER_ROLE`) can cancel before
execution by calling `timelock.cancel(operationId)`.

```ts
const cancelData = new ethers.Interface(["function cancel(bytes32 id)"]).encodeFunctionData(
  "cancel",
  [operationId]
);
// multisig submits {to: timelock, data: cancelData}
```

## Adjusting timelock roles later

Once deployed, the timelock self-administers. To grant a new proposer,
change the delay, etc., the change must itself be scheduled and executed
through the timelock — i.e. you propose a tx that calls the timelock's
own `grantRole` / `updateDelay` with itself as the target.

Example: grant a second proposer

```ts
const role = await tl.PROPOSER_ROLE();
const grantData = new ethers.Interface(["function grantRole(bytes32,address)"]).encodeFunctionData(
  "grantRole",
  [role, "0xNewProposer"]
);

// schedule + execute (24 h apart) with target = timelock itself
```

To raise the delay, schedule a call to the timelock's
`updateDelay(uint256 newDelay)` with the timelock as target. The delay
takes effect for _future_ schedules; in-flight ones keep their original
delay.

## File map

| Path                                                       | Purpose                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `contracts/Timelock.sol`                                   | One-line import wrapper to compile OZ's `TimelockController`.     |
| `scripts/deploy/timelock.ts`                               | Deploys the timelock and verifies post-deploy roles.              |
| `scripts/admin/generate-timelock-admin-transfer.ts`        | Generates `updateVaultAdmin(vault, timelock)` tx-bytes per vault. |
| `scripts/admin/generate-timelock-ownership-transfer.ts`    | Generates `transferOwnership(timelock)` tx-bytes per proxy.       |
| `scripts/admin/generate-timelock-upgrade-tx.ts`            | Generates schedule + execute tx-bytes for a UUPS upgrade.         |
| `deployments/<network>-deployment.json`                    | Adds `contracts.timelocks.{owner,admin}` after step 1.            |
| `deployments/<network>-timelock-admin-transfers.json`      | Output of step 2.                                                 |
| `deployments/<network>-timelock-transfers.json`            | Output of step 3.                                                 |
| `deployments/<network>-timelock-upgrade-<proxy>-<ts>.json` | One file per generated upgrade.                                   |
| `deployments/timelocked-methods.csv`                       | Reference list of every method gated by the timelock.             |
