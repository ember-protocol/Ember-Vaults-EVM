import { artifacts, ethers } from "hardhat";
import { getImplementationAddressWithRetry } from "./utils/erc1967";
import * as fs from "fs";

/**
 * Upgrades an upgradeable contract (proxy) to a specific, ALREADY-DEPLOYED
 * implementation address via UUPS `upgradeToAndCall` (onlyOwner).
 *
 * Unlike scripts/upgrade/*.ts (which deploy a fresh implementation through the
 * upgrades plugin), this points a proxy at an implementation you already have
 * the address of.
 *
 * Required ENV variables:
 * - TARGET:             Which proxy to upgrade. One of:
 *                         - "protocolConfig" or "vaultValidator" (singletons)
 *                         - "<group>.<key>", where <group> is one of
 *                             vaults | ethVaults | atomicLiquidityVaults | depositParkingLots
 *                           e.g. "depositParkingLots.emberUsdBeta",
 *                                "atomicLiquidityVaults.emberAtomicInt."
 *                         - a bare "<key>", accepted only when it exists in exactly one
 *                           group. Parking lots are keyed by their vault's key, so e.g.
 *                           "emberUsdBeta" is ambiguous and must be qualified.
 *                         - a proxy address (0x...). If it is recorded in the deployment
 *                           file it is treated exactly like its key.
 * - NEW_IMPLEMENTATION:  Address of the already-deployed new implementation
 *
 * Optional ENV variables:
 * - INIT_DATA:           Calldata forwarded to upgradeToAndCall (default "0x")
 *
 * Per-type checks:
 * - depositParkingLots: these hold user escrow. `totalPendingAssets` and the live
 *   pending-deposit count are read before and after the upgrade, and any change fails
 *   the run (same rule as scripts/upgrade/deposit-parking-lot.ts).
 * - atomicLiquidityVaults: the libraries linked into NEW_IMPLEMENTATION are read from
 *   its bytecode at the offsets the compiled AtomicLiquidity artifact records, shown
 *   before upgrading, and written to the deployment entry afterwards. A linked
 *   AtomicLiquidityLib other than `contracts.atomicLiquidityLib` is flagged.
 *
 * Note: Only the proxy OWNER can upgrade. When the owner is a timelock, the script
 * prints the `admin:gen-timelock-upgrade` command that schedules the same upgrade.
 */

const ABI = [
  "function owner() view returns (address)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function version() view returns (string)",
];

const PARKING_LOT_ABI = [
  "function totalPendingAssets() view returns (uint256)",
  "function getLivePendingDepositsCount() view returns (uint256)",
];

/** Keyed proxy groups in the deployment file, and the contract each one holds. */
const GROUPS = {
  vaults: "EmberVault",
  ethVaults: "EmberETHVault",
  atomicLiquidityVaults: "AtomicLiquidity",
  depositParkingLots: "EmberDepositParkingLot",
} as const;
type Group = keyof typeof GROUPS;
const GROUP_NAMES = Object.keys(GROUPS) as Group[];

const SINGLETONS = {
  protocolConfig: "EmberProtocolConfig",
  vaultValidator: "EmberVaultValidator",
} as const;
type Singleton = keyof typeof SINGLETONS;

/** AtomicLiquidity deployment-entry field for each library linked into its implementation. */
const ATOMIC_LIQUIDITY_LIB_FIELDS: Record<string, string> = {
  AtomicLiquidityLib: "libraryAddress",
  VaultPlatformFeeLib: "vaultPlatformFeeLibAddress",
  WithdrawalQueueLib: "withdrawalQueueLibAddress",
};

type ResolvedTarget = {
  address: string;
  label: string;
  kind?: Group | Singleton; // undefined for an address not recorded in the deployment file
  contractName?: string;
  entry?: any; // deployment-file entry to update (undefined for unrecorded addresses)
};

type Resolution = { target: ResolvedTarget } | { ambiguous: string[] } | { notFound: true };

const addrOf = (e: any): string | undefined => e?.proxyAddress || e?.address;

function groupTarget(contracts: any, group: Group, key: string): ResolvedTarget | undefined {
  const entry = contracts?.[group]?.[key];
  if (!entry || !addrOf(entry)) return undefined;
  return {
    address: addrOf(entry)!,
    label: `${group}.${key}`,
    kind: group,
    contractName: GROUPS[group],
    entry,
  };
}

