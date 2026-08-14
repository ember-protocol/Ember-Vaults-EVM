import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import { AtomicLiquidity__factory } from "../../typechain-types";

/**
 * Upgrades AtomicLiquidity proxies to a new implementation, optionally re-linked to a new
 * AtomicLiquidityLib bytecode.
 *
 * Behavior:
 * 1. Resolves the library address (env override > deployment-file record).
 * 2. Deploys a new AtomicLiquidity implementation linked to that library.
 * 3. For each requested vault, calls `upgradeToAndCall(newImpl, "0x")` on the proxy.
 *
 * Usage:
 *   yarn upgrade:atomic-liquidity
 *      → upgrades ALL atomicLiquidityVaults entries
 *
 *   ATOMIC_LIQUIDITY_KEYS=atomicLiquidityUsdc yarn upgrade:atomic-liquidity
 *      → upgrades only the listed keys (comma-separated)
 *
 *   ATOMIC_LIQUIDITY_LIB_ADDRESS=0x… yarn upgrade:atomic-liquidity
 *      → links the new implementation to the given library instead of the recorded one
 *
 * Notes:
 *   The library is non-upgradeable bytecode at a fixed address. If you need to change the
 *   library bytecode, deploy a new library first (FORCE_REDEPLOY_LIB=true yarn deploy:atomic-liquidity-lib),
 *   then run this upgrade with ATOMIC_LIQUIDITY_LIB_ADDRESS set to the new library address.
 *   Storage layout of EmberShareConfig / HoldbackEntry is fixed across library versions
 *   because they live in the AtomicLiquidity proxy storage; the library only carries logic.
 */
