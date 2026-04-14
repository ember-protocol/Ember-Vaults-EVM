import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Deploys the EmberVault contract using UUPS proxy pattern
 * Reads configuration from environment variables and saves to deployment JSON
 *
 * Required ENV variables:
 * - VAULT_NAME: Name of the vault (e.g., "Ember USDC Vault")
 * - VAULT_RECEIPT_TOKEN_SYMBOL: Symbol of the receipt token (e.g., "eUSDC")
 * - VAULT_COLLATERAL_TOKEN: Address of the collateral token
 * - VAULT_ADMIN: Admin address
 * - VAULT_OPERATOR: Manager/Operator address
 * - VAULT_RATE_MANAGER: Rate manager address
 *
 * Optional ENV variables:
 * - VAULT_OWNER: Owner address (defaults to deployer)
 * - VAULT_MAX_RATE_CHANGE: Max rate change per update (defaults to 0.01e18 = 1%)
 * - VAULT_FEE_PERCENTAGE: Platform fee percentage (defaults to 0.001e18 = 0.1%)
 * - VAULT_MIN_WITHDRAWABLE_SHARES: Min withdrawable shares (defaults to 1e6)
 * - VAULT_RATE_UPDATE_INTERVAL: Rate update interval in ms (defaults to 3600001 = 1 hour)
 * - VAULT_MAX_TVL: Maximum TVL (defaults to 1e30 = very large)
 * - VAULT_SUB_ACCOUNTS: Comma-separated list of sub-account addresses
 */
