import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Deploys the EmberProtocolConfig contract using UUPS proxy pattern
 * Saves deployment information to <network>-deployment.json
 *
 * Optional ENV variables:
 * - PLATFORM_FEE_RECIPIENT: Platform fee recipient address (defaults to deployer if not set)
 * - OWNER_ADDRESS: Owner address for the protocol config (defaults to deployer if not set)
 *
 */
async function main() {
  console.log("\n🚀 Deploying EmberProtocolConfig...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Get platform fee recipient address (defaults to deployer if not set)
  const platformFeeRecipient = process.env.PLATFORM_FEE_RECIPIENT || deployer.address;
  const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;

  // Deploy the EmberProtocolConfig contract
  const EmberProtocolConfigFactory = await ethers.getContractFactory("EmberProtocolConfig");

  console.log("Deploying EmberProtocolConfig proxy...");
  const config = (await upgrades.deployProxy(
    EmberProtocolConfigFactory,
    [ownerAddress, platformFeeRecipient], // initialOwner, platformFeeRecipient
    {
      initializer: "initialize",
      kind: "uups",
    }
  )) as any;

  await config.waitForDeployment();

  const proxyAddress = await config.getAddress();
  console.log("✅ EmberProtocolConfig Proxy deployed to:", proxyAddress);

  // Get deployment block number
  const deploymentTx = config.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("📝 Implementation address:", implementationAddress);

  // Get contract version
  const version = await config.version();
  console.log("📌 Contract version:", version);

  // Save deployment information
  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId.toString(),
    contracts: {
      protocolConfig: {
        proxyAddress: proxyAddress,
        implementationAddress: implementationAddress,
        ownerAddress: ownerAddress,
        version: version,
        deployedAt: new Date().toISOString(),
        deploymentBlockNumber: deploymentBlockNumber,
      },
    },
  };

  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberProtocolConfig Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nProxy Address:", proxyAddress);
  console.log("Implementation Address:", implementationAddress);
  console.log("Version:", version);
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("Owner Address:", deployer.address);
  console.log("Platform Fee Recipient:", platformFeeRecipient);
  console.log();
  console.log("=".repeat(70) + "\n");
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
