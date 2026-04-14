import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Deploys an ERC20Token contract using UUPS proxy pattern
 * Reads configuration from environment variables and appends to deployment JSON
 *
 * Required ENV variables:
 * - TOKEN_NAME: Token name (e.g., "USD Coin")
 * - TOKEN_SYMBOL: Token symbol (e.g., "USDC")
 * - TOKEN_DECIMALS: Token decimals (e.g., 6 for USDC, 18 for most tokens)
 *
 * Optional ENV variables:
 * - OWNER_ADDRESS: Owner address for the token (defaults to deployer if not set)
 */
async function main() {
  console.log("\n🪙 Deploying ERC20Token...\n");

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

  // Read token configuration from environment variables
  const tokenOwner = process.env.OWNER_ADDRESS || deployer.address;
  const tokenName = process.env.TOKEN_NAME;
  const tokenSymbol = process.env.TOKEN_SYMBOL;
  const tokenDecimals = process.env.TOKEN_DECIMALS;

  // Validate required parameters
  if (!tokenName || !tokenSymbol || !tokenDecimals) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  TOKEN_NAME       - Token name (e.g., 'USD Coin')");
    console.log("  TOKEN_SYMBOL     - Token symbol (e.g., 'USDC')");
    console.log("  TOKEN_DECIMALS   - Token decimals (e.g., 6 or 18)");
    console.log("\nOptional variables:");
    console.log("  TOKEN_OWNER      - Token owner address (defaults to deployer)");
    console.log("\nExample:");
    console.log(
      '  TOKEN_NAME="USD Coin" TOKEN_SYMBOL="USDC" TOKEN_DECIMALS=6 yarn deploy:deposit-token'
    );
    process.exit(1);
  }

  const decimalsNum = parseInt(tokenDecimals);
  if (isNaN(decimalsNum) || decimalsNum < 0 || decimalsNum > 18) {
    console.error("❌ Error: TOKEN_DECIMALS must be a number between 0 and 18");
    process.exit(1);
  }

  console.log("Token Configuration:");
  console.log("  Name:", tokenName);
  console.log("  Symbol:", tokenSymbol);
  console.log("  Decimals:", decimalsNum);
  console.log("  Owner:", tokenOwner);
  console.log("  Initial Supply: 0 (as specified)");
  console.log();

  // Deploy the ERC20Token contract
  const ERC20TokenFactory = await ethers.getContractFactory("ERC20Token");

  console.log("Deploying ERC20Token proxy...");
  const token = (await upgrades.deployProxy(
    ERC20TokenFactory,
    [
      tokenOwner, // initialOwner
      tokenName, // name
      tokenSymbol, // symbol
      decimalsNum, // decimals
      0, // initialSupply (always 0 as specified)
    ],
    {
      initializer: "initialize",
      kind: "uups",
    }
  )) as any;

  await token.waitForDeployment();

  const proxyAddress = await token.getAddress();
  console.log("✅ ERC20Token Proxy deployed to:", proxyAddress);

  // Get deployment block number
  const deploymentTx = token.deploymentTransaction();
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
  const version = await token.version();
  console.log("📌 Contract version:", version);

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

  // Initialize erc20Tokens object if it doesn't exist
  if (!deploymentInfo.contracts.depositTokens) {
    deploymentInfo.contracts.depositTokens = {};
  }

  // Check if token ID already exists
  if (deploymentInfo.contracts.depositTokens[tokenSymbol]) {
    console.warn(`\n⚠️  Warning: Token with ID '${tokenSymbol}' already exists!`);
    console.log(
      "Existing address:",
      deploymentInfo.contracts.depositTokens[tokenSymbol].proxyAddress
    );
  }

  // Add or update the token deployment info
  deploymentInfo.contracts.depositTokens[tokenSymbol] = {
    proxyAddress: proxyAddress,
    implementationAddress: implementationAddress,
    ownerAddress: tokenOwner,
    name: tokenName,
    symbol: tokenSymbol,
    decimals: decimalsNum,
    version: version,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
  };

  // Save deployment information
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Receipt Token Deployment Complete!");
  console.log("=".repeat(70));
  console.log("Token Name:", tokenName);
  console.log("Token Symbol:", tokenSymbol);
  console.log("Proxy Address:", proxyAddress);
  console.log("Implementation Address:", implementationAddress);
  console.log("Owner Address:", tokenOwner);
  console.log("Decimals:", decimalsNum);
  console.log("Version:", version);
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