async function main() {
  console.log("\n🏦 Deploying EmberVault...\n");

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
    console.error("❌ Error: Deployment file not found!");
    console.log("Please deploy the protocol config first using: yarn deploy:config");
    console.log("And then deploy the receipt token first using: yarn deploy:token");
    console.log("And then deploy the vault using: yarn deploy:vault");
    process.exit(1);
  }

  // Read required parameters from environment
  const vaultName = process.env.VAULT_NAME;
  const vaultReceiptTokenSymbol = process.env.VAULT_RECEIPT_TOKEN_SYMBOL;
  const collateralToken = process.env.VAULT_COLLATERAL_TOKEN;
  const admin = process.env.VAULT_ADMIN;
  const operator = process.env.VAULT_OPERATOR;
  const rateManager = process.env.VAULT_RATE_MANAGER;

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;

  // Validate required parameters
  if (
    !vaultName ||
    !vaultReceiptTokenSymbol ||
    !collateralToken ||
    !admin ||
    !operator ||
    !rateManager ||
    !protocolConfigAddress
  ) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_NAME                   - Vault name (e.g., 'Ember USDC Vault')");
    console.log("  VAULT_RECEIPT_TOKEN_SYMBOL   - Receipt token symbol (e.g., 'eUSDC')");
    console.log("  VAULT_COLLATERAL_TOKEN       - Collateral token address");
    console.log("  VAULT_ADMIN                  - Admin address");
    console.log("  VAULT_OPERATOR               - Operator address");
    console.log("  VAULT_RATE_MANAGER           - Rate manager address");
    console.log("\nOptional variables:");
    console.log("  VAULT_OWNER                  - Owner address (defaults to deployer)");
    console.log("  VAULT_MAX_RATE_CHANGE        - Max rate change (defaults to 0.01e18)");
    console.log("  VAULT_FEE_PERCENTAGE         - Fee percentage (defaults to 0.001e18)");
    console.log("  VAULT_MIN_WITHDRAWABLE_SHARES - Min withdrawable (defaults to 1e6)");
    console.log("  VAULT_RATE_UPDATE_INTERVAL   - Rate interval ms (defaults to 3600001)");
    console.log("  VAULT_MAX_TVL                - Max TVL (defaults to 1e30)");
    console.log("  VAULT_SUB_ACCOUNTS           - Comma-separated addresses");
    console.log("\nNote: Make sure to deploy the Protocol Config first!");
    process.exit(1);
  }

  // Match on-chain initializer rules early so failures are actionable.
  if (admin === operator || admin === rateManager || operator === rateManager) {
    console.error(
      "❌ Error: VAULT_ADMIN, VAULT_OPERATOR, and VAULT_RATE_MANAGER must be distinct addresses."
    );
    console.log("Current values:");
    console.log("  VAULT_ADMIN:", admin);
    console.log("  VAULT_OPERATOR:", operator);
    console.log("  VAULT_RATE_MANAGER:", rateManager);
    process.exit(1);
  }

  // Read optional parameters with defaults
  const owner = process.env.VAULT_OWNER || deployer.address;
  const maxRateChangePerUpdate = process.env.VAULT_MAX_RATE_CHANGE || "10000000000000000"; // 0.01e18 = 1%
  const feePercentage = process.env.VAULT_FEE_PERCENTAGE || "1000000000000000"; // 0.001e18 = 0.1%
  const minWithdrawableShares = process.env.VAULT_MIN_WITHDRAWABLE_SHARES || "1000000"; // 1e6
  const rateUpdateInterval = process.env.VAULT_RATE_UPDATE_INTERVAL || "3600001"; // 1 hour in ms
  const maxTVL = process.env.VAULT_MAX_TVL || "1000000000000000000000000000000"; // 1e30
  const subAccountsStr = process.env.VAULT_SUB_ACCOUNTS || "";
  const subAccounts = subAccountsStr ? subAccountsStr.split(",").map((addr) => addr.trim()) : [];

  console.log("Vault Configuration:");
  console.log("  Name:", vaultName);
  console.log("  Receipt Token Symbol:", vaultReceiptTokenSymbol);
  console.log("  Collateral Token:", collateralToken);
  console.log("  Admin:", admin);
  console.log("  Operator:", operator);
  console.log("  Rate Manager:", rateManager);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Owner:", owner);
  console.log("  Max Rate Change:", maxRateChangePerUpdate);
  console.log("  Fee Percentage:", feePercentage);
  console.log("  Min Withdrawable Shares:", minWithdrawableShares);
  console.log("  Rate Update Interval (ms):", rateUpdateInterval);
  console.log("  Max TVL:", maxTVL);
  console.log("  Sub Accounts:", subAccounts.length > 0 ? subAccounts.join(", ") : "None");
  console.log();

  // Prepare VaultInitParams struct
  const vaultInitParams = {
    name: vaultName,
    receiptTokenSymbol: vaultReceiptTokenSymbol,
    collateralToken: collateralToken,
    admin: admin,
    operator: operator,
    rateManager: rateManager,
    maxRateChangePerUpdate: maxRateChangePerUpdate,
    feePercentage: feePercentage,
    minWithdrawableShares: minWithdrawableShares,
    rateUpdateInterval: rateUpdateInterval,
    maxTVL: maxTVL,
  };

  // Deploy the EmberVault contract
  const EmberVaultFactory = await ethers.getContractFactory("EmberVault");

  console.log("Deploying EmberVault proxy...");
  const vault = (await upgrades.deployProxy(
    EmberVaultFactory,
    [protocolConfigAddress, owner, vaultInitParams, subAccounts],
    {
      initializer: "initialize",
      kind: "uups",
    }
  )) as any;

  await vault.waitForDeployment();

  const proxyAddress = await vault.getAddress();
  console.log("✅ EmberVault Proxy deployed to:", proxyAddress);

  // Get deployment block number
  const deploymentTx = vault.deploymentTransaction();
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
  const version = await vault.version();
  console.log("📌 Contract version:", version);

  // Get vault details
  const vaultNameOnChain = await vault.name();
  const maxTVLOnChain = await vault.maxTVL();
  const totalSupplyOnChain = await vault.totalSupply();

  console.log("\n📊 Vault Details:");
  console.log("  Name:", vaultNameOnChain);
  console.log("  Max TVL:", ethers.formatUnits(maxTVLOnChain, 18));
  console.log("  Total Supply:", ethers.formatUnits(totalSupplyOnChain, 18));
  console.log("  Owner:", await vault.owner());

  // Initialize vaults object if it doesn't exist
  if (!deploymentInfo.contracts.vaults) {
    deploymentInfo.contracts.vaults = {};
  }

  // Use vault name as key (convert to lowerCamelCase)
  const vaultKey = vaultName
    .split(/\s+/)
    .map((word, index) => {
      const cleanWord = word.toLowerCase();
      return index === 0 ? cleanWord : cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1);
    })
    .join("");

  // Check if vault already exists
  if (deploymentInfo.contracts.vaults[vaultKey]) {
    console.warn(`\n⚠️  Warning: Vault '${vaultKey}' already exists!`);
    console.log("Existing address:", deploymentInfo.contracts.vaults[vaultKey].proxyAddress);
    console.log("New address:", proxyAddress);
    console.log("\nOverwriting existing vault deployment.");
  }

  // Add or update the vault deployment info
  deploymentInfo.contracts.vaults[vaultKey] = {
    proxyAddress: proxyAddress,
    implementationAddress: implementationAddress,
    ownerAddress: owner,
    name: vaultName,
    receiptTokenSymbol: vaultReceiptTokenSymbol,
    collateralToken: collateralToken,
    admin: admin,
    operator: operator,
    rateManager: rateManager,
    protocolConfig: protocolConfigAddress,
    maxTVL: maxTVL,
    version: version,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
  };

  // Save deployment information
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  // Count total vaults
  const vaultCount = Object.keys(deploymentInfo.contracts.vaults).length;

  console.log("\n" + "=".repeat(70));
  console.log("🎉 EmberVault Deployment Complete!");
  console.log("=".repeat(70));
  console.log("\nVault Key:", vaultKey);
  console.log("Vault Name:", vaultName);
  console.log("Vault Receipt Token Symbol:", vaultReceiptTokenSymbol);
  console.log("Proxy Address:", proxyAddress);
  console.log("Implementation Address:", implementationAddress);
  console.log("Owner Address:", owner);
  console.log("Collateral Token:", collateralToken);
  console.log("Version:", version);
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("\nTotal Vaults Deployed:", vaultCount);
  console.log("Deployment File:", deploymentFileName);
  console.log("\n💡 Next Steps:");
  console.log("1. Approve collateral token for vault: token.approve(vaultAddress, amount)");
  console.log("2. Deposit tokens: vault.deposit(amount, recipient)");
  console.log("3. Update vault rate: vault.updateVaultRate(...) [Rate Manager only]");
  console.log("4. Withdraw tokens: vault.withdraw(shares, recipient, owner)");
  console.log("5. Verify contracts on Etherscan");
  console.log("\n💡 The vault is an ERC4626-style vault with integrated share token.");
  console.log("   Users can deposit collateral tokens and receive vault shares.");
  console.log("   Math operations use an inlined library for maximum gas efficiency.");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    console.dir(error);
    process.exit(1);
  });
