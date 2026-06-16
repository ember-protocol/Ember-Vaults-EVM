import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates `transferOwnership(timelock)` tx-bytes for every upgradeable
 * contract in the deployment file, grouped by current on-chain owner.
 *
 * Output: ./deployments/<network>-timelock-transfers.json
 *   {
 *     "network": ...,
 *     "timelock": "0x...",
 *     "transfers": [
 *       { "name": "...", "to": "...", "value": "0", "data": "0x...",
 *         "currentOwner": "0x...", "expectedSender": "0x..." },
 *       ...
 *     ]
 *   }
 *
 * The output is a flat list of EOA-equivalent transactions. Each entry is
 * one ownership transfer the caller (Fordefi multisig at `currentOwner`)
 * must submit. Network is derived from hardhat's runtime.
 *
 * Optional ENV variables:
 *   - INCLUDE_MISMATCHED=true  Include entries whose on-chain owner is not
 *                              the multisig you expect — useful for an audit
 *                              pass before submission. (Default: false; such
 *                              entries are reported but excluded from the
 *                              transfer list.)
 */

type Entry = {
  name: string;
  address: string;
};

const SELECTOR_TRANSFER_OWNERSHIP = "0xf2fde38b"; // transferOwnership(address)

function collectContracts(deployment: any): Entry[] {
  const out: Entry[] = [];
  const c = deployment.contracts || {};

  const addrOf = (v: any): string | undefined => v?.proxyAddress || v?.address;

  if (c.protocolConfig && addrOf(c.protocolConfig)) {
    out.push({ name: "protocolConfig", address: addrOf(c.protocolConfig)! });
  }
  if (c.vaultValidator && addrOf(c.vaultValidator)) {
    out.push({ name: "vaultValidator", address: addrOf(c.vaultValidator)! });
  }
  for (const [key, val] of Object.entries<any>(c.vaults || {})) {
    if (addrOf(val)) out.push({ name: `vaults.${key}`, address: addrOf(val)! });
  }
  for (const [key, val] of Object.entries<any>(c.ethVaults || {})) {
    if (addrOf(val)) out.push({ name: `ethVaults.${key}`, address: addrOf(val)! });
  }
  for (const [key, val] of Object.entries<any>(c.oftAdapters || {})) {
    if (addrOf(val)) out.push({ name: `oftAdapters.${key}`, address: addrOf(val)! });
  }
  return out;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const includeMismatched = process.env.INCLUDE_MISMATCHED === "true";

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Deployment file not found:", deploymentFileName);
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const timelock = deployment.contracts?.timelock?.address;
  if (!timelock || !ethers.isAddress(timelock)) {
    console.error("❌ contracts.timelock.address not found — deploy the timelock first.");
    process.exit(1);
  }
  const expectedSender = deployment.contracts?.timelock?.proposers?.[0];
  if (!expectedSender || !ethers.isAddress(expectedSender)) {
    console.error("❌ contracts.timelock.proposers[0] missing or invalid.");
    process.exit(1);
  }

  console.log("Network:", networkName);
  console.log("Timelock:", timelock);
  console.log("Expected sender (proposer multisig):", expectedSender);
  console.log();

  const entries = collectContracts(deployment);
  if (entries.length === 0) {
    console.error("❌ No upgradeable contracts found in deployment file.");
    process.exit(1);
  }

  // Minimal Ownable ABI for live owner check
  const ownableAbi = ["function owner() view returns (address)"];
  const transferIface = new ethers.Interface(["function transferOwnership(address newOwner)"]);
  const expectedData = transferIface.encodeFunctionData("transferOwnership", [timelock]);
  if (!expectedData.startsWith(SELECTOR_TRANSFER_OWNERSHIP)) {
    throw new Error("selector mismatch — ABI drift?");
  }

  const transfers: any[] = [];
  const skipped: any[] = [];
  const unreadable: any[] = [];

  for (const e of entries) {
    let currentOwner: string | undefined;
    try {
      const c = new ethers.Contract(e.address, ownableAbi, ethers.provider);
      currentOwner = await c.owner();
    } catch (err: any) {
      unreadable.push({ name: e.name, address: e.address, error: err?.message || String(err) });
      continue;
    }

    if (currentOwner!.toLowerCase() === timelock.toLowerCase()) {
      skipped.push({ name: e.name, address: e.address, reason: "already owned by timelock" });
      continue;
    }

    const matches = currentOwner!.toLowerCase() === expectedSender.toLowerCase();
    if (!matches && !includeMismatched) {
      skipped.push({
        name: e.name,
        address: e.address,
        reason: `owner ${currentOwner} != expected sender ${expectedSender}`,
      });
      continue;
    }

    transfers.push({
      name: e.name,
      to: e.address,
      value: "0",
      data: expectedData,
      currentOwner,
      expectedSender,
    });
  }

  const outFile = `./deployments/${networkName}-timelock-transfers.json`;
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: networkName,
        chainId: network.chainId.toString(),
        timelock,
        expectedSender,
        generatedAt: new Date().toISOString(),
        transfers,
        skipped,
        unreadable,
      },
      null,
      2
    )
  );

  console.log(`Generated ${transfers.length} transferOwnership tx(s) → ${outFile}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s.name} (${s.address}): ${s.reason}`);
    console.log(`(rerun with INCLUDE_MISMATCHED=true to include mismatched-owner entries)`);
  }
  if (unreadable.length) {
    console.log(`\nUnreadable owner() on ${unreadable.length}:`);
    for (const u of unreadable) console.log(`  - ${u.name} (${u.address}): ${u.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
