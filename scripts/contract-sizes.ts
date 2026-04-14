import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts");
const MAX_CONTRACT_SIZE = 24576; // 24KB limit in bytes

interface ContractInfo {
  name: string;
  path: string;
  sizeBytes: number;
  sizeKB: number;
  percentOfLimit: number;
}

function findArtifacts(dir: string, contracts: ContractInfo[] = []): ContractInfo[] {
  if (!fs.existsSync(dir)) {
    return contracts;
  }

  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      findArtifacts(fullPath, contracts);
    } else if (item.endsWith(".json") && !item.endsWith(".dbg.json")) {
      try {
        const artifact = JSON.parse(fs.readFileSync(fullPath, "utf8"));

        // Skip interfaces (no bytecode)
        if (!artifact.bytecode || artifact.bytecode === "0x") {
          continue;
        }

        // Remove 0x prefix and calculate size (2 hex chars = 1 byte)
        const bytecode = artifact.bytecode.startsWith("0x")
          ? artifact.bytecode.slice(2)
          : artifact.bytecode;
        const sizeBytes = bytecode.length / 2;
        const sizeKB = sizeBytes / 1024;
        const percentOfLimit = (sizeBytes / MAX_CONTRACT_SIZE) * 100;

        contracts.push({
          name: artifact.contractName,
          path: fullPath.replace(ARTIFACTS_DIR, "").replace(/\\/g, "/"),
          sizeBytes,
          sizeKB,
          percentOfLimit,
        });
      } catch {
        // Skip invalid JSON files
      }
    }
  }

  return contracts;
}

function getStatusIcon(percent: number): string {
  if (percent >= 100) return "❌";
  if (percent >= 80) return "⚠️";
  if (percent >= 60) return "🟡";
  return "✅";
}

function getColorCode(percent: number): string {
  if (percent >= 100) return "\x1b[31m"; // Red
  if (percent >= 80) return "\x1b[33m"; // Yellow
  return "\x1b[32m"; // Green
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

async function main(): Promise<void> {
  console.log(`\n${BOLD}📦 Contract Size Report${RESET}\n`);

  // Clean and compile contracts
  console.log(`${DIM}Cleaning artifacts...${RESET}`);
  await run("clean");

  console.log(`${DIM}Compiling contracts...${RESET}\n`);
  await run("compile");

  console.log(`\n${DIM}Max contract size: ${MAX_CONTRACT_SIZE} bytes (24 KB)${RESET}\n`);

  const contracts = findArtifacts(ARTIFACTS_DIR);

  if (contracts.length === 0) {
    console.log("No compiled contracts found.\n");
    return;
  }

  // Sort by size descending
  contracts.sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Calculate column widths
  const maxNameLen = Math.max(...contracts.map((c) => c.name.length), 8);

  // Header
  console.log(
    `${"Contract".padEnd(maxNameLen)}  ${"Size (KB)".padStart(10)}  ${"Size (B)".padStart(10)}  ${"% of Limit".padStart(10)}  Status`
  );
  console.log("─".repeat(maxNameLen + 50));

  // Rows
  for (const contract of contracts) {
    const color = getColorCode(contract.percentOfLimit);
    const icon = getStatusIcon(contract.percentOfLimit);

    console.log(
      `${contract.name.padEnd(maxNameLen)}  ` +
        `${color}${contract.sizeKB.toFixed(2).padStart(10)}${RESET}  ` +
        `${contract.sizeBytes.toString().padStart(10)}  ` +
        `${color}${contract.percentOfLimit.toFixed(1).padStart(9)}%${RESET}  ` +
        `${icon}`
    );
  }

  console.log("─".repeat(maxNameLen + 50));

  // Summary
  const overLimit = contracts.filter((c) => c.percentOfLimit >= 100);
  const nearLimit = contracts.filter((c) => c.percentOfLimit >= 80 && c.percentOfLimit < 100);

  console.log(`\n${BOLD}Summary:${RESET}`);
  console.log(`  Total contracts: ${contracts.length}`);

  if (overLimit.length > 0) {
    console.log(`  ${"\x1b[31m"}❌ Over limit: ${overLimit.length}${RESET}`);
  }
  if (nearLimit.length > 0) {
    console.log(`  ${"\x1b[33m"}⚠️  Near limit (>80%): ${nearLimit.length}${RESET}`);
  }
  if (overLimit.length === 0 && nearLimit.length === 0) {
    console.log(`  ${"\x1b[32m"}✅ All contracts within safe limits${RESET}`);
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
