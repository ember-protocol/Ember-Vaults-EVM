import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Mint ERC20 tokens (deposit tokens or receipt tokens)
 *
 * Usage:
 *   TOKEN=<TOKEN_NAME> RECIPIENT=<ADDRESS> AMOUNT=<AMOUNT> yarn mint:tokens --network <NETWORK>
 *
 * Environment Variables:
 *   TOKEN       - Token name/ID from deployment JSON (e.g., "USDC", "eUSDC")
 *   RECIPIENT   - Address to receive the minted tokens
 *   AMOUNT      - Amount to mint in base units (e.g., 1000000 for 1 USDC with 6 decimals)
 *
 * Examples:
 *   TOKEN=USDC RECIPIENT=0x123... AMOUNT=1000000 yarn mint:tokens --network sepolia
 *   TOKEN=eUSDC RECIPIENT=0x123... AMOUNT=1000000000000000000 yarn mint:tokens --network sepolia
 */

async function main() {
  console.log("\n🪙 Minting ERC20 Tokens...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Minting with account:", signer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  // Read environment variables
  const tokenName = process.env.TOKEN;
  const recipient = process.env.RECIPIENT;
  const amountInput = process.env.AMOUNT;

  // Validate required parameters
  if (!tokenName || !recipient || !amountInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  TOKEN=<TOKEN_NAME> RECIPIENT=<ADDRESS> AMOUNT=<AMOUNT> yarn mint:tokens --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  TOKEN       - Token name/ID from deployment JSON (required)");
    console.log("  RECIPIENT   - Recipient address (required)");
    console.log(
      "  AMOUNT      - Amount in human-readable format (e.g., 1 for 1 USDC, 100 for 100 USDC) (required)\n"
    );
    console.log("Examples:");
    console.log(
      "  TOKEN=USDC RECIPIENT=0x123... AMOUNT=1 yarn mint:tokens --network sepolia      # Mints 1 USDC"
    );
    console.log(
      "  TOKEN=USDC RECIPIENT=0x123... AMOUNT=1000 yarn mint:tokens --network sepolia   # Mints 1000 USDC"
    );
    console.log(
      "  TOKEN=eUSDC RECIPIENT=0x123... AMOUNT=1 yarn mint:tokens --network sepolia     # Mints 1 eUSDC"
    );
    process.exit(1);
  }

  // Validate recipient address
  if (!ethers.isAddress(recipient)) {
    console.error("❌ Error: Invalid recipient address:", recipient);
    process.exit(1);
  }

  // Load deployment file
  const deploymentFileName = `deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error(`❌ Error: Deployment file not found: ${deploymentFileName}`);
    console.log("\nPlease deploy tokens first using:");
    console.log("  yarn deploy:token --network", network.name);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Check if token exists
  if (
    !deploymentInfo.contracts ||
    !deploymentInfo.contracts.depositTokens ||
    !deploymentInfo.contracts.depositTokens[tokenName]
  ) {
    console.error(`❌ Error: Token '${tokenName}' not found in deployment file!\n`);
    if (deploymentInfo.contracts && deploymentInfo.contracts.depositTokens) {
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

  console.log("Token Information:");
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

  console.log("\nMint Parameters:");
  console.log("  Recipient:", recipient);
  console.log("  Amount (human-readable):", amountInput, tokenInfo.symbol);
  console.log("  Amount (base units):", amountInBaseUnits.toString());

  // Get the token contract
  const token = await ethers.getContractAt("ERC20Token", tokenAddress);

  // Check if signer is the owner
  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("\n❌ Error: Only the token owner can mint tokens!");
    console.log("Token owner:", owner);
    console.log("Your address:", signer.address);
    process.exit(1);
  }

  // Get recipient's balance before minting
  const balanceBefore = await token.balanceOf(recipient);
  console.log(
    "\nRecipient balance before:",
    ethers.formatUnits(balanceBefore, tokenInfo.decimals),
    tokenInfo.symbol
  );

  // Mint tokens
  console.log("\n⏳ Minting tokens...");
  const tx = await token.mint(recipient, amountInBaseUnits);
  console.log("Transaction hash:", tx.hash);

  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("✅ Transaction confirmed in block:", receipt?.blockNumber);

  // Get recipient's balance after minting
  const balanceAfter = await token.balanceOf(recipient);
  console.log(
    "\nRecipient balance after:",
    ethers.formatUnits(balanceAfter, tokenInfo.decimals),
    tokenInfo.symbol
  );

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Tokens minted successfully!");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
