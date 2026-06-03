import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Upgrades EmberVaultValidator proxy to a new implementation.
 *
 * Usage:
 * - Uses deployments/<network>-deployment.json by default
 * - Optional env var VAULT_VALIDATOR_PROXY overrides proxy address from deployment file
 *
 * Example:
 *   VAULT_VALIDATOR_PROXY=0x... yarn upgrade:vault-validator --network sepolia
 */
async function main() {
  console.log("\n🔄 Upgrading EmberVaultValidator...\n");

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

  const proxyFromDeployment = deploymentInfo?.contracts?.vaultValidator?.proxyAddress;
  const proxyAddress = process.env.VAULT_VALIDATOR_PROXY || proxyFromDeployment;

  if (!proxyAddress) {
    console.error("❌ Error: Vault validator proxy address not found!");
    console.log(
      "Set VAULT_VALIDATOR_PROXY or ensure contracts.vaultValidator.proxyAddress exists."
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Upgrade Target");
  console.log("=".repeat(70));
  console.log("Proxy:", proxyAddress);

  const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  const vaultValidator = await ethers.getContractAt("EmberVaultValidator", proxyAddress);
  const currentVersion = await vaultValidator.version();

  console.log("Current Implementation:", currentImpl);
  console.log("Current Version:", currentVersion);
  console.log("=".repeat(70));

  // Safety delay before sending an upgrade transaction.
  console.log("\n⚠️  WARNING: This will upgrade EmberVaultValidator on", network.name);
  console.log("⚠️  Make sure this implementation has been tested and audited.");
  console.log("\nContinuing in 5 seconds... (Press Ctrl+C to cancel)");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("\n🚀 Starting upgrade process...\n");

  const VaultValidatorFactory = await ethers.getContractFactory("EmberVaultValidator");

  // Validate storage-layout compatibility BEFORE deploying anything.
  console.log("🔒 Validating upgrade compatibility...");
  try {
    await upgrades.validateUpgrade(proxyAddress, VaultValidatorFactory, { kind: "uups" });
    console.log("   ✅ Upgrade is storage-layout compatible");
  } catch (err: any) {
    console.error("\n❌ Upgrade validation FAILED — aborting.");
    console.error(err?.message ?? err);
    console.error(
      "\nIf this proxy is missing from .openzeppelin/<network>.json,",
      "run `upgrades.forceImport(proxy, Factory, { kind: 'uups' })` once",
      "to register the deployed implementation, then retry. Do NOT bypass this check."
    );
    process.exit(1);
  }

  console.log("\n📦 Deploying new EmberVaultValidator implementation via upgrades plugin...");
  const newImplementationAddress = (await upgrades.deployImplementation(VaultValidatorFactory, {
    kind: "uups",
    redeployImplementation: "always",
  })) as string;
  const newImplementation = await ethers.getContractAt(
    "EmberVaultValidator",
    newImplementationAddress
  );

  console.log("✅ New Implementation deployed at:", newImplementationAddress);

  const newImplVersion = await newImplementation.version();
  console.log("New Implementation Version:", newImplVersion);

  if (currentImpl.toLowerCase() === newImplementationAddress.toLowerCase()) {
    console.log("\n⏭️  Proxy is already on this implementation. Nothing to upgrade.");
    process.exit(0);
  }

  console.log("\n📝 Upgrading proxy to new implementation...");
  console.log("From:", currentImpl);
  console.log("To:  ", newImplementationAddress);

  const upgradeTx = await vaultValidator.upgradeToAndCall(newImplementationAddress, "0x");
  console.log("Transaction hash:", upgradeTx.hash);
  console.log("Waiting for confirmation...");

  const upgradeReceipt = await upgradeTx.wait();
  console.log("✅ Upgrade confirmed in block:", upgradeReceipt?.blockNumber);
  console.log("Gas used:", upgradeReceipt?.gasUsed.toString());

  const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  const versionAfter = await vaultValidator.version();

  console.log("\n📊 Post-Upgrade Verification:");
  console.log("Implementation:", implAfter);
  console.log("Version:", versionAfter);

  if (implAfter.toLowerCase() !== newImplementationAddress.toLowerCase()) {
    throw new Error(
      `Upgrade verification failed! Expected ${newImplementationAddress} but got ${implAfter}`
    );
  }

  if (!deploymentInfo.contracts) {
    deploymentInfo.contracts = {};
  }

  if (!deploymentInfo.contracts.vaultValidator) {
    deploymentInfo.contracts.vaultValidator = {};
  }

  deploymentInfo.contracts.vaultValidator.proxyAddress = proxyAddress;
  deploymentInfo.contracts.vaultValidator.implementationAddress = newImplementationAddress;
  deploymentInfo.contracts.vaultValidator.version = versionAfter;
  deploymentInfo.contracts.vaultValidator.upgradedAt = new Date().toISOString();
  deploymentInfo.contracts.vaultValidator.upgradedInBlock = upgradeReceipt?.blockNumber || 0;

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberVaultValidator Upgrade Complete!");
  console.log("=".repeat(70));
  console.log("Proxy Address:", proxyAddress);
  console.log("Previous Implementation:", currentImpl);
  console.log("New Implementation:", newImplementationAddress);
  console.log("Version:", versionAfter);
  console.log("Tx Hash:", upgradeReceipt?.hash);
  console.log("Block:", upgradeReceipt?.blockNumber);
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
