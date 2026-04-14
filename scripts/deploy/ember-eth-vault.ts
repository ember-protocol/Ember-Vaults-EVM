import { ethers, upgrades } from "hardhat";
import { Interface } from "ethers";

import * as fs from "fs";

/**
 * Deploys the EmberETHVault contract using UUPS proxy pattern
 * Reads configuration from environment variables and saves to deployment JSON
 *
 * Required ENV variables:
 * - VAULT_NAME: Name of the vault (e.g., "Ember ETH Vault")
 * - VAULT_RECEIPT_TOKEN_SYMBOL: Symbol of the receipt token (e.g., "eETH")
 * - VAULT_COLLATERAL_TOKEN: Address of the WETH contract (must be WETH)
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
  console.log("\n🏦 Deploying EmberETHVault...\n");

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
    console.log("And optionally deploy MockWETH using: yarn deploy:mock-weth");
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
    console.log("  VAULT_NAME                   - Vault name (e.g., 'Ember ETH Vault')");
    console.log("  VAULT_RECEIPT_TOKEN_SYMBOL   - Receipt token symbol (e.g., 'eETH')");
    console.log("  VAULT_COLLATERAL_TOKEN       - WETH contract address (must be WETH)");
    console.log("  VAULT_ADMIN                  - Admin address");
    console.log("  VAULT_OPERATOR               - Operator address");
    console.log("  VAULT_RATE_MANAGER           - Rate manager address");
    console.log("\nOptional variables:");
    console.log("  VAULT_OWNER                  - Owner address (defaults to deployer)");
    console.log("  VAULT_MAX_RATE_CHANGE        - Max rate change (defaults to 0.01e18)");
    console.log("  VAULT_FEE_PERCENTAGE         - Fee percentage (defaults to 0.001e18)");
    console.log("  VAULT_MIN_WITHDRAWABLE_SHARES - Min withdrawable (defaults to 1e6)");
    console.log("  VAULT_RATE_UPDATE_INTERVAL   - Rate interval ms (defaults to 3600001)");
    console.log("  VAULT_MAX_TVL                - Max TVL in ETH (defaults to 1e30)");
    console.log("  VAULT_SUB_ACCOUNTS           - Comma-separated addresses");
    console.log("\nNote: Make sure to deploy Protocol Config first!");
    console.log("\nWETH Addresses (use for VAULT_COLLATERAL_TOKEN):");
    console.log("  Mainnet: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    console.log("  Testnet: Deploy MockWETH first");
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
  console.log("  Collateral Token (WETH):", collateralToken);
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

  // Deploy the EmberETHVault contract
  const EmberETHVaultFactory = await ethers.getContractFactory("EmberETHVault");

  console.log("Deploying EmberETHVault proxy...");
  try {
    const vault = (await upgrades.deployProxy(
      EmberETHVaultFactory,
      [protocolConfigAddress, owner, vaultInitParams, subAccounts],
      {
        initializer: "initialize",
        kind: "uups",
      }
    )) as any;

    await vault.waitForDeployment();

    const proxyAddress = await vault.getAddress();
    console.log("✅ EmberETHVault Proxy deployed to:", proxyAddress);

    // Get deployment block number
    const vaultDeploymentTx = vault.deploymentTransaction();
    let vaultDeploymentBlockNumber = 0;
    if (vaultDeploymentTx) {
      const receipt = await vaultDeploymentTx.wait();
      vaultDeploymentBlockNumber = receipt?.blockNumber || 0;
      console.log("📦 Deployed in block:", vaultDeploymentBlockNumber);
    }

    // Get implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log("📝 Implementation address:", implementationAddress);

    // Get contract version
    const version = await vault.version();
    console.log("📌 Contract version:", version);

    // Get vault details
    const vaultNameOnChain = await vault.vaultName();
    const maxTVLOnChain = await vault.maxTVL();
    const totalSupplyOnChain = await vault.totalSupply();
    const collateralTokenOnChain = await vault.asset();

    console.log("\n📊 Vault Details:");
    console.log("  Name:", vaultNameOnChain);
    console.log("  Collateral Token (WETH):", collateralTokenOnChain);
    console.log("  Max TVL:", ethers.formatEther(maxTVLOnChain), "ETH");
    console.log("  Total Supply:", ethers.formatEther(totalSupplyOnChain));
    console.log("  Owner:", await vault.owner());

    // Initialize vaults object if it doesn't exist
    if (!deploymentInfo.contracts.ethVaults) {
      deploymentInfo.contracts.ethVaults = {};
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
    if (deploymentInfo.contracts.ethVaults[vaultKey]) {
      console.warn(`\n⚠️  Warning: ETH Vault '${vaultKey}' already exists!`);
      console.log("Existing address:", deploymentInfo.contracts.ethVaults[vaultKey].proxyAddress);
      console.log("New address:", proxyAddress);
      console.log("\nOverwriting existing vault deployment.");
    }

    // Add or update the ETH vault deployment info
    deploymentInfo.contracts.ethVaults[vaultKey] = {
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
      deploymentBlockNumber: vaultDeploymentBlockNumber,
    };

    // Save deployment information
    fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
    console.log("\n✅ Deployment info saved to", deploymentFileName);

    // Count total ETH vaults
    const vaultCount = Object.keys(deploymentInfo.contracts.ethVaults).length;

    console.log("\n" + "=".repeat(70));
    console.log("🎉 EmberETHVault Deployment Complete!");
    console.log("=".repeat(70));
    console.log("\nVault Key:", vaultKey);
    console.log("Vault Name:", vaultName);
    console.log("Vault Receipt Token Symbol:", vaultReceiptTokenSymbol);
    console.log("Proxy Address:", proxyAddress);
    console.log("Implementation Address:", implementationAddress);
    console.log("Owner Address:", owner);
    console.log("Collateral Token (WETH):", collateralToken);
    console.log("Version:", version);
    console.log("Deployment Block:", vaultDeploymentBlockNumber);
    console.log("\nTotal ETH Vaults Deployed:", vaultCount);
    console.log("Deployment File:", deploymentFileName);
    console.log("\n💡 Next Steps:");
    console.log("1. Deposit native ETH (wraps to WETH):");
    console.log(`   vault.depositETH(recipient, { value: ethers.parseEther("1.0") })`);
    console.log("2. Deposit WETH (standard ERC4626):");
    console.log("   weth.approve(vaultAddress, amount)");
    console.log("   vault.deposit(amount, recipient)");
    console.log("3. Mint shares with ETH (wraps to WETH):");
    console.log(`   vault.mintWithETH(shares, recipient, { value: ethers.parseEther("1.0") })`);
    console.log("4. Request withdrawal (receive ETH):");
    console.log("   vault.redeemShares(shares, recipient)");
    console.log("5. Process withdrawals (operator only, sends ETH to users):");
    console.log("   vault.processWithdrawalRequests(numRequests)");
    console.log("\n💡 Key Design:");
    console.log("   • Vault stores WETH (ERC20) - maintains ERC4626 compliance");
    console.log("   • User deposits: ETH → wrapped to WETH");
    console.log("   • User withdrawals: WETH → unwrapped to ETH");
    console.log("   • Sub-account withdrawals: Send WETH (for DeFi)");
    console.log("=".repeat(70) + "\n");
  } catch (error: any) {
    const contractABI = require("../../artifacts/contracts/EmberETHVault.sol/EmberETHVault.json");
    if (error.data) {
      console.error(error.data);
      // Try to decode the error
      const iface = new Interface(contractABI.abi);
      const decodedError = iface.parseError(error.data);
      console.error("Decoded error:", decodedError);
    }
    console.log("Error:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
