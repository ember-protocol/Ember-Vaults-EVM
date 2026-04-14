import { ethers } from "hardhat";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Verifies that EmberVault is compiled with permit methods
 *
 * This script:
 * 1. Performs a clean compile
 * 2. Checks the compiled bytecode for depositWithPermit and mintWithPermit
 * 3. Verifies the function selectors are present
 * 4. Reports the bytecode size
 *
 * Usage:
 *   yarn verify:permit
 */

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("🔍 EmberVault Permit Methods Verification");
  console.log("=".repeat(70) + "\n");

  // Step 1: Clean compile
  console.log("📦 Step 1: Performing clean compile...");
  console.log("   Running: yarn clean-compile\n");

  try {
    const { stdout, stderr } = await execAsync("yarn clean-compile");
    console.log("   ✅ Compilation completed successfully\n");

    // Show last few lines of output
    const lines = stdout.split("\n").filter((line) => line.trim());
    const lastLines = lines.slice(-3);
    if (lastLines.length > 0) {
      console.log("   Compilation output:");
      lastLines.forEach((line) => console.log("     ", line));
      console.log();
    }
  } catch (error: any) {
    console.error("   ❌ Compilation failed!");
    console.error(error.message);
    process.exit(1);
  }

  // Step 2: Load compiled artifact
  console.log("📋 Step 2: Loading compiled artifact...");
  const artifactPath = "artifacts/contracts/EmberVault.sol/EmberVault.json";

  if (!fs.existsSync(artifactPath)) {
    console.error("   ❌ Artifact not found at:", artifactPath);
    console.error("   Please ensure compilation completed successfully.");
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.deployedBytecode;
  const abi = artifact.abi;

  console.log("   ✅ Artifact loaded successfully\n");

  // Step 3: Calculate function selectors
  console.log("🔬 Step 3: Calculating function selectors...");

  const depositWithPermitSig = "depositWithPermit(uint256,address,uint256,uint8,bytes32,bytes32)";
  const mintWithPermitSig = "mintWithPermit(uint256,address,uint256,uint8,bytes32,bytes32)";

  const depositSelector = ethers.id(depositWithPermitSig).substring(0, 10);
  const mintSelector = ethers.id(mintWithPermitSig).substring(0, 10);

  console.log("   depositWithPermit:");
  console.log("     Signature:", depositWithPermitSig);
  console.log("     Selector: ", depositSelector);

  console.log("   mintWithPermit:");
  console.log("     Signature:", mintWithPermitSig);
  console.log("     Selector: ", mintSelector);
  console.log();

  // Step 4: Check bytecode for selectors
  console.log("🔍 Step 4: Checking bytecode for function selectors...");

  const hasDepositWithPermit = bytecode.includes(depositSelector.substring(2));
  const hasMintWithPermit = bytecode.includes(mintSelector.substring(2));

  console.log(
    "   depositWithPermit (" + depositSelector + "):",
    hasDepositWithPermit ? "✅ FOUND" : "❌ NOT FOUND"
  );
  console.log(
    "   mintWithPermit (" + mintSelector + "):",
    hasMintWithPermit ? "✅ FOUND" : "❌ NOT FOUND"
  );
  console.log();

  // Step 5: Check ABI
  console.log("📝 Step 5: Verifying ABI...");

  const depositWithPermitInABI = abi.find((item: any) => item.name === "depositWithPermit");
  const mintWithPermitInABI = abi.find((item: any) => item.name === "mintWithPermit");

  console.log("   depositWithPermit:", depositWithPermitInABI ? "✅ FOUND" : "❌ NOT FOUND");
  console.log("   mintWithPermit:", mintWithPermitInABI ? "✅ FOUND" : "❌ NOT FOUND");
  console.log();

  // Step 6: Get version from source
  console.log("📄 Step 6: Checking source code...");
  const sourceCode = fs.readFileSync("contracts/EmberVault.sol", "utf8");
  const versionMatch = sourceCode.match(/function version\(\).*?return\s+"(.+?)"/s);
  const versionInSource = versionMatch ? versionMatch[1] : "NOT FOUND";

  const hasDepositWithPermitInSource = sourceCode.includes("function depositWithPermit");
  const hasMintWithPermitInSource = sourceCode.includes("function mintWithPermit");

  console.log("   Version:", versionInSource);
  console.log("   depositWithPermit:", hasDepositWithPermitInSource ? "✅ FOUND" : "❌ NOT FOUND");
  console.log("   mintWithPermit:", hasMintWithPermitInSource ? "✅ FOUND" : "❌ NOT FOUND");
  console.log();

  // Step 7: Report bytecode size
  console.log("📊 Step 7: Bytecode analysis...");
  const bytecodeSize = bytecode.length / 2 - 1;
  const bytecodeSizeKB = (bytecodeSize / 1024).toFixed(2);
  const maxSize = 24576; // 24 KB
  const percentUsed = ((bytecodeSize / maxSize) * 100).toFixed(1);

  console.log("   Bytecode size:", bytecodeSize, "bytes", `(${bytecodeSizeKB} KB)`);
  console.log("   Max size:     ", maxSize, "bytes (24 KB)");
  console.log("   Usage:        ", percentUsed + "%");

  if (bytecodeSize > maxSize) {
    console.log("   ⚠️  WARNING: Bytecode exceeds 24 KB limit!");
  } else {
    const remaining = maxSize - bytecodeSize;
    console.log("   Remaining:    ", remaining, "bytes");
  }
  console.log();

  // Final Summary
  console.log("=".repeat(70));
  console.log("📊 VERIFICATION SUMMARY");
  console.log("=".repeat(70) + "\n");

  const allChecks = [
    { name: "Compilation", passed: true },
    { name: "depositWithPermit in bytecode", passed: hasDepositWithPermit },
    { name: "mintWithPermit in bytecode", passed: hasMintWithPermit },
    { name: "depositWithPermit in ABI", passed: !!depositWithPermitInABI },
    { name: "mintWithPermit in ABI", passed: !!mintWithPermitInABI },
    { name: "depositWithPermit in source", passed: hasDepositWithPermitInSource },
    { name: "mintWithPermit in source", passed: hasMintWithPermitInSource },
    { name: "Bytecode within limits", passed: bytecodeSize <= maxSize },
  ];

  const passedChecks = allChecks.filter((c) => c.passed).length;
  const totalChecks = allChecks.length;

  console.log("Results: " + passedChecks + "/" + totalChecks + " checks passed\n");

  allChecks.forEach((check) => {
    const icon = check.passed ? "✅" : "❌";
    console.log(`  ${icon} ${check.name}`);
  });

  console.log();

  if (passedChecks === totalChecks) {
    console.log("=".repeat(70));
    console.log("✅ SUCCESS! Permit methods are properly compiled");
    console.log("=".repeat(70));
    console.log("\n✨ The compiled EmberVault includes:");
    console.log("  • depositWithPermit() - Selector:", depositSelector);
    console.log("  • mintWithPermit() - Selector:", mintSelector);
    console.log("  • Version:", versionInSource);
    console.log("  • Size:", bytecodeSize, "bytes (", percentUsed + "% of 24 KB limit)");
    console.log("\n💡 Ready to deploy/upgrade! Use:");
    console.log("  yarn upgrade:vaults --network <network>");
    console.log("=".repeat(70) + "\n");
    process.exit(0);
  } else {
    console.log("=".repeat(70));
    console.log("❌ FAILURE! Permit methods are missing or incomplete");
    console.log("=".repeat(70));
    console.log("\n⚠️  Issues detected:");

    if (!hasDepositWithPermit || !hasMintWithPermit) {
      console.log("  • Permit methods not found in bytecode");
      console.log("    - Check that depositWithPermit and mintWithPermit exist in EmberVault.sol");
    }

    if (!depositWithPermitInABI || !mintWithPermitInABI) {
      console.log("  • Permit methods not in ABI");
      console.log("    - Try: yarn clean-compile");
    }

    if (!hasDepositWithPermitInSource || !hasMintWithPermitInSource) {
      console.log("  • Permit methods not in source code");
      console.log("    - Add depositWithPermit and mintWithPermit to contracts/EmberVault.sol");
    }

    if (bytecodeSize > maxSize) {
      console.log("  • Bytecode exceeds 24 KB limit");
      console.log("    - Contract size optimization needed");
    }

    console.log("\n🔧 Recommended actions:");
    console.log("  1. Verify contracts/EmberVault.sol has depositWithPermit and mintWithPermit");
    console.log("  2. Run: yarn clean-compile");
    console.log("  3. Run this script again");
    console.log("=".repeat(70) + "\n");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Unexpected error:");
    console.error(error);
    process.exit(1);
  });
