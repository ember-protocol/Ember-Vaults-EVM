import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Deposit tokens into an EmberVault using EIP-2612 permit
 *
 * Usage:
 *   VAULT=<VAULT_NAME> AMOUNT=<AMOUNT> yarn interact:deposit-with-permit --network <NETWORK>
 *
 * Environment Variables:
 *   VAULT   - Vault name/key from deployment JSON (required)
 *   AMOUNT  - Amount to deposit in human-readable format (e.g., 1, 100, 0.5) (required)
 *
 * Examples:
 *   VAULT=emberExusdcVault AMOUNT=100 yarn interact:deposit-with-permit --network sepolia
 *   VAULT=emberErcusdcVault AMOUNT=0.5 yarn interact:deposit-with-permit --network sepolia
 */

async function main() {
  console.log("\n🔐 Depositing Tokens to EmberVault with Permit...\n");

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
  let vaultKey: string | undefined;
  if (vaultName) {
    if (!/\s/.test(vaultName)) {
      vaultKey = vaultName;
    } else {
      vaultKey = vaultName
        .split(/\s+/)
        .map((word, index) => {
          const cleanWord = word.toLowerCase();
          return index === 0 ? cleanWord : cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1);
        })
        .join("");
    }
  }

  const amountInput = process.env.AMOUNT;

  // Validate required parameters
  if (!vaultKey || !amountInput) {
    console.error("❌ Error: Missing required environment variables!\n");
    console.log("Usage:");
    console.log(
      "  VAULT=<VAULT_NAME> AMOUNT=<AMOUNT> yarn interact:deposit-with-permit --network <NETWORK>\n"
    );
    console.log("Environment Variables:");
    console.log("  VAULT   - Vault name/key from deployment JSON (required)");
    console.log("  AMOUNT  - Amount in human-readable format (e.g., 1, 100, 0.5) (required)\n");
    console.log("Examples:");
    console.log(
      "  VAULT=emberExusdcVault AMOUNT=100 yarn interact:deposit-with-permit --network sepolia"
    );
    console.log(
      "  VAULT=emberErcusdcVault AMOUNT=0.5 yarn interact:deposit-with-permit --network sepolia"
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
  const collateralTokenAddress = vaultInfo.collateralToken;

  if (!vaultAddress) {
    console.error(`❌ Error: Vault proxy address not found for '${vaultKey}'!`);
    process.exit(1);
  }

  if (!collateralTokenAddress) {
    console.error(`❌ Error: Collateral token address not found for vault '${vaultKey}'!`);
    process.exit(1);
  }

  console.log("Vault Information:");
  console.log("  Name:", vaultInfo.name);
  console.log("  Address:", vaultAddress);
  console.log("  Symbol:", vaultInfo.receiptTokenSymbol);

  // Get contract instances
  const vault = await ethers.getContractAt("EmberVault", vaultAddress);
  const collateralToken = await ethers.getContractAt("ERC20Token", collateralTokenAddress);

  // Get token info
  const tokenName = await collateralToken.name();
  const tokenSymbol = await collateralToken.symbol();
  const tokenDecimals = await collateralToken.decimals();

  console.log("\nCollateral Token Information:");
  console.log("  Name:", tokenName);
  console.log("  Symbol:", tokenSymbol);
  console.log("  Decimals:", tokenDecimals);
  console.log("  Address:", collateralTokenAddress);
  // Verify token supports permit
  let supportsPermit = false;
  try {
    // Try to call DOMAIN_SEPARATOR to check if EIP-2612 is supported
    await collateralToken.DOMAIN_SEPARATOR();
    supportsPermit = true;
    console.log("  EIP-2612 Permit: ✅ Supported");
  } catch (error) {
    console.log("  EIP-2612 Permit: ❌ Not Supported");
    console.error("\n❌ Error: Collateral token does not support EIP-2612 permit!");
    console.log("You must use the regular deposit() method with a separate approve() transaction.");
    process.exit(1);
  }

  // Convert human-readable amount to base units
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
  console.log("  Receiver:", signer.address);
  console.log("  Amount (human-readable):", amountInput, tokenSymbol);
  console.log("  Amount (base units):", amountInBaseUnits.toString());

  // Check depositor's token balance
  const balance = await collateralToken.balanceOf(signer.address);
  console.log("\nDepositor balance:", ethers.formatUnits(balance, tokenDecimals), tokenSymbol);

  if (balance < amountInBaseUnits) {
    console.error("\n❌ Error: Insufficient token balance!");
    console.log("Required:", ethers.formatUnits(amountInBaseUnits, tokenDecimals), tokenSymbol);
    console.log("Available:", ethers.formatUnits(balance, tokenDecimals), tokenSymbol);
    process.exit(1);
  }

  // Get shares before deposit
  const sharesBefore = await vault.balanceOf(signer.address);
  const sharesDecimals = await vault.decimals();
  const sharesSymbol = await vault.symbol();

  console.log(
    "\nShares before deposit:",
    ethers.formatUnits(sharesBefore, sharesDecimals),
    sharesSymbol
  );

  // Create permit signature
  console.log("\n🔐 Creating EIP-2612 permit signature...");

  const deadline = ethers.MaxUint256; // No expiry
  const nonce = await collateralToken.nonces(signer.address);

  console.log("  Nonce:", nonce.toString());
  console.log("  Deadline:", "No expiry (MaxUint256)");

  // EIP-2612 Permit types
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // Permit message
  const value = {
    owner: signer.address,
    spender: vaultAddress,
    value: amountInBaseUnits,
    nonce: nonce,
    deadline: deadline,
  };

  // Determine the correct version for EIP-712 domain
  // Different tokens use different versions (e.g., most use "1", USDC uses "2")
  console.log("  Determining correct EIP-712 domain version...");

  let signature: string | undefined;
  let sig: ReturnType<typeof ethers.Signature.from> | undefined;
  let domainVersion: string | undefined;
  let domainName: string = tokenName;

  // First, try to query the token directly for its EIP-712 domain (EIP-5267)
  try {
    console.log("  Querying token for EIP-712 domain (EIP-5267)...");
    const eip712Domain = await collateralToken.eip712Domain();

    domainVersion = eip712Domain.version;
    domainName = eip712Domain.name;

    console.log(`  ✅ Token reports EIP-712 domain:`);
    console.log(`     Name: "${domainName}"`);
    console.log(`     Version: "${domainVersion}"`);
    console.log(`     Chain ID: ${eip712Domain.chainId.toString()}`);
  } catch (error: any) {
    console.log("  ℹ️  EIP-5267 not supported, using fallback detection...");

    // Fallback: Try common versions by validating signatures
    for (const testVersion of ["1", "2"]) {
      const domain = {
        name: tokenName,
        version: testVersion,
        chainId: network.chainId,
        verifyingContract: collateralTokenAddress,
      };

      try {
        // Sign with this version
        const testSignature = await signer.signTypedData(domain, types, value);
        const testSig = ethers.Signature.from(testSignature);

        // Try to validate by estimating gas for permit call
        // This will fail if the signature is invalid
        await collateralToken.permit.estimateGas(
          signer.address,
          vaultAddress,
          amountInBaseUnits,
          deadline,
          testSig.v,
          testSig.r,
          testSig.s
        );

        // If we get here, the signature is valid!
        domainVersion = testVersion;
        console.log(`  ✅ Detected version "${testVersion}" (signature validation passed)`);
        break;
      } catch (error: any) {
        // This version didn't work, try the next one
        if (error.message.includes("invalid signature")) {
          console.log(`  ℹ️  Version "${testVersion}" - invalid signature, trying next...`);
        } else {
          // Some other error (might be valid signature but other issue)
          // Use this version
          domainVersion = testVersion;
          console.log(
            `  ✅ Using version "${testVersion}" (gas estimation had non-signature error)`
          );
          break;
        }
      }
    }
  }

  // Now create the final signature with the determined domain
  if (!domainVersion) {
    console.error("\n❌ Error: Could not determine correct EIP-712 domain version!");
    console.log("The token may use a non-standard EIP-2612 implementation.");
    process.exit(1);
  }

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId: network.chainId,
    verifyingContract: collateralTokenAddress,
  };

  console.log("\n  Creating permit signature with detected domain...");
  signature = await signer.signTypedData(domain, types, value);
  sig = ethers.Signature.from(signature);

  console.log("\n  Signature details:");
  console.log("    v:", sig!.v);
  console.log("    r:", sig!.r);
  console.log("    s:", sig!.s);

  // Perform deposit with permit
  console.log("\n⏳ Depositing tokens to vault with permit (single transaction)...");
  console.log("  This combines permit + deposit into one transaction!");

  try {
    const depositTx = await vault.depositWithPermit(
      amountInBaseUnits,
      signer.address,
      deadline,
      sig!.v,
      sig!.r,
      sig!.s
    );
    console.log("  Transaction hash:", depositTx.hash);
    console.log("  Waiting for confirmation...");
    const depositReceipt = await depositTx.wait();
    console.log("  ✅ Deposit confirmed in block:", depositReceipt?.blockNumber);
    console.log("  Gas used:", depositReceipt?.gasUsed.toString());
  } catch (error: any) {
    console.error("\n❌ Deposit failed!");
    console.error("Error:", error.message);

    // Try to extract revert reason
    if (error.reason) {
      console.error("Revert reason:", error.reason);
    }
    if (error.data) {
      console.error("Error data:", error.data);
    }

    // Log full error for debugging
    console.error("\nFull error details:");
    console.error(JSON.stringify(error, null, 2));

    if (error.message.includes("Paused")) {
      console.log("\nThe vault or protocol may be paused. Check with the admin.");
    } else if (error.message.includes("Blacklisted")) {
      console.log("\nYour address or receiver may be blacklisted.");
    } else if (error.message.includes("MaxTVLReached")) {
      console.log("\nThe vault has reached its maximum TVL limit.");
    }
    process.exit(1);
  }

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
  const balanceAfter = await collateralToken.balanceOf(signer.address);
  console.log(
    "\nToken balance after:",
    ethers.formatUnits(balanceAfter, tokenDecimals),
    tokenSymbol
  );

  // Get vault TVL
  const tvl = await vault.totalAssets();
  console.log("\nVault TVL:", ethers.formatUnits(tvl, tokenDecimals), tokenSymbol);

  // Get vault version
  const vaultVersion = await vault.version();
  console.log("Vault Version:", vaultVersion);

  console.log("\n" + "=".repeat(70));
  console.log("🎉 Deposit with Permit successful!");
  console.log("=".repeat(70));
  console.log("\n💡 Benefits of depositWithPermit:");
  console.log("  • Single transaction (vs approve + deposit)");
  console.log("  • Gas savings (no separate approve tx)");
  console.log("  • Better UX (one-click deposits)");
  console.log("  • Gasless approvals (signature off-chain)");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
