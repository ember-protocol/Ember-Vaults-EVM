/**
 * Read-only verification of the CCIP wiring on both sides of a lane.
 *
 * Broadcasts nothing. Run this before any deploy so the addresses we copied out of
 * https://docs.chain.link/ccip/directory are proven on-chain, and so the ramp generation
 * (1.6 vs 2.0) is a fact rather than an assumption — the indexer's event shapes depend on it.
 *
 * Usage:
 *   yarn ccip:verify-config
 *
 * Reads SEPOLIA_RPC_URL / PHAROS_TESTNET_RPC_URL from .env (or the environment). RPC URLs are
 * env-only on purpose: provider URLs usually carry an API key in the path and must not land in
 * the repo.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  CCIP_NETWORKS,
  getCcipConfig,
  getLanePartners,
  type CcipNetworkConfig,
} from "../../config/ccip.config";

// This script runs standalone under ts-node, so it never loads hardhat.config.ts — which is
// where the rest of the repo picks up .env. Load it here or every RPC lookup comes back
// undefined even when the variables are set.
dotenv.config();

/**
 * Vaults to inspect per network. Addresses for the CCIP contracts themselves are NOT repeated
 * here — they come from config/ccip.config.ts so there is one source of truth and no drift.
 */
const VAULTS: Record<string, { label: string; address: string }[]> = {
  sepolia: [
    { label: "emberTestCcipVault", address: "0x7eBE31DF40e67c1a67A539a7bbc078732347dCA9" },
    { label: "emberSepoliaStagingVault", address: "0x41521F4443f402c28522280e86dDc65479e95645" },
  ],
  atlantic: [
    { label: "emberTestCcipVault", address: "0xE03c31CaAc8c82B78Ae2E8482C09a6CB179F0C25" },
  ],
  mantle_sepolia: [
    { label: "emberTestCcipVault", address: "0x9F32C78475A7F86125E4ff7Fa1383e1994602623" },
  ],
};

/**
 * Networks this script checks. The production pair is included unconditionally — `verifyChain`
 * skips any network whose RPC env var is unset, so listing them costs nothing when only testnet
 * RPCs are configured, and omitting them made every production-only check dead code.
 */
const NETWORKS = ["sepolia", "atlantic", "mantle_sepolia", "mainnet", "pharos"];

/** Lanes carrying real value. FTF is a deliberate tradeoff here, not a default. */
const PRODUCTION_NETWORKS = new Set(["mainnet", "pharos"]);

/** WAIT_FOR_FINALITY — the finality a fee quote is read against. */
const FINALITY_DEFAULT = "0x00000000";

type ChainSpec = CcipNetworkConfig & {
  key: string;
  name: string;
  selector: bigint;
  vaults?: { label: string; address: string }[];
};

function specFor(network: string): ChainSpec {
  const cfg = getCcipConfig(network);
  return {
    ...cfg,
    key: cfg.network,
    name: cfg.label,
    selector: cfg.chainSelector,
    vaults: VAULTS[network],
  };
}

const ROUTER_ABI = [
  "function typeAndVersion() view returns (string)",
  "function getOnRamp(uint64 destChainSelector) view returns (address)",
  "function isOffRamp(uint64 sourceChainSelector, address offRamp) view returns (bool)",
  "function getOffRamps() view returns (tuple(uint64 sourceChainSelector, address offRamp)[])",
  "function isChainSupported(uint64 chainSelector) view returns (bool)",
];

const TAR_ABI = [
  "function typeAndVersion() view returns (string)",
  "function getPool(address token) view returns (address)",
  "function getTokenConfig(address token) view returns (tuple(address administrator, address pendingAdministrator, address tokenPool))",
];

const RMN_ABI = [
  "function isCursed() view returns (bool)",
  "function isCursed(bytes16) view returns (bool)",
];

const VERSIONED_ABI = ["function typeAndVersion() view returns (string)"];

