/**
 * Generic contract verification tool.
 *
 * Loads `deployments/<network>-deployment.json` based on the active hardhat network
 * and lets you verify any contract listed in that file — vaults, ETH vaults, the
 * protocol config, the validator, OFT adapters, deposit tokens, anything.
 *
 * For UUPS contracts (those exposing both `proxyAddress` and `implementationAddress`),
 * both the implementation and the ERC1967 proxy are verified. For non-upgradeable
 * contracts (those exposing only `address`), the script verifies the single address
 * and prompts for constructor arguments if any are needed.
 *
 * Usage:
 *   ETHERSCAN_API_KEY=<key> yarn hardhat run scripts/verify-contracts.ts --network <network>
 */

import { run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import readline from "readline";

type ContractRecord = {
  proxyAddress?: string;
  implementationAddress?: string;
  address?: string;
  name?: string;
  [key: string]: unknown;
};

type FlatEntry = {
  groupPath: string;
  displayName: string;
  record: ContractRecord;
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

function isContractRecord(node: any): node is ContractRecord {
  return (
    node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    (typeof node.proxyAddress === "string" || typeof node.address === "string")
  );
}

/** Walk `deployment.contracts` and flatten anything that looks like a contract record. */
function flatten(node: any, prefix: string, out: FlatEntry[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (isContractRecord(node)) {
    const fallbackName = prefix.split(".").pop() || prefix || "<unnamed>";
    out.push({
      groupPath: prefix || fallbackName,
      displayName: typeof node.name === "string" && node.name.length > 0 ? node.name : fallbackName,
      record: node,
    });
    return;
  }

  for (const [k, v] of Object.entries(node)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

async function verifyOne(
  address: string,
  label: string,
  constructorArguments: unknown[] = []
): Promise<void> {
  console.log(`\n🔍 Verifying ${label} at ${address}...`);
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log(`✅ ${label} verified`);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (message.includes("Already Verified")) {
      console.log(`✓ ${label} already verified`);
      return;
    }
    console.error(`❌ ${label}: ${message}`);
    throw err;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const networkName = network.name;
  const deploymentPath = path.join(
    __dirname,
    "..",
    "deployments",
    `${networkName}-deployment.json`
  );

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment file not found: ${deploymentPath}`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Contract Verification Tool");
  console.log(`  Network: ${networkName}    Chain ID: ${deployment.chainId ?? "?"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const entries: FlatEntry[] = [];
  flatten(deployment.contracts ?? {}, "", entries);

  if (entries.length === 0) {
    throw new Error("No contracts found in deployment file");
  }

  console.log("Available contracts:");
  entries.forEach((entry, i) => {
    const addr = entry.record.proxyAddress ?? entry.record.address ?? "?";
    const kind = entry.record.proxyAddress ? "proxy" : "single";
    console.log(`  [${i + 1}] ${entry.groupPath}  (${kind})  ${entry.displayName}  ${addr}`);
  });

  const choice = (
    await question("\nEnter contract number or path (e.g. 3, vaults.emberUdl): ")
  ).trim();

  let selected: FlatEntry | undefined;
  const idx = Number.parseInt(choice, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= entries.length) {
    selected = entries[idx - 1];
  } else {
    selected = entries.find((e) => e.groupPath === choice);
  }

  if (!selected) {
    rl.close();
    throw new Error(`Selection not found: "${choice}"`);
  }

  const { record, displayName, groupPath } = selected;

  console.log("\n──────────────────────────────────────────────────");
  console.log(`  ${displayName}    (${groupPath})`);
  console.log("──────────────────────────────────────────────────");

  if (record.proxyAddress && record.implementationAddress) {
    rl.close();
    await verifyOne(record.implementationAddress, `${displayName} Implementation`);
    await delay(2000);
    // ERC1967Proxy(address newImplementation, bytes _data)
    // Empty _data is correct here only if the proxy was deployed with no init payload
    // forwarded through the constructor. The OZ upgrades plugin typically calls initialize()
    // through the proxy ctor — if Etherscan rejects this, re-run and pass the encoded init
    // calldata as the second argument.
    await verifyOne(record.proxyAddress, `${displayName} Proxy`, [
      record.implementationAddress,
      "0x",
    ]);
  } else if (record.address) {
    const argsHint = collectLikelyConstructorArgs(record);
    if (argsHint) {
      console.log(`\nDetected likely constructor arguments: ${JSON.stringify(argsHint.values)}`);
      console.log(`(based on fields: ${argsHint.fieldNames.join(", ")})`);
    }
    const argsInput = (
      await question("\nConstructor arguments as JSON array (press Enter to use detected/empty): ")
    ).trim();
    rl.close();

    let constructorArgs: unknown[] = [];
    if (argsInput.length > 0) {
      try {
        constructorArgs = JSON.parse(argsInput);
      } catch (e) {
        throw new Error(`Could not parse constructor arguments as JSON array: ${argsInput}`);
      }
    } else if (argsHint) {
      constructorArgs = argsHint.values;
    }

    await verifyOne(record.address, displayName, constructorArgs);
  } else {
    rl.close();
    throw new Error(`Contract record at ${groupPath} has neither proxyAddress nor address fields`);
  }

  console.log("\n✅ Verification complete\n");
}

/**
 * Best-effort detection of constructor arguments for non-upgradeable contracts.
 * Currently knows about the OFT adapter shape; extend as new non-upgradeable
 * contract types are added to the deployment file.
 */
function collectLikelyConstructorArgs(
  record: ContractRecord
): { fieldNames: string[]; values: unknown[] } | undefined {
  // EmberVaultMintBurnOFTAdapter(_token, _lzEndpoint, _delegate)
  if (
    typeof record.vaultAddress === "string" &&
    typeof record.lzEndpointAddress === "string" &&
    typeof record.delegate === "string"
  ) {
    return {
      fieldNames: ["vaultAddress", "lzEndpointAddress", "delegate"],
      values: [record.vaultAddress, record.lzEndpointAddress, record.delegate],
    };
  }
  return undefined;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
