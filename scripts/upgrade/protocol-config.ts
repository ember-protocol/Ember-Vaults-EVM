import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Upgrades EmberProtocolConfig proxy to a new implementation.
 *
 * Usage:
 * - Uses deployments/<network>-deployment.json by default
 * - Optional env var PROTOCOL_CONFIG_PROXY overrides proxy address from deployment file
 *
 * Example:
 *   PROTOCOL_CONFIG_PROXY=0x... yarn upgrade:protocol-config --network sepolia
 */
async function main() {
  console.log("\n🔄 Upgrading EmberProtocolConfig...\n");

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

  const proxyFromDeployment = deploymentInfo?.contracts?.protocolConfig?.proxyAddress;
  const proxyAddress = process.env.PROTOCOL_CONFIG_PROXY || proxyFromDeployment;

  if (!proxyAddress) {
    console.error("❌ Error: Protocol config proxy address not found!");
    console.log(
      "Set PROTOCOL_CONFIG_PROXY or ensure contracts.protocolConfig.proxyAddress exists."
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("📋 Upgrade Target");
  console.log("=".repeat(70));
  console.log("Proxy:", proxyAddress);

  const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", proxyAddress);
  const currentVersion = await protocolConfig.version();

  console.log("Current Implementation:", currentImpl);
  console.log("Current Version:", currentVersion);
  console.log("=".repeat(70));

  // Safety delay before sending an upgrade transaction.
  console.log("\n⚠️  WARNING: This will upgrade EmberProtocolConfig on", network.name);
  console.log("⚠️  Make sure this implementation has been tested and audited.");
  console.log("\nContinuing in 5 seconds... (Press Ctrl+C to cancel)");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("\n🚀 Starting upgrade process...\n");

  console.log("📦 Deploying new EmberProtocolConfig implementation...");
  const ProtocolConfigFactory = await ethers.getContractFactory("EmberProtocolConfig");
  const newImplementation = await ProtocolConfigFactory.deploy();
  await newImplementation.waitForDeployment();
  const newImplementationAddress = await newImplementation.getAddress();

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

  const upgradeTx = await protocolConfig.upgradeToAndCall(newImplementationAddress, "0x");
  console.log("Transaction hash:", upgradeTx.hash);
  console.log("Waiting for confirmation...");

  const upgradeReceipt = await upgradeTx.wait();
  console.log("✅ Upgrade confirmed in block:", upgradeReceipt?.blockNumber);
  console.log("Gas used:", upgradeReceipt?.gasUsed.toString());

  const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  const versionAfter = await protocolConfig.version();

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

  if (!deploymentInfo.contracts.protocolConfig) {
    deploymentInfo.contracts.protocolConfig = {};
  }

  deploymentInfo.contracts.protocolConfig.proxyAddress = proxyAddress;
  deploymentInfo.contracts.protocolConfig.implementationAddress = newImplementationAddress;
  deploymentInfo.contracts.protocolConfig.version = versionAfter;
  deploymentInfo.contracts.protocolConfig.upgradedAt = new Date().toISOString();
  deploymentInfo.contracts.protocolConfig.upgradedInBlock = upgradeReceipt?.blockNumber || 0;

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment file updated:", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberProtocolConfig Upgrade Complete!");
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