const POOL_ABI = [
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",
  "function getToken() view returns (address)",
  "function isSupportedChain(uint64 remoteChainSelector) view returns (bool)",
  "function isSupportedToken(address token) view returns (bool)",
  "function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)",
  "function isRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress) view returns (bool)",
  // CCIP 2.0 only — absent on a 1.6 pool, where tryCall just returns undefined.
  "function getDynamicConfig() view returns (address router, address rateLimitAdmin, address feeAdmin)",
  "function getAllowedFinalityConfig() view returns (bytes4)",
  "function getTokenDecimals() view returns (uint8)",
  "function getCurrentRateLimiterState(uint64 remoteChainSelector, bool fastFinality) view returns (tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) outbound, tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) inbound)",
  "function getTokenTransferFeeConfig(address localToken, uint64 destChainSelector, bytes4 requestedFinalityConfig, bytes tokenArgs) view returns (tuple(uint32 destGasOverhead, uint32 destBytesOverhead, uint32 finalityFeeUSDCents, uint32 fastFinalityFeeUSDCents, uint16 finalityTransferFeeBps, uint16 fastFinalityTransferFeeBps, bool isEnabled))",
];

/// Renders an allowedFinality bytes4 the way set-finality.ts does.
function describeFinality(value: string): string {
  const n = Number(BigInt(value));
  if (n === 0) return "wait for full finality (FTF disabled)";
  const depth = n & 0xffff;
  const parts: string[] = [];
  if (n & 0x00010000) parts.push("WAIT_FOR_SAFE_FLAG");
  if (depth > 0) parts.push(`block depth >= ${depth}`);
  const unknown = n & ~0x0001ffff;
  if (unknown) parts.push(`reserved bits 0x${unknown.toString(16)}`);
  return parts.join(" + ") || "unrecognised";
}

const fmtLimit = (b: any) =>
  b && b.isEnabled ? `capacity=${b.capacity} rate=${b.rate}/s` : "disabled";

/**
 * Reads a remote pool's OUTBOUND limits towards `towards`, so an inbound limit can be judged
 * against what the far side can actually send. Returns undefined when the remote RPC is not
 * configured, the deployment file has no such pool, or the pool predates these getters — the
 * caller reports that as unknown rather than as a pass.
 */
async function remoteOutboundFor(
  remote: ChainSpec,
  towards: ChainSpec,
  poolKey: string,
  fastFinality = false
): Promise<{ isEnabled: boolean; capacity: bigint; rate: bigint; decimals: bigint } | undefined> {
  const url = process.env[remote.rpcEnv];
  if (!url) return undefined;

  const file = `./deployments/${remote.key}-deployment.json`;
  if (!fs.existsSync(file)) return undefined;
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  const poolInfo = info.contracts?.ccipTokenPools?.[poolKey];
  if (!poolInfo?.address) return undefined;

  const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
  const pool = new ethers.Contract(poolInfo.address, POOL_ABI, provider);
  const state = await tryCall(() =>
    pool.getCurrentRateLimiterState(towards.selector, fastFinality)
  );
  if (!state) return undefined;
  const decimals = await tryCall(() => pool.getTokenDecimals());
  return {
    isEnabled: state[0].isEnabled,
    capacity: state[0].capacity,
    rate: state[0].rate,
    decimals: decimals === undefined ? 18n : BigInt(decimals),
  };
}

const VAULT_ABI = [
  "function version() view returns (string)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function roles() view returns (address admin, address operator, address rateManager)",
  "function bridgeAdapter() view returns (address)",
  "function protocolConfig() view returns (address)",
  "function minBridgeAmount() view returns (uint256)",
  "function maxBridgeAmount() view returns (uint256)",
];

const ok = (s: string) => `  ✅ ${s}`;
/**
 * The failure reporter. Also sets the process exit code, so this script can gate an automated
 * preflight — printing a red line while exiting 0 is worse than not checking at all, because a
 * CI step passes and nobody reads the log. `exitCode` rather than `exit()` so every remaining
 * check still runs and the operator sees the whole picture in one pass.
 */
const bad = (s: string) => {
  process.exitCode = 1;
  return `  ❌ ${s}`;
};
/** A state that is not a failure: nothing was configured to check, so nothing is wrong. */
const skip = (s: string) => `  ⏭️  ${s}`;
const info_ = (s: string) => `     ${s}`;

/** Calls a view fn, returning undefined instead of throwing so one gap doesn't end the run. */
async function tryCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function hasCode(provider: ethers.Provider, address: string): Promise<boolean> {
  const code = await provider.getCode(address);
  return code !== "0x" && code !== "0x0";
}

async function checkContract(
  provider: ethers.Provider,
  label: string,
  address: string
): Promise<boolean> {
  if (!(await hasCode(provider, address))) {
    console.log(bad(`${label} ${address} — NO CODE AT THIS ADDRESS`));
    return false;
  }
  const tv = await tryCall(() =>
    new ethers.Contract(address, VERSIONED_ABI, provider).typeAndVersion()
  );
  console.log(ok(`${label} ${address}${tv ? `  [${tv}]` : ""}`));
  return true;
}

