import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deposit tokens into an EmberVault
 *
 * Usage:
 *   VAULT=<VAULT_NAME> TOKEN=<TOKEN_NAME> AMOUNT=<AMOUNT> yarn interact:deposit-to-vault --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT   - Vault name/key from deployment JSON (required)
 *   TOKEN   - Token name to deposit (e.g., "USDC") (required)
 *   AMOUNT  - Amount to deposit in human-readable format (e.g., 1, 100, 0.5) (required)
 *
 * Examples:
 *   VAULT=emberUsdcVault TOKEN=USDC AMOUNT=100 yarn interact:deposit-to-vault --network sepolia
 *   VAULT=emberUsdcVault TOKEN=USDC AMOUNT=0.5 yarn interact:deposit-to-vault --network sepolia
 */

async function main() {
  console.log("\n💰 Depositing Tokens to EmberVault...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Depositing with account:", signer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  // Read environment variables
  const vaultName = process.env.VAULT;

  // Convert vault name to lowerCamelCase key
  // If already in camelCase format, use as-is; otherwise convert from space-separated format
  let vaultKey: string | undefined;
  if (vaultName) {
    // Check if it's already in camelCase format (no spaces)
    if (!/\s/.test(vaultName)) {
      vaultKey = vaultName;
    } else {
      // Convert from space-separated format to lowerCamelCase
      vaultKey = vaultName
        .split(/\s+/)
        .map((word, index) => {
          const cleanWord = word.toLowerCase();
          return index === 0 ? cleanWord : cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1);
        })
        .join("");
    }
  }

  const tokenName = process.env.TOKEN;
  const amountInput = process.env.AMOUNT;

  // Validate required parameters
  if (!vaultKey || !tokenName || !amountInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  VAULT=<VAULT_NAME> TOKEN=<TOKEN_NAME> AMOUNT=<AMOUNT> yarn interact:deposit-to-vault --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  VAULT   - Vault name/key from deployment JSON (required)");
    console.log("  TOKEN   - Token name to deposit (e.g., 'USDC') (required)");
    console.log("  AMOUNT  - Amount in human-readable format (e.g., 1, 100, 0.5) (required)\n");
    console.log("Examples:");
    console.log(
      "  VAULT=emberUsdcVault TOKEN=USDC AMOUNT=100 yarn interact:deposit-to-vault --network sepolia"
    );
    console.log(
      "  VAULT=emberUsdcVault TOKEN=USDC AMOUNT=0.5 yarn interact:deposit-to-vault --network sepolia"
    );
    process.exit(1);
  }

  // Load deployment file
  const deploymentFileName = `deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error(`❌ Error: Deployment file not found: ${deploymentFileName}`);
    console.log("\nPlease deploy contracts first.");
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Check if vault exists
  if (
    !deploymentInfo.contracts ||
    !deploymentInfo.contracts.vaults ||
    !deploymentInfo.contracts.vaults[vaultKey]
  ) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!\n`);
    console.log("Available vaults:");
    if (deploymentInfo.contracts && deploymentInfo.contracts.vaults) {
      Object.keys(deploymentInfo.contracts.vaults).forEach((key) => {
        const vault = deploymentInfo.contracts.vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
      });
    } else {
      console.log("  (none)");
    }
    process.exit(1);
  }

  const vaultInfo = deploymentInfo.contracts.vaults[vaultKey];
  const vaultAddress = vaultInfo.proxyAddress;

  if (!vaultAddress) {
    console.error(`❌ Error: Vault proxy address not found for '${vaultKey}'!`);
    process.exit(1);
  }

  // Check if deposit token exists
  if (
    !deploymentInfo.contracts.depositTokens ||
    !deploymentInfo.contracts.depositTokens[tokenName]
  ) {
    console.error(`❌ Error: Token '${tokenName}' not found in deployment file!\n`);
    console.log("Available deposit tokens:");
    if (deploymentInfo.contracts.depositTokens) {
      Object.keys(deploymentInfo.contracts.depositTokens).forEach((key) => {
        const token = deploymentInfo.contracts.depositTokens[key];
        console.log(`  - ${key}: ${token.symbol} (${token.name})`);
      });
    } else {
      console.log("  (none)");
    }
    process.exit(1);
  }

  const tokenInfo = deploymentInfo.contracts.depositTokens[tokenName];
  const tokenAddress = tokenInfo.proxyAddress;
  const tokenDecimals = tokenInfo.decimals;

  if (!tokenAddress) {
    console.error(`❌ Error: Token proxy address not found for '${tokenName}'!`);
    process.exit(1);
  }

  console.log("Vault Information:");
  console.log("  Name:", vaultInfo.name);
  console.log("  Address:", vaultAddress);

  console.log("\nDeposit Token Information:");
  console.log("  Name:", tokenInfo.name);
  console.log("  Symbol:", tokenInfo.symbol);
  console.log("  Decimals:", tokenDecimals);
  console.log("  Address:", tokenAddress);

  // Convert human-readable amount to base units using token decimals
  let amountInBaseUnits: bigint;
  try {
    amountInBaseUnits = ethers.parseUnits(amountInput, tokenDecimals);
  } catch (error) {
    console.error("\n❌ Error: Invalid amount format!");
    console.log("Please provide a valid number (e.g., 1, 100, 0.5)");
    process.exit(1);
  }

  // Validate amount
  if (amountInBaseUnits <= 0n) {
    console.error("❌ Error: Amount must be greater than 0");
    process.exit(1);
  }

  console.log("\nDeposit Parameters:");
  console.log("  Depositor:", signer.address);
  console.log("  Amount (human-readable):", amountInput, tokenInfo.symbol);
  console.log("  Amount (base units):", amountInBaseUnits.toString());

  // Get contract instances
  const token = await ethers.getContractAt("ERC20Token", tokenAddress);
  const vault = await ethers.getContractAt("EmberVault", vaultAddress);

  // Verify token matches vault's asset
  const vaultAsset = await vault.asset();
  if (vaultAsset.toLowerCase() !== tokenAddress.toLowerCase()) {
    console.error("\n❌ Error: Token mismatch!");
    console.log("Vault asset:", vaultAsset);
    console.log("Deposit token:", tokenAddress);
    console.log("\nThis vault does not accept", tokenInfo.symbol, "as deposits.");
    process.exit(1);
  }

  // Check depositor's token balance
  const balance = await token.balanceOf(signer.address);
  console.log("\nDepositor balance:", ethers.formatUnits(balance, tokenDecimals), tokenInfo.symbol);

  if (balance < amountInBaseUnits) {
    console.error("\n❌ Error: Insufficient token balance!");
    console.log(
      "Required:",
      ethers.formatUnits(amountInBaseUnits, tokenDecimals),
      tokenInfo.symbol
    );
    console.log("Available:", ethers.formatUnits(balance, tokenDecimals), tokenInfo.symbol);
    process.exit(1);
  }

  // Check and set allowance
  const currentAllowance = await token.allowance(signer.address, vaultAddress);
  console.log(
    "Current allowance:",
    ethers.formatUnits(currentAllowance, tokenDecimals),
    tokenInfo.symbol
  );

  if (currentAllowance < amountInBaseUnits) {
    console.log("\n⏳ Approving vault to spend tokens...");
    const approveTx = await token.approve(vaultAddress, amountInBaseUnits);
    console.log("Approval transaction hash:", approveTx.hash);
    console.log("Waiting for approval confirmation...");
    const approveReceipt = await approveTx.wait();
    console.log("✅ Approval confirmed in block:", approveReceipt?.blockNumber);
  } else {
    console.log("✅ Sufficient allowance already set");
  }

  // Get shares before deposit
  // The vault itself is an ERC4626 vault, which is also an ERC20 token representing shares
  const sharesBefore = await vault.balanceOf(signer.address);
  const sharesDecimals = await vault.decimals();
  const sharesSymbol = await vault.symbol();

  console.log(
    "\nShares before deposit:",
    ethers.formatUnits(sharesBefore, sharesDecimals),
    sharesSymbol
  );

  // Perform deposit
  console.log("\n⏳ Depositing tokens to vault...");
  const depositTx = await vault.deposit(amountInBaseUnits, signer.address);
  console.log("Deposit transaction hash:", depositTx.hash);
  console.log("Waiting for deposit confirmation...");
  const depositReceipt = await depositTx.wait();
  console.log("✅ Deposit confirmed in block:", depositReceipt?.blockNumber);

  // Get shares after deposit
  const sharesAfter = await vault.balanceOf(signer.address);
  const sharesReceived = sharesAfter - sharesBefore;

  console.log(
    "\nShares after deposit:",
    ethers.formatUnits(sharesAfter, sharesDecimals),
    sharesSymbol
  );
  console.log("Shares received:", ethers.formatUnits(sharesReceived, sharesDecimals), sharesSymbol);

  // Get updated token balance
  const balanceAfter = await token.balanceOf(signer.address);
  console.log(
    "\nToken balance after:",
    ethers.formatUnits(balanceAfter, tokenDecimals),
    tokenInfo.symbol
  );

  // Get vault TVL
  const tvl = await vault.totalAssets();
  console.log("\nVault TVL:", ethers.formatUnits(tvl, tokenDecimals), tokenInfo.symbol);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Deposit successful!");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