function singletonTarget(contracts: any, name: Singleton): ResolvedTarget | undefined {
  const entry = contracts?.[name];
  if (!entry || !addrOf(entry)) return undefined;
  return {
    address: addrOf(entry)!,
    label: name,
    kind: name,
    contractName: SINGLETONS[name],
    entry,
  };
}

/** Every recorded upgradeable proxy, with its qualified label. */
function allTargets(contracts: any): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  for (const name of Object.keys(SINGLETONS) as Singleton[]) {
    const t = singletonTarget(contracts, name);
    if (t) targets.push(t);
  }
  for (const group of GROUP_NAMES) {
    for (const key of Object.keys(contracts?.[group] || {})) {
      const t = groupTarget(contracts, group, key);
      if (t) targets.push(t);
    }
  }
  return targets;
}

/** Resolve TARGET to a deployed proxy address + the deployment entry to update. */
function resolveTarget(contracts: any, target: string): Resolution {
  if (target in SINGLETONS) {
    const t = singletonTarget(contracts, target as Singleton);
    return t ? { target: t } : { notFound: true };
  }

  // "<group>.<key>". Split on the FIRST dot only: keys may themselves contain dots
  // (e.g. "emberAtomicInt.").
  const dot = target.indexOf(".");
  if (dot > 0 && (GROUP_NAMES as string[]).includes(target.slice(0, dot))) {
    const t = groupTarget(contracts, target.slice(0, dot) as Group, target.slice(dot + 1));
    return t ? { target: t } : { notFound: true };
  }

  if (ethers.isAddress(target)) {
    // A recorded proxy gets the same per-type checks and deployment-file update as its key.
    const recorded = allTargets(contracts).filter(
      (t) => t.address.toLowerCase() === target.toLowerCase()
    );
    if (recorded.length > 1) return { ambiguous: recorded.map((t) => t.label) };
    if (recorded.length === 1) return { target: recorded[0] };
    return { target: { address: ethers.getAddress(target), label: target } };
  }

  // Bare key: only when it names exactly one proxy. Parking lots share their vault's key, and
  // both are UUPS, so silently picking one would let a vault be pointed at a parking-lot
  // implementation (or the reverse) and the upgrade would succeed.
  const matches = GROUP_NAMES.map((g) => groupTarget(contracts, g, target)).filter(
    (t): t is ResolvedTarget => t !== undefined
  );
  if (matches.length > 1) return { ambiguous: matches.map((t) => t.label) };
  if (matches.length === 1) return { target: matches[0] };
  return { notFound: true };
}

function printTargets(contracts: any) {
  console.log("\nAvailable targets:");
  allTargets(contracts).forEach((t) => console.log(`  - ${t.label}`));
}

async function getVersion(address: string): Promise<string | null> {
  try {
    return await (await ethers.getContractAt(ABI, address)).version();
  } catch {
    return null;
  }
}

async function readEscrow(address: string): Promise<{ assets: bigint; live: bigint }> {
  const lot = await ethers.getContractAt(PARKING_LOT_ABI, address);
  const [assets, live] = await Promise.all([
    lot.totalPendingAssets(),
    lot.getLivePendingDepositsCount(),
  ]);
  return { assets, live };
}

/**
 * Library addresses linked into an AtomicLiquidity `implementation`, read from its deployed
 * bytecode at the offsets the compiled AtomicLiquidity artifact records. Returns undefined
 * when the deployed bytecode doesn't line up with this build: every reference to a library
 * must carry the same address, and that address must have code.
 */
async function readLinkedLibraries(
  implementation: string
): Promise<Record<string, string> | undefined> {
  const { deployedLinkReferences } = await artifacts.readArtifact("AtomicLiquidity");
  const code = (await ethers.provider.getCode(implementation)).slice(2);
  const linked: Record<string, string> = {};
  try {
    for (const libraries of Object.values(deployedLinkReferences)) {
      for (const [name, refs] of Object.entries(libraries)) {
        const found = new Set(
          refs.map((r) => code.slice(r.start * 2, (r.start + r.length) * 2).toLowerCase())
        );
        if (found.size !== 1) return undefined;
        const address = ethers.getAddress("0x" + [...found][0]);
        if ((await ethers.provider.getCode(address)) === "0x") return undefined;
        linked[name] = address;
      }
    }
  } catch {
    return undefined;
  }
  return linked;
}

