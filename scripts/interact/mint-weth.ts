import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Wrap ETH to WETH using MockWETH deposit()
 * This creates WETH tokens backed by real ETH (required for withdrawals to work)
 *
 * Usage:
 *   AMOUNT=<AMOUNT> yarn interact:mint-weth --network <NETWORK>
 *
 * Environment Variables:
 *   AMOUNT      - Amount of ETH to wrap to WETH (e.g., 0.1, 1, 10) (required)
 *   RECIPIENT   - Address to receive WETH (optional, defaults to signer)
 *
 * Examples:
 *   AMOUNT=1 yarn interact:mint-weth --network sepolia
 *   AMOUNT=10 RECIPIENT=0x123... yarn interact:mint-weth --network sepolia
 */

async function main() {
  console.log("\n🪙 Wrapping ETH to WETH (MockWETH)...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const ethBalance = await ethers.provider.getBalance(signer.address);

  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Wrapping with account:", signer.address);
  console.log("Account ETH balance:", ethers.formatEther(ethBalance), "ETH\n");

  // Read environment variables
  const recipient = process.env.RECIPIENT || signer.address;
  const amountInput = process.env.AMOUNT;

  if (!amountInput) {
    console.error("❌ Error: Missing AMOUNT environment variable!\n");
    console.log("Usage:");
    console.log("  AMOUNT=<AMOUNT> yarn interact:mint-weth --network <NETWORK>\n");
    console.log("Environment Variables:");
    console.log("  AMOUNT      - Amount of ETH to wrap (e.g., 0.1, 1, 10) (required)");
    console.log("  RECIPIENT   - Recipient address (optional, defaults to signer)\n");
    console.log("Examples:");
    console.log("  AMOUNT=1 yarn interact:mint-weth --network sepolia");
    console.log("  AMOUNT=10 RECIPIENT=0x123... yarn interact:mint-weth --network sepolia");
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
    console.log("\nPlease deploy MockWETH first using:");
    console.log("  yarn deploy:mock-weth --network", network.name);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  // Check if MockWETH exists
  if (!deploymentInfo.contracts?.depositTokens?.WETH) {
    console.error("❌ Error: MockWETH not found in deployment file!\n");
    console.log("Please deploy MockWETH first using:");
    console.log("  yarn deploy:mock-weth --network", network.name);
    process.exit(1);
  }

  const wethInfo = deploymentInfo.contracts.depositTokens.WETH;
  const wethAddress = wethInfo.address;

  console.log("MockWETH Information:");
  console.log("  Name:", wethInfo.name);
  console.log("  Symbol:", wethInfo.symbol);
  console.log("  Address:", wethAddress);

  // Parse amount (18 decimals)
  let amountInWei: bigint;
  try {
    amountInWei = ethers.parseEther(amountInput);
  } catch {
    console.error("\n❌ Error: Invalid amount format!");
    process.exit(1);
  }

  if (amountInWei <= 0n) {
    console.error("❌ Error: Amount must be greater than 0");
    process.exit(1);
  }

  // Check ETH balance
  const estimatedGas = ethers.parseEther("0.01");
  if (ethBalance < amountInWei + estimatedGas) {
    console.error("\n❌ Error: Insufficient ETH balance!");
    console.log("Required:", amountInput, "ETH + gas");
    console.log("Available:", ethers.formatEther(ethBalance), "ETH");
    process.exit(1);
  }

  console.log("\nWrap Parameters:");
  console.log("  Amount:", amountInput, "ETH → WETH");
  console.log("  Recipient:", recipient);

  // Get MockWETH contract
  const weth = await ethers.getContractAt("MockWETH", wethAddress);

  // Get balances before
  const wethBalanceBefore = await weth.balanceOf(recipient);
  console.log("\nRecipient WETH balance before:", ethers.formatEther(wethBalanceBefore), "WETH");

  // Deposit ETH to get WETH (backed by real ETH)
  console.log("\n⏳ Wrapping ETH to WETH...");
  const tx = await weth.deposit({ value: amountInWei });
  console.log("Transaction hash:", tx.hash);
  await tx.wait();
  console.log("✅ ETH wrapped to WETH");

  // If recipient is different from signer, transfer WETH
  if (recipient.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("\n⏳ Transferring WETH to recipient...");
    const transferTx = await weth.transfer(recipient, amountInWei);
    console.log("Transfer tx:", transferTx.hash);
    await transferTx.wait();
    console.log("✅ WETH transferred to recipient");
  }

  // Get balances after
  const wethBalanceAfter = await weth.balanceOf(recipient);
  const ethBalanceAfter = await ethers.provider.getBalance(signer.address);
  const mockWethEthBalance = await ethers.provider.getBalance(wethAddress);

  console.log("\nRecipient WETH balance after:", ethers.formatEther(wethBalanceAfter), "WETH");
  console.log("Signer ETH balance after:", ethers.formatEther(ethBalanceAfter), "ETH");
  console.log("MockWETH contract ETH balance:", ethers.formatEther(mockWethEthBalance), "ETH");

  console.log("\n" + "=".repeat(60));
  console.log("🎉 ETH wrapped to WETH successfully!");
  console.log("   WETH is backed by real ETH (withdrawals will work)");
  console.log("=".repeat(60) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
