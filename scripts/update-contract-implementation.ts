import { ethers, upgrades } from "hardhat";
import { getImplementationAddressWithRetry } from "./utils/erc1967";
import * as fs from "fs";

/**
 * Upgrades an upgradeable contract (proxy) to a specific, ALREADY-DEPLOYED
 * implementation address via UUPS `upgradeToAndCall` (onlyOwner).
 *
 * Unlike scripts/upgrade/vault.ts (which deploys a fresh implementation through
 * the upgrades plugin), this points a proxy at an implementation you already
 * have the address of.
 *
 * Required ENV variables:
 * - TARGET:             Which contract to upgrade. One of:
 *                         - "protocolConfig" or "vaultValidator" (singletons)
 *                         - a vault key (contracts.vaults)
 *                         - an ETH vault key (contracts.ethVaults)
 *                         - a raw proxy address (0x...)
 * - NEW_IMPLEMENTATION:  Address of the already-deployed new implementation
 *
 * Optional ENV variables:
 * - INIT_DATA:           Calldata forwarded to upgradeToAndCall (default "0x")
 *
 * Note: Only the proxy OWNER can upgrade. Once the owner is a timelock, this
 * must instead be scheduled through that timelock.
 */

const ABI = [
  "function owner() view returns (address)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function version() view returns (string)",
];

type ResolvedTarget = {
  address: string;
  label: string;
  entry?: any; // deployment-file entry to update (undefined for raw addresses)
};

/** Resolve TARGET to a deployed proxy address + the deployment entry to update. */
function resolveTarget(contracts: any, target: string): ResolvedTarget | undefined {
  const addrOf = (e: any): string | undefined => e?.proxyAddress || e?.address;

  if (target === "protocolConfig" && addrOf(contracts.protocolConfig)) {
    return {
      address: addrOf(contracts.protocolConfig)!,
      label: "protocolConfig",
      entry: contracts.protocolConfig,
    };
  }
  if (target === "vaultValidator" && addrOf(contracts.vaultValidator)) {
    return {
      address: addrOf(contracts.vaultValidator)!,
      label: "vaultValidator",
      entry: contracts.vaultValidator,
    };
  }
  for (const group of ["vaults", "ethVaults"]) {
    const entry = contracts?.[group]?.[target];
    if (entry && addrOf(entry)) {
      return { address: addrOf(entry)!, label: `${group}.${target}`, entry };
    }
  }
  if (ethers.isAddress(target)) {
    return { address: ethers.getAddress(target), label: target };
  }
  return undefined;
}

function listTargets(contracts: any): string[] {
  const names: string[] = [];
  if (contracts.protocolConfig) names.push("protocolConfig");
  if (contracts.vaultValidator) names.push("vaultValidator");
  for (const group of ["vaults", "ethVaults"]) {
    for (const key of Object.keys(contracts?.[group] || {})) names.push(`${key} (${group})`);
  }
  return names;
}

async function getVersion(address: string): Promise<string | null> {
  try {
    return await (await ethers.getContractAt(ABI, address)).version();
  } catch {
    return null;
  }
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
      "  TARGET             - protocolConfig | vaultValidator | <vaultKey> | <ethVaultKey> | 0x<address>"
    );
    console.log("  NEW_IMPLEMENTATION - Address of the already-deployed implementation");
    console.log("\nAvailable targets:");
    listTargets(contracts).forEach((t) => console.log(`  - ${t}`));
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

  const resolved = resolveTarget(contracts, target);
  if (!resolved) {
    console.error(
      `❌ Error: Target '${target}' not found in deployment file (and not a valid address)!`
    );
    console.log("\nAvailable targets:");
    listTargets(contracts).forEach((t) => console.log(`  - ${t}`));
    process.exit(1);
  }

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
  console.log("  Proxy:", resolved.address);
  console.log("  Owner:", owner);
  console.log(`  Current Implementation: ${currentImpl} (version: ${currentVersion ?? "?"})`);
  console.log(`  New Implementation:     ${newImplementation} (version: ${newVersion ?? "?"})`);
  console.log("  Init Data:", initData);
  console.log("  Signer matches Owner:", signer.address.toLowerCase() === owner.toLowerCase());
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
      "\nOnly the owner can upgrade. If the owner is a timelock, schedule the upgrade through it."
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

  // Update the deployment file entry (skip for raw-address targets).
  if (resolved.entry) {
    resolved.entry.implementationAddress = newImplementation;
    const versionAfter = await getVersion(resolved.address);
    if (versionAfter) resolved.entry.version = versionAfter;
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
