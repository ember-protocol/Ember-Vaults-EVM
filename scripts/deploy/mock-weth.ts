import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deploys the MockWETH contract (non-upgradeable) for testing
 * Saves deployment info to deployment JSON file
 *
 * Usage:
 *   yarn hardhat run scripts/deploy/mock-weth.ts --network sepolia
 */
async function main() {
  console.log("\n🪙 Deploying MockWETH...\n");

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

  // Deploy MockWETH
  const MockWETHFactory = await ethers.getContractFactory("MockWETH");

  console.log("Deploying MockWETH...");
  const mockWETHDeployment = await MockWETHFactory.deploy();
  await mockWETHDeployment.waitForDeployment();

  const wethAddress = await mockWETHDeployment.getAddress();
  console.log("✅ MockWETH deployed to:", wethAddress);

  // Get deployment block number
  const deploymentTx = mockWETHDeployment.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  // Get contract instance with ERC20 interface for type safety
  const mockWETH = await ethers.getContractAt("MockWETH", wethAddress);

  // Get token details
  const name = await mockWETH.name();
  const symbol = await mockWETH.symbol();
  const decimals = await mockWETH.decimals();

  console.log("\n📊 Token Details:");
  console.log("  Name:", name);
  console.log("  Symbol:", symbol);
  console.log("  Decimals:", decimals);

  // Load existing deployment file or create new one
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
    console.log("\n📂 Creating new deployment file:", deploymentFileName);
  }

  // Initialize depositTokens object if it doesn't exist
  if (!deploymentInfo.contracts.depositTokens) {
    deploymentInfo.contracts.depositTokens = {};
  }

  // Check if MockWETH already exists
  if (deploymentInfo.contracts.depositTokens.WETH) {
    console.warn(`\n⚠️  Warning: MockWETH already exists!`);
    console.log("Existing address:", deploymentInfo.contracts.depositTokens.WETH.address);
    console.log("New address:", wethAddress);
    console.log("\nOverwriting existing MockWETH deployment.");
  }

  // Add or update MockWETH deployment info
  deploymentInfo.contracts.depositTokens.WETH = {
    address: wethAddress,
    name: name,
    symbol: symbol,
    decimals: decimals.toString(),
    isMock: true,
    supportsPermit: true,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
  };

  // Save deployment information
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 MockWETH Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nToken Details:");
  console.log("  Address:", wethAddress);
  console.log("  Name:", name);
  console.log("  Symbol:", symbol);
  console.log("  Decimals:", decimals);
  console.log("  Supports Permit:", "Yes (EIP-2612)");
  console.log("  Deployment Block:", deploymentBlockNumber);
  console.log("\n💡 Next Steps:");
  console.log("1. Wrap ETH to WETH:");
  console.log(`   mockWETH.deposit({ value: ethers.parseEther("1.0") })`);
  console.log("2. Unwrap WETH to ETH:");
  console.log(`   mockWETH.withdraw(ethers.parseEther("1.0"))`);
  console.log("3. Deploy EmberETHVault using this WETH address");
  console.log("\n⚠️  Note: This is a MOCK contract for testing only!");
  console.log("   Real WETH on mainnet: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