async function main() {
  console.log("\n🔄 Upgrading AtomicLiquidity...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Upgrading with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found!");
    console.log("File:", deploymentFileName);
    process.exit(1);
  }

  console.log("📂 Loading deployment file:", deploymentFileName);
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const vaults = deploymentInfo.contracts.atomicLiquidityVaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    console.error("❌ Error: No atomicLiquidityVaults found in deployment file!");
    process.exit(1);
  }

  const libAddress =
    process.env.ATOMIC_LIQUIDITY_LIB_ADDRESS ||
    deploymentInfo.contracts.atomicLiquidityLib?.address;
  if (!libAddress) {
    console.error("❌ Error: AtomicLiquidityLib address not found!");
    console.log("Run: yarn deploy:atomic-liquidity-lib");
    process.exit(1);
  }

  // The post-Ottersec / AI-audit AtomicLiquidity impl links to two additional libraries.
  // An upgrade that omits either fails at factory-creation with "missing links".
  const platformFeeLibAddress =
    process.env.VAULT_PLATFORM_FEE_LIB_ADDRESS ||
    deploymentInfo.contracts.vaultPlatformFeeLib?.address;
  const withdrawalQueueLibAddress =
    process.env.WITHDRAWAL_QUEUE_LIB_ADDRESS ||
    deploymentInfo.contracts.withdrawalQueueLib?.address;
  if (!platformFeeLibAddress || !withdrawalQueueLibAddress) {
    console.error("❌ Error: VaultPlatformFeeLib / WithdrawalQueueLib address not found!");
    console.log("Run: yarn deploy:vault-libraries");
    console.log(
      "Or pass VAULT_PLATFORM_FEE_LIB_ADDRESS / WITHDRAWAL_QUEUE_LIB_ADDRESS for out-of-band libraries."
    );
    process.exit(1);
  }

  // Resolve which vaults to upgrade.
  const keysEnv = process.env.ATOMIC_LIQUIDITY_KEYS;
  const keysToUpgrade: string[] = keysEnv
    ? keysEnv.split(",").map((k) => k.trim())
    : Object.keys(vaults);

  for (const k of keysToUpgrade) {
    if (!vaults[k]) {
      console.error(`❌ Error: Vault '${k}' not found in deployment file!`);
      console.log("Available:", Object.keys(vaults).join(", "));
      process.exit(1);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Vaults to Upgrade:");
  console.log("=".repeat(70));
  for (const k of keysToUpgrade) {
    const v = vaults[k];
    console.log(`\n${k}:`);
    console.log(`  Proxy:                   ${v.proxyAddress}`);
    console.log(`  Current Implementation:  ${v.implementationAddress}`);
    console.log(`  Current Library:         ${v.libraryAddress ?? "<unknown>"}`);
    console.log(`  Name:                    ${v.name}`);
    console.log(`  Version:                 ${v.version}`);
  }

  console.log("\nLibraries to link new implementation against:");
  console.log("  AtomicLiquidityLib:   ", libAddress);
  console.log("  VaultPlatformFeeLib:  ", platformFeeLibAddress);
  console.log("  WithdrawalQueueLib:   ", withdrawalQueueLibAddress);
  console.log("\n" + "=".repeat(70));

  console.log("\n⚠️  WARNING: This will upgrade", keysToUpgrade.length, "vault(s)!");
  console.log("⚠️  Ensure storage layout is unchanged from the previous implementation.");
  console.log("⚠️  Ensure the linked library matches the new implementation's expectations.");
  console.log("\nContinuing in 5 seconds... (Press Ctrl+C to cancel)");
  await new Promise((r) => setTimeout(r, 5000));

  console.log("\n🚀 Deploying new AtomicLiquidity implementation linked to libraries...");
  const factory = (await ethers.getContractFactory("AtomicLiquidity", {
    libraries: {
      AtomicLiquidityLib: libAddress,
      VaultPlatformFeeLib: platformFeeLibAddress,
      WithdrawalQueueLib: withdrawalQueueLibAddress,
    },
  })) as AtomicLiquidity__factory;

  const newImpl = await factory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log("   ✅ New implementation:", newImplAddress);

  const newImplVersion = await newImpl.version();
  console.log("   New Implementation Version:", newImplVersion);

  const results: any[] = [];

  for (const key of keysToUpgrade) {
    const info = vaults[key];
    const proxyAddress = info.proxyAddress;

    console.log("\n" + "-".repeat(70));
    console.log(`🔄 Upgrading ${key}`);
    console.log(`   Proxy: ${proxyAddress}`);
    console.log("-".repeat(70));

    try {
      const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      console.log("   Current Implementation:", currentImpl);

      const vault = await ethers.getContractAt("AtomicLiquidity", proxyAddress);
      const currentVersion = await vault.version();
      console.log("   Current Version:", currentVersion);

      if (currentImpl.toLowerCase() === newImplAddress.toLowerCase()) {
        console.log("\n   ⚠️  Already on the new implementation, skipping.");
        results.push({ key, success: true, proxyAddress, newImplAddress, skipped: true });
        continue;
      }

      console.log("\n   📝 Calling upgradeToAndCall(newImpl, '0x') on proxy...");
      const tx = await vault.upgradeToAndCall(newImplAddress, "0x");
      console.log("   tx hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("   ✅ Confirmed in block:", receipt?.blockNumber);
      console.log("   Gas used:", receipt?.gasUsed.toString());

      const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      const newVersion = await vault.version();

      console.log("\n   📊 Post-Upgrade Verification:");
      console.log("      Implementation:      ", implAfter);
      console.log("      AtomicLiquidityLib:  ", libAddress);
      console.log("      VaultPlatformFeeLib: ", platformFeeLibAddress);
      console.log("      WithdrawalQueueLib:  ", withdrawalQueueLibAddress);
      console.log("      Version:             ", newVersion);

      if (implAfter.toLowerCase() !== newImplAddress.toLowerCase()) {
        throw new Error(
          `Upgrade verification failed! Expected ${newImplAddress} but got ${implAfter}`
        );
      }

      info.implementationAddress = newImplAddress;
      info.libraryAddress = libAddress;
      info.vaultPlatformFeeLibAddress = platformFeeLibAddress;
      info.withdrawalQueueLibAddress = withdrawalQueueLibAddress;
      info.version = newVersion;
      info.upgradedAt = new Date().toISOString();
      info.upgradedInBlock = receipt?.blockNumber || 0;

      results.push({
        key,
        success: true,
        proxyAddress,
        newImplAddress,
        libAddress,
        txHash: receipt?.hash,
        blockNumber: receipt?.blockNumber,
      });

      console.log(`   ✅ Successfully upgraded ${key}`);
    } catch (err: any) {
      console.error(`   ❌ Failed to upgrade ${key}:`, err.message);
      results.push({ key, success: false, proxyAddress, error: err.message });
    }
  }

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("📊 UPGRADE SUMMARY");
  console.log("=".repeat(70));

  const successful = results.filter((r) => r.success && !r.skipped);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failed = results.filter((r) => !r.success);

  console.log(`\n✅ Successfully upgraded: ${successful.length}/${results.length}`);
  if (skipped.length > 0) console.log(`⏭️  Skipped: ${skipped.length} (already upgraded)`);

  if (successful.length > 0) {
    console.log("\nSuccessful Upgrades:");
    for (const r of successful) {
      console.log(`  ✓ ${r.key}`);
      console.log(`    Proxy:    ${r.proxyAddress}`);
      console.log(`    New impl: ${r.newImplAddress}`);
      console.log(`    Library:  ${r.libAddress}`);
      console.log(`    Tx:       ${r.txHash}`);
      console.log(`    Block:    ${r.blockNumber}`);
    }
  }

  if (skipped.length > 0) {
    console.log("\nSkipped Vaults:");
    for (const r of skipped) {
      console.log(`  ⏭️  ${r.key}  → already on ${r.newImplAddress}`);
    }
  }

  if (failed.length > 0) {
    console.log("\n❌ Failed Upgrades:");
    for (const r of failed) {
      console.log(`  ✗ ${r.key} (${r.proxyAddress}): ${r.error}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Upgrade Process Complete!");
  console.log("=".repeat(70) + "\n");

  if (failed.length > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