async function main() {
  console.log("\n🔄 Updating Contract Implementation...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const contracts = deploymentInfo.contracts || {};

  const target = process.env.TARGET;
  const newImplementation = process.env.NEW_IMPLEMENTATION;
  const initData = process.env.INIT_DATA || "0x";

  if (!target || !newImplementation) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log(
      `  TARGET             - protocolConfig | vaultValidator | <group>.<key> | <key> | 0x<address>`
    );
    console.log(`                       <group> = ${GROUP_NAMES.join(" | ")}`);
    console.log("  NEW_IMPLEMENTATION - Address of the already-deployed implementation");
    printTargets(contracts);
    process.exit(1);
  }

  if (!ethers.isAddress(newImplementation)) {
    console.error(`❌ Error: Invalid NEW_IMPLEMENTATION address: ${newImplementation}`);
    process.exit(1);
  }
  if (!ethers.isHexString(initData)) {
    console.error(`❌ Error: INIT_DATA must be a 0x-prefixed hex string`);
    process.exit(1);
  }

  const resolution = resolveTarget(contracts, target);
  if ("ambiguous" in resolution) {
    console.error(`❌ Error: Target '${target}' matches more than one proxy. Use one of:`);
    resolution.ambiguous.forEach((label) => console.log(`  - ${label}`));
    process.exit(1);
  }
  if ("notFound" in resolution) {
    console.error(
      `❌ Error: Target '${target}' not found in deployment file (and not a valid address)!`
    );
    printTargets(contracts);
    process.exit(1);
  }
  const resolved = resolution.target;

  // The new implementation must actually be deployed.
  if ((await ethers.provider.getCode(newImplementation)) === "0x") {
    console.error(
      `❌ Error: NEW_IMPLEMENTATION has no code on ${networkName}: ${newImplementation}`
    );
    process.exit(1);
  }

  const proxy = await ethers.getContractAt(ABI, resolved.address);
  const currentImpl = await getImplementationAddressWithRetry(resolved.address);
  const owner = await proxy.owner();
  const currentVersion = await getVersion(resolved.address);
  const newVersion = await getVersion(newImplementation);

  console.log("Configuration:");
  console.log("  Target:", resolved.label);
  console.log("  Contract:", resolved.contractName ?? "(not recorded in deployment file)");
  console.log("  Proxy:", resolved.address);
  console.log("  Owner:", owner);
  console.log(`  Current Implementation: ${currentImpl} (version: ${currentVersion ?? "?"})`);
  console.log(`  New Implementation:     ${newImplementation} (version: ${newVersion ?? "?"})`);
  console.log("  Init Data:", initData);
  console.log("  Signer matches Owner:", signer.address.toLowerCase() === owner.toLowerCase());

  // Parking lots hold user escrow: snapshot it so the upgrade can be shown not to move it.
  let escrowBefore: { assets: bigint; live: bigint } | undefined;
  if (resolved.kind === "depositParkingLots") {
    escrowBefore = await readEscrow(resolved.address);
    console.log("  Escrowed Assets:", escrowBefore.assets.toString());
    console.log("  Live Pending Deposits:", escrowBefore.live.toString());
  }

  // AtomicLiquidity links external libraries at deploy time, so the implementation address
  // alone doesn't say which library code the proxy will run.
  let linkedLibraries: Record<string, string> | undefined;
  if (resolved.kind === "atomicLiquidityVaults") {
    linkedLibraries = await readLinkedLibraries(newImplementation);
    if (!linkedLibraries) {
      console.warn(
        "  ⚠️  Could not read the libraries linked into NEW_IMPLEMENTATION: its bytecode does not" +
          "\n      match this build's AtomicLiquidity link references. Verify the linked" +
          "\n      AtomicLiquidityLib by hand; the deployment entry's library fields will not be updated."
      );
    } else {
      console.log("  Linked Libraries:");
      for (const [name, address] of Object.entries(linkedLibraries)) {
        console.log(`    ${name}: ${address}`);
      }
      const recordedLib = contracts.atomicLiquidityLib?.address;
      if (
        recordedLib &&
        linkedLibraries.AtomicLiquidityLib?.toLowerCase() !== recordedLib.toLowerCase()
      ) {
        console.warn(
          `  ⚠️  NEW_IMPLEMENTATION is linked to AtomicLiquidityLib ${linkedLibraries.AtomicLiquidityLib},` +
            `\n      not the one recorded at contracts.atomicLiquidityLib (${recordedLib}).` +
            "\n      An implementation linked to a library built from different source mis-decodes" +
            "\n      the library calls — confirm this is the library you intend."
        );
      }
    }
  }
  console.log();

  // No-op if already on the target implementation
  if (currentImpl.toLowerCase() === newImplementation.toLowerCase()) {
    console.log("✅ Proxy is already on this implementation. No action needed.");
    process.exit(0);
  }

  // Only the owner can upgrade
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.error("❌ Error: Signer is not the proxy owner!");
    console.log("  Signer:", signer.address);
    console.log("  Owner: ", owner);
    console.log(
      "\nOnly the owner can upgrade. If the owner is a timelock, generate the schedule/execute" +
        "\ntransactions for the same upgrade with:"
    );
    console.log(
      `\n  CONTRACT_NAME=${resolved.contractName ?? "<ContractName>"} PROXY_ADDRESS=${resolved.address} ` +
        `NEW_IMPL=${newImplementation} yarn admin:gen-timelock-upgrade --network ${networkName}`
    );
    process.exit(1);
  }

  if (currentVersion && newVersion && currentVersion === newVersion) {
    console.warn(
      `⚠️  version() is unchanged (${currentVersion}) — confirm the new implementation is correct.`
    );
  }

  // Simulate first for a clearer error if it would revert.
  console.log("Upgrading implementation...");
  try {
    await proxy.upgradeToAndCall.staticCall(newImplementation, initData);
    console.log("Static call succeeded, proceeding with transaction...");
  } catch (staticCallError: any) {
    console.error("\n❌ Error: Transaction simulation failed!");
    console.log("This usually means the transaction would revert on-chain.");
    console.log("\nPossible reasons:");
    console.log("  - Signer is not the proxy owner");
    console.log("  - New implementation is not UUPS-compatible / storage-incompatible");
    console.log("  - INIT_DATA reverted");
    if (staticCallError.reason) console.log("\nRevert reason:", staticCallError.reason);
    if (staticCallError.data) console.log("Revert data:", staticCallError.data);
    if (staticCallError.message) console.log("Error message:", staticCallError.message);
    process.exit(1);
  }

  const tx = await proxy.upgradeToAndCall(newImplementation, initData);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify the implementation was updated correctly
  const implAfter = await getImplementationAddressWithRetry(resolved.address);
  if (implAfter.toLowerCase() === newImplementation.toLowerCase()) {
    console.log("\n✅ Implementation updated successfully!");
  } else {
    console.error("\n❌ Error: Upgrade verification failed!");
    console.log("Expected:", newImplementation);
    console.log("Got:     ", implAfter);
    process.exit(1);
  }

  // Escrow accounting must survive the upgrade untouched. A change means the new layout reads
  // different slots — fail loudly instead of recording a clean upgrade.
  if (escrowBefore) {
    const escrowAfter = await readEscrow(resolved.address);
    console.log("Escrowed Assets after:", escrowAfter.assets.toString());
    console.log("Live Pending Deposits after:", escrowAfter.live.toString());
    if (escrowAfter.assets !== escrowBefore.assets || escrowAfter.live !== escrowBefore.live) {
      console.error("\n❌ ESCROW STATE CHANGED ACROSS THE UPGRADE — investigate immediately!");
      console.error(
        `  totalPendingAssets:  ${escrowBefore.assets.toString()} -> ${escrowAfter.assets.toString()}`
      );
      console.error(
        `  livePendingDeposits: ${escrowBefore.live.toString()} -> ${escrowAfter.live.toString()}`
      );
      console.error("The deployment file has NOT been updated.");
      process.exit(1);
    }
  }

  // Update the deployment file entry (skip for unrecorded addresses).
  if (resolved.entry) {
    resolved.entry.implementationAddress = newImplementation;
    const versionAfter = await getVersion(resolved.address);
    if (versionAfter) resolved.entry.version = versionAfter;
    if ("ownerAddress" in resolved.entry) resolved.entry.ownerAddress = await proxy.owner();
    if (linkedLibraries) {
      for (const [name, field] of Object.entries(ATOMIC_LIQUIDITY_LIB_FIELDS)) {
        if (linkedLibraries[name]) resolved.entry[field] = linkedLibraries[name];
      }
    }
    resolved.entry.upgradedAt = new Date().toISOString();
    resolved.entry.upgradedInBlock = receipt?.blockNumber || 0;
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("Deployment file updated:", deploymentFileName);
  }

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Implementation Update Complete!");
  console.log("=".repeat(70));
  console.log("\nTarget:", resolved.label);
  console.log("Proxy:", resolved.address);
  console.log("Previous Implementation:", currentImpl);
  console.log("New Implementation:", newImplementation);
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
