import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Deploys the EmberVaultValidator contract using UUPS proxy pattern
 * Reads protocol config from deployment JSON and saves deployment information
 * to <network>-deployment.json
 *
 * Optional ENV variables:
 * - OWNER_ADDRESS: Owner address for the validator contract (defaults to deployer if not set)
 *
 */
async function main() {
  console.log("\n🚀 Deploying EmberVaultValidator...\n");

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

  // Load existing deployment file (protocol config must already be deployed)
  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  let deploymentInfo: any = {
    network: network.name,
    chainId: network.chainId.toString(),
    contracts: {},
  };

  if (fs.existsSync(deploymentFileName)) {
    console.log("\n📂 Loading existing deployment file:", deploymentFileName);
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  } else {
    console.error("❌ Error: Deployment file not found!");
    console.log("Please deploy the protocol config first using: yarn deploy:config");
    process.exit(1);
  }

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    console.log("Please deploy the protocol config first using: yarn deploy:config");
    process.exit(1);
  }

  const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;

  console.log("Protocol Config Address:", protocolConfigAddress);
  console.log("Owner Address:", ownerAddress);
  console.log();

  // Deploy the EmberVaultValidator contract
  const EmberVaultValidatorFactory = await ethers.getContractFactory("EmberVaultValidator");

  console.log("Deploying EmberVaultValidator proxy...");
  const validator = (await upgrades.deployProxy(
    EmberVaultValidatorFactory,
    [protocolConfigAddress, ownerAddress],
    {
      initializer: "initialize",
      kind: "uups",
    }
  )) as any;

  await validator.waitForDeployment();

  const proxyAddress = await validator.getAddress();
  console.log("✅ EmberVaultValidator Proxy deployed to:", proxyAddress);

  // Get deployment block number
  const deploymentTx = validator.deploymentTransaction();
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
  const version = await validator.version();
  console.log("📌 Contract version:", version);

  // Save deployment information

  deploymentInfo.contracts.vaultValidator = {
    proxyAddress: proxyAddress,
    implementationAddress: implementationAddress,
    protocolConfigAddress: protocolConfigAddress,
    ownerAddress: ownerAddress,
    version: version,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
  };

  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberVaultValidator Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nProxy Address:", proxyAddress);
  console.log("Implementation Address:", implementationAddress);
  console.log("Version:", version);
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Owner:", ownerAddress);
  console.log();
  console.log("Next step: Set the validator on each vault by calling:");
  console.log('  protocolConfig.setVaultValidator(vaultAddress, "' + proxyAddress + '")');
  console.log();
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
