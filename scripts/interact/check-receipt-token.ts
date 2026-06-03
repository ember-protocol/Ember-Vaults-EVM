import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Checks the total supply of receipt tokens for a vault and the signer's balance
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 *
 * Optional ENV variables:
 * - CHECK_ADDRESS: Address to check balance for (defaults to signer)
 */
async function main() {
  console.log("\n📊 Checking Receipt Token Info...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  // Load deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Get parameters from environment
  const vaultKey = process.env.VAULT_KEY;
  const checkAddress = process.env.CHECK_ADDRESS || signer.address;

  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY environment variable is required!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY      - Key of the vault in deployment file");
    console.log("\nOptional variables:");
    console.log("  CHECK_ADDRESS  - Address to check balance for (defaults to signer)");

    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name} (${vault.proxyAddress})`);
      });
    }

    process.exit(1);
  }

  // Validate check address
  if (!ethers.isAddress(checkAddress)) {
    console.error(`❌ Error: Invalid CHECK_ADDRESS: ${checkAddress}`);
    process.exit(1);
  }

  // Get vault info from deployment
  const vaultInfo = deploymentInfo.contracts.vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
    console.log("\nAvailable vaults:");
    if (deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
    }
    process.exit(1);
  }

  console.log("Vault Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Receipt Token Symbol:", vaultInfo.receiptTokenSymbol);
  console.log("  Checking Balance For:", checkAddress);
  console.log();

  // Get vault contract (which is also the receipt token - ERC4626)
  const vault = await ethers.getContractAt("EmberVault", vaultInfo.proxyAddress);

  // Get token info
  const name = await vault.name();
  const symbol = await vault.symbol();
  const decimals = await vault.decimals();
  const totalSupply = await vault.totalSupply();
  const totalAssets = await vault.totalAssets();

  // Get balance for the specified address
  const balance = await vault.balanceOf(checkAddress);

  // Get current rate
  const rateInfo = await vault.rate();
  const currentRate = rateInfo.value;

  // Calculate the value of the balance in underlying assets
  let balanceValue = 0n;
  if (balance > 0n) {
    try {
      balanceValue = await vault.convertToAssets(balance);
    } catch (e) {
      // If conversion fails, calculate manually using rate
      if (currentRate && currentRate > 0n) {
        balanceValue = (balance * currentRate) / ethers.parseUnits("1", 18);
      }
    }
  }

  // Format values for display
  const formatAmount = (amount: bigint, dec: number) => {
    return ethers.formatUnits(amount, dec);
  };

  console.log("=".repeat(70));
  console.log("📊 RECEIPT TOKEN INFO");
  console.log("=".repeat(70));
  console.log("\nToken Details:");
  console.log("  Name:", name);
  console.log("  Symbol:", symbol);
  console.log("  Decimals:", decimals.toString());

  console.log("\nSupply & Assets:");
  console.log("  Total Supply:", formatAmount(totalSupply, Number(decimals)), symbol);
  console.log("  Total Assets:", formatAmount(totalAssets, Number(decimals)), "(underlying)");
  console.log("  Current Rate:", formatAmount(currentRate, 18), "(assets per share)");

  console.log("\nBalance Info:");
  console.log("  Address:", checkAddress);
  console.log("  Balance:", formatAmount(balance, Number(decimals)), symbol);
  console.log("  Value:", formatAmount(balanceValue, Number(decimals)), "(in underlying assets)");

  // Calculate percentage of total supply
  if (totalSupply > 0n) {
    const percentage = (balance * 10000n) / totalSupply;
    const percentageDisplay = Number(percentage) / 100;
    console.log("  % of Total Supply:", percentageDisplay.toFixed(2) + "%");
  }

  // Check bridge adapter if set
  try {
    const bridgeAdapter = await vault.bridgeAdapter();
    if (bridgeAdapter !== ethers.ZeroAddress) {
      console.log("\nBridge Info:");
      console.log("  Bridge Adapter:", bridgeAdapter);
    }
  } catch (e) {
    // Vault version might not support bridgeAdapter
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ Receipt Token Check Complete");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