async function verifyChain(spec: ChainSpec, remotes: ChainSpec[]) {
  const url = process.env[spec.rpcEnv];
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${spec.name}  (chainId ${spec.chainId}, selector ${spec.selector})`);
  console.log("=".repeat(78));

  if (!url) {
    console.log(skip(`${spec.rpcEnv} not set — skipping`));
    return;
  }

  // batchMaxCount: 1 disables ethers' JSON-RPC request batching. Several public endpoints cap
  // batch size — Mantle Sepolia's drpc.org free tier rejects anything over 3 — and a rejected
  // batch surfaces as an undecodable "0x" result several calls downstream rather than as a
  // clear RPC error. One request at a time is slower and always correct.
  const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });

  const net = await tryCall(() => provider.getNetwork());
  if (!net) {
    console.log(bad("could not reach the RPC endpoint"));
    return;
  }
  if (Number(net.chainId) !== spec.chainId) {
    console.log(
      bad(`RPC reports chainId ${net.chainId}, expected ${spec.chainId} — wrong endpoint`)
    );
    return;
  }
  const block = await provider.getBlockNumber();
  console.log(ok(`RPC reachable, chainId ${net.chainId}, head block ${block}`));

  console.log("\n  CCIP contracts (from docs.chain.link/ccip/directory)");
  await checkContract(provider, "Router          ", spec.router);
  await checkContract(provider, "RMN proxy       ", spec.rmnProxy);
  await checkContract(provider, "TokenAdminRegistry", spec.tokenAdminRegistry);
  await checkContract(provider, "RegistryModule  ", spec.registryModule);

  for (const remote of remotes) {
    // ---- lane to the remote chain -------------------------------------------------
    console.log(`\n  Lane -> ${remote.name} (selector ${remote.selector})`);
    const router = new ethers.Contract(spec.router, ROUTER_ABI, provider);

    const supported = await tryCall(() => router.isChainSupported(remote.selector));
    if (supported !== undefined) {
      console.log(supported ? ok("isChainSupported: true") : bad("isChainSupported: false"));
    }

    const onRamp = await tryCall(() => router.getOnRamp(remote.selector));
    if (onRamp && onRamp !== ethers.ZeroAddress) {
      const tv = await tryCall(() =>
        new ethers.Contract(onRamp, VERSIONED_ABI, provider).typeAndVersion()
      );
      console.log(ok(`OnRamp  ${onRamp}${tv ? `  [${tv}]` : ""}`));
    } else {
      console.log(bad("OnRamp: none configured — outbound lane is NOT live"));
    }

    const offRamps = await tryCall(() => router.getOffRamps());
    if (offRamps) {
      const matching = offRamps.filter(
        (r: any) => BigInt(r.sourceChainSelector) === remote.selector
      );
      if (matching.length === 0) {
        console.log(bad(`OffRamp: none for source ${remote.selector} — inbound lane is NOT live`));
      }
      for (const r of matching) {
        const tv = await tryCall(() =>
          new ethers.Contract(r.offRamp, VERSIONED_ABI, provider).typeAndVersion()
        );
        console.log(ok(`OffRamp ${r.offRamp}${tv ? `  [${tv}]` : ""}`));
      }
      console.log(info_(`(router lists ${offRamps.length} offRamp entries across all lanes)`));
    }

    // ---- RMN curse ----------------------------------------------------------------
    const rmn = new ethers.Contract(spec.rmnProxy, RMN_ABI, provider);
    const subject = ethers.zeroPadValue(ethers.toBeHex(remote.selector), 16);
    const cursedGlobal = await tryCall(() => rmn["isCursed()"]());
    const cursedLane = await tryCall(() => rmn["isCursed(bytes16)"](subject));
    if (cursedGlobal !== undefined || cursedLane !== undefined) {
      const cursed = Boolean(cursedGlobal) || Boolean(cursedLane);
      console.log(
        cursed
          ? bad(`RMN cursed (global=${cursedGlobal}, lane=${cursedLane})`)
          : ok("RMN not cursed")
      );
    }
  }

  // ---- vaults --------------------------------------------------------------------
  for (const entry of spec.vaults ?? []) {
    await verifyVault(provider, spec, entry);
  }

  // ---- pools recorded in the deployment file ---------------------------------------
  await verifyPools(provider, spec, remotes);
}

/** The pool address the remote chain's deployment file records for `poolKey`, if any. */
function remotePoolAddress(remote: ChainSpec, poolKey: string): string | undefined {
  const file = `./deployments/${remote.key}-deployment.json`;
  if (!fs.existsSync(file)) return undefined;
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  return info.contracts?.ccipTokenPools?.[poolKey]?.address;
}

/** Reads deployments/<network>-deployment.json and checks whatever pools it records. */
async function verifyPools(provider: ethers.Provider, spec: ChainSpec, remotes: ChainSpec[]) {
  const file = `./deployments/${spec.key}-deployment.json`;
  if (!fs.existsSync(file)) return;
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  const pools = info.contracts?.ccipTokenPools ?? {};
  if (Object.keys(pools).length === 0) return;

  for (const [poolKey, poolInfo] of Object.entries<any>(pools)) {
    console.log(`\n  CCIP pool ${poolKey}  ${poolInfo.address}`);
    if (!(await hasCode(provider, poolInfo.address))) {
      console.log(bad("no code at the recorded pool address"));
      continue;
    }
    const pool = new ethers.Contract(poolInfo.address, POOL_ABI, provider);
    const [tv, owner, poolToken] = await Promise.all([
      tryCall(() => pool.typeAndVersion()),
      tryCall(() => pool.owner()),
      tryCall(() => pool.getToken()),
    ]);
    console.log(info_(`typeAndVersion ${tv ?? "?"}`));
    console.log(info_(`owner          ${owner ?? "?"}`));

    // The pool's RMN is a constructor immutable. If it disagrees with the configured address the
    // pool cannot be repaired — every transfer reverts inside _validateLockOrBurn.
    const poolRmn = await tryCall(() =>
      new ethers.Contract(
        poolInfo.address,
        ["function getRmnProxy() view returns (address)"],
        provider
      ).getRmnProxy()
    );
    if (poolRmn && String(poolRmn).toLowerCase() !== spec.rmnProxy.toLowerCase()) {
      console.log(bad(`RMN ${poolRmn} != configured ${spec.rmnProxy}`));
      console.log(info_("immutable — this pool reverts on every transfer and must be redeployed"));
    }

    // Needed to compare our inbound limits against a remote pool whose token may not share our
    // decimals. Defaults to 18 on a pool that predates the getter, matching the vault tokens.
    const rawDecimals = await tryCall(() => pool.getTokenDecimals());
    const localDecimals = rawDecimals === undefined ? 18n : BigInt(rawDecimals);

    const tokenMatches =
      String(poolToken).toLowerCase() === String(poolInfo.vaultAddress).toLowerCase();
    console.log(
      tokenMatches ? ok(`token          ${poolToken}`) : bad(`token MISMATCH ${poolToken}`)
    );

    /**
     * Our inbound bucket must absorb what the REMOTE pool can send, so the only meaningful
     * comparison is against that pool's OUTBOUND config for the same bucket family — comparing
     * against our own outbound says nothing about the far side. Reports UNKNOWN rather than
     * passing when the remote RPC is unset or its pool is unreadable, so an unchecked lane is
     * never mistaken for a checked one.
     */
    const compareInboundAgainstRemote = async (
      remote: ChainSpec,
      inbound: any,
      fastFinality: boolean,
      label: string
    ) => {
      if (!inbound.isEnabled) return;
      const far = await remoteOutboundFor(remote, spec, poolKey, fastFinality);
      if (!far) {
        console.log(
          info_(
            `${label}inbound vs ${remote.name} outbound: UNKNOWN (${remote.rpcEnv} unset or pool unreadable)`
          )
        );
        return;
      }
      if (!far.isEnabled) {
        console.log(
          bad(`${remote.name} sends ${label}unthrottled while our ${label}inbound is capped`)
        );
        return;
      }
      // Compare in whole tokens so a decimals difference between the two chains' share tokens
      // does not silently skew the comparison.
      const scale = (v: bigint, d: bigint) => Number(v) / 10 ** Number(d);
      const inRate = scale(inbound.rate, localDecimals);
      const inCap = scale(inbound.capacity, localDecimals);
      const farRate = scale(far.rate, far.decimals);
      const farCap = scale(far.capacity, far.decimals);
      if (inRate < farRate) {
        console.log(
          bad(`${label}inbound rate ${inRate}/s < ${remote.name} outbound ${farRate}/s — throttles`)
        );
      } else if (inRate < farRate * 1.1) {
        console.log(
          info_(
            `${label}inbound rate ${inRate}/s has <10% headroom over ${remote.name} (${farRate}/s)`
          )
        );
      }
      // A single transfer the far side can emit must also fit our bucket, or it can never be
      // delivered however long we wait — refill never exceeds capacity.
      if (inCap < farCap) {
        console.log(
          bad(
            `${label}inbound capacity ${inCap} < ${remote.name} outbound capacity ${farCap} — a max-size transfer can never fit`
          )
        );
      }
    };

    // Tracks, per lane, whether a fast-finality bucket is configured. Judged once the pool's
    // allowedFinality is known, since an unset FTF limit only matters if FTF is permitted.
    const ftfLaneState: { name: string; limitsSet: boolean }[] = [];

    // Lane wiring towards each configured remote chain, plus the per-lane limits and fees that
    // CCIP 2.0 adds. A 1.6 pool has none of these getters, so tryCall yields undefined and the
    // block is skipped rather than reported as a failure.
    for (const remote of remotes) {
      const supported = await tryCall(() => pool.isSupportedChain(remote.selector));
      if (!supported) {
        console.log(bad(`lane -> ${remote.name}: NOT configured (run ccip:apply-chain-updates)`));
        continue;
      }
      const remoteToken = await tryCall(() => pool.getRemoteToken(remote.selector));
      console.log(ok(`lane -> ${remote.name}: configured, remote token ${remoteToken}`));

      // isSupportedChain and getRemoteToken are not the whole lane. TokenPool also requires the
      // SENDING pool to be in this pool's remote-pool set for the chain, and rejects the transfer
      // on arrival if it isn't — a failure this preflight existed to catch and was reporting as
      // "configured". Compare against what the remote chain's own deployment file records.
      const expectedRemotePool = remotePoolAddress(remote, poolKey);
      if (!expectedRemotePool) {
        console.log(
          info_(
            `lane -> ${remote.name}: no '${poolKey}' pool recorded there, remote pool unchecked`
          )
        );
      } else {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [expectedRemotePool]);
        const registered = await tryCall(() => pool.isRemotePool(remote.selector, encoded));
        if (registered === undefined) {
          console.log(info_(`lane -> ${remote.name}: pool predates isRemotePool, unchecked`));
        } else if (registered) {
          console.log(ok(`lane -> ${remote.name}: remote pool ${expectedRemotePool} registered`));
        } else {
          console.log(
            bad(
              `lane -> ${remote.name}: remote pool ${expectedRemotePool} NOT registered — inbound transfers from it will be rejected (run ccip:apply-chain-updates)`
            )
          );
        }
      }

      const normal = await tryCall(() => pool.getCurrentRateLimiterState(remote.selector, false));
      const fast = await tryCall(() => pool.getCurrentRateLimiterState(remote.selector, true));
      if (normal) {
        console.log(info_(`limits  out ${fmtLimit(normal[0])} | in ${fmtLimit(normal[1])}`));
        // Each direction is its own bucket, so a disabled one is unbounded on its own and has to
        // be reported on its own — not only when both happen to be off.
        if (!normal[0].isEnabled) {
          console.log(
            bad("OUTBOUND rate limit disabled — unbounded; CCIP applies none of its own")
          );
        }
        if (!normal[1].isEnabled) {
          console.log(bad("INBOUND rate limit disabled — unbounded; CCIP applies none of its own"));
        }

        await compareInboundAgainstRemote(remote, normal[1], false, "");
      }
      if (fast) {
        const ftfOn = fast[0].isEnabled || fast[1].isEnabled;
        if (ftfOn) {
          console.log(info_(`FTF     out ${fmtLimit(fast[0])} | in ${fmtLimit(fast[1])}`));
          if (!fast[0].isEnabled) {
            console.log(bad("FTF OUTBOUND limit disabled while the inbound one is set"));
          }
          if (!fast[1].isEnabled) {
            console.log(bad("FTF INBOUND limit disabled while the outbound one is set"));
          }
          // Same cross-chain question for the fast-finality pair. Omitting it meant an FTF lane
          // could pass with a destination bucket far smaller than what the source may emit —
          // and on the FTF path the source has already burned, so an undersized inbound bucket
          // strands shares rather than merely delaying them.
          await compareInboundAgainstRemote(remote, fast[1], true, "FTF ");
        }
        // The dangerous config is FTF permitted by the pool with no FTF bucket to bound it:
        // a source reorg after an early mint leaves duplicated shares on the destination, and
        // this limit is what caps how much can be minted inside the reorg window. Previously
        // this case printed nothing at all, so it read as a clean lane.
        ftfLaneState.push({ name: remote.name, limitsSet: ftfOn });
      }

      // The RFC commits to zero pool fees. These are deducted from the transferred asset, so a
      // nonzero value silently delivers less than was sent.
      const fee = await tryCall(() =>
        pool.getTokenTransferFeeConfig(
          poolInfo.vaultAddress,
          remote.selector,
          FINALITY_DEFAULT,
          "0x"
        )
      );
      if (fee) {
        const bps = BigInt(fee.finalityTransferFeeBps ?? 0);
        const ffBps = BigInt(fee.fastFinalityTransferFeeBps ?? 0);
        if (bps === 0n && ffBps === 0n) {
          console.log(ok("pool fees      0 bps both finalities"));
        } else {
          console.log(bad(`pool fees NONZERO: finality ${bps} bps, fast-finality ${ffBps} bps`));
          console.log(info_("the RFC commits to zero — these are deducted from the transfer"));
        }
      }
    }

    // Pool-wide CCIP 2.0 config: who can move limits in a hurry, and what finality is accepted.
    const dyn = await tryCall(() => pool.getDynamicConfig());
    if (dyn) {
      const [dynRouter, rateLimitAdmin, feeAdmin] = dyn;
      const routerMatches = String(dynRouter).toLowerCase() === spec.router.toLowerCase();
      console.log(
        routerMatches ? ok(`router         ${dynRouter}`) : bad(`router MISMATCH ${dynRouter}`)
      );
      if (rateLimitAdmin === ethers.ZeroAddress) {
        console.log(bad("rateLimitAdmin UNSET — rate-limit changes go through the owner"));
        console.log(info_("if the owner is a Timelock, that is the timelock delay mid-incident"));
        console.log(info_("set it with ccip:set-dynamic-config"));
      } else {
        console.log(ok(`rateLimitAdmin ${rateLimitAdmin}`));
      }
      console.log(info_(`feeAdmin       ${feeAdmin}`));
    }

    const allowedFinality = await tryCall(() => pool.getAllowedFinalityConfig());
    if (allowedFinality !== undefined) {
      const f = String(allowedFinality);
      const line = `allowedFinality ${f} — ${describeFinality(f)}`;
      // FTF is intended to be ON at mainnet launch, so this reports rather than fails. It is
      // still called out on a production lane: it trades reorg safety for latency, and an
      // operator reading this output should see which lanes carry that tradeoff rather than
      // have it blend into the passing lines.
      const ftfPermitted = BigInt(f) !== 0n;
      if (ftfPermitted && PRODUCTION_NETWORKS.has(spec.key)) {
        console.log(ok(`${line}  (FTF enabled — intended on production lanes)`));
        // A high allowed depth does NOT tighten anything while the safe-tag bit is set: the
        // two are independent acceptance paths, so a request carrying the safe tag is admitted
        // regardless of the depth floor. Raising the floor means dropping 0x00010000.
        if ((Number(BigInt(f)) & 0x00010000) !== 0) {
          console.log(
            info_("safe-tag path is open, so the block-depth floor does not bound acceptance")
          );
        }
      } else {
        console.log(ok(line));
      }

      // FTF permitted but unbounded is the configuration to catch, on any network.
      if (ftfPermitted) {
        for (const lane of ftfLaneState) {
          if (!lane.limitsSet) {
            console.log(bad(`FTF permitted but NO fast-finality rate limit on ${lane.name}`));
            console.log(info_("set one with ccip:set-ftf-limits before carrying real value"));
          }
        }
      }
    }

    // Is CCIP pointing the token at this pool?
    const tar = new ethers.Contract(spec.tokenAdminRegistry, TAR_ABI, provider);
    const registeredPool = await tryCall(() => tar.getPool(poolInfo.vaultAddress));
    if (registeredPool && String(registeredPool).toLowerCase() === poolInfo.address.toLowerCase()) {
      console.log(ok("TokenAdminRegistry: pointed at this pool"));
    } else {
      console.log(
        bad(`TokenAdminRegistry: pool is ${registeredPool ?? "?"} (run ccip:register-admin)`)
      );
    }

    // Is the vault letting this pool mint/burn?
    const vault = new ethers.Contract(poolInfo.vaultAddress, VAULT_ABI, provider);
    const adapter = await tryCall(() => vault.bridgeAdapter());
    if (adapter && String(adapter).toLowerCase() === poolInfo.address.toLowerCase()) {
      console.log(ok("vault.bridgeAdapter: pointed at this pool — LIVE"));
    } else {
      console.log(bad(`vault.bridgeAdapter: ${adapter ?? "?"} (cutover not done — pool is inert)`));
    }
  }
}

async function verifyVault(
  provider: ethers.Provider,
  spec: ChainSpec,
  entry: { label: string; address: string }
) {
  console.log(`\n  Ember vault ${entry.label}  ${entry.address}`);
  if (!(await hasCode(provider, entry.address))) {
    console.log(bad("no code at the vault address"));
    return;
  }
  const vault = new ethers.Contract(entry.address, VAULT_ABI, provider);
  const [version, name, symbol, decimals, supply, owner, protocolConfig] = await Promise.all([
    tryCall(() => vault.version()),
    tryCall(() => vault.name()),
    tryCall(() => vault.symbol()),
    tryCall(() => vault.decimals()),
    tryCall(() => vault.totalSupply()),
    tryCall(() => vault.owner()),
    tryCall(() => vault.protocolConfig()),
  ]);
  console.log(info_(`version   ${version ?? "?"}   ${name ?? "?"} (${symbol ?? "?"})`));
  console.log(info_(`decimals  ${decimals ?? "?"}   totalSupply ${supply ?? "?"}`));
  console.log(info_(`config    ${protocolConfig ?? "?"}`));

  // Who signs which step. `registerAdminViaOwner` requires owner(); the cutover
  // (`EmberProtocolConfig.setVaultBridgeAdapter`) requires roles.admin. On-chain values are
  // authoritative — the deployment JSON records the addresses at deploy time and goes stale
  // once ownership moves to a Timelock.
  const roles = await tryCall(() => vault.roles());
  console.log(info_(`owner()            ${owner ?? "?"}   <- calls registerAdminViaOwner`));
  console.log(info_(`roles.admin        ${roles?.admin ?? "?"}   <- calls setVaultBridgeAdapter`));
  if (roles) {
    console.log(info_(`roles.operator     ${roles.operator}`));
    console.log(info_(`roles.rateManager  ${roles.rateManager}`));
  }

  // The decisive check: does this vault expose the bridge hooks at all?
  const bridgeAdapter = await tryCall(() => vault.bridgeAdapter());
  if (bridgeAdapter === undefined) {
    console.log(
      bad("bridgeAdapter() reverted — this vault predates bridge support, cannot host a pool")
    );
  } else {
    console.log(
      ok(
        `bridgeAdapter ${bridgeAdapter}${
          bridgeAdapter === ethers.ZeroAddress ? "  (unset — free for the CCIP pool)" : ""
        }`
      )
    );
    const [minAmt, maxAmt] = await Promise.all([
      tryCall(() => vault.minBridgeAmount()),
      tryCall(() => vault.maxBridgeAmount()),
    ]);
    console.log(
      info_(`bridge limits  min=${minAmt ?? "?"}  max=${maxAmt ?? "?"}  (0 = unbounded)`)
    );
  }

  // Is the token already known to CCIP?
  const tar = new ethers.Contract(spec.tokenAdminRegistry, TAR_ABI, provider);
  const cfg = await tryCall(() => tar.getTokenConfig(entry.address));
  if (cfg) {
    const registered = cfg.administrator !== ethers.ZeroAddress;
    console.log(
      registered
        ? info_(`TokenAdminRegistry: admin=${cfg.administrator} pool=${cfg.tokenPool}`)
        : ok("TokenAdminRegistry: token not yet registered (expected before we register it)")
    );
  }
}

async function main() {
  console.log("CCIP configuration verification — read-only, broadcasts nothing");
  for (const network of NETWORKS) {
    const partners = getLanePartners(network).filter((p) => CCIP_NETWORKS[p]);
    await verifyChain(specFor(network), partners.map(specFor));
  }
  console.log(`\n${"=".repeat(78)}\nDone.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
