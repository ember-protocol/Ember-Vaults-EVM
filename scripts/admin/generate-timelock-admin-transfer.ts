import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Generates `EmberProtocolConfig.updateVaultAdmin(vault, timelock)` tx-bytes
 * for every vault in the deployment file. Submit these BEFORE the
 * ownership-transfer txs (yarn admin:gen-timelock-transfers); after the
 * vault owner becomes the timelock, this update would itself need to be
 * scheduled and waited out.
 *
 * Effect on each vault: roles.admin -> timelock, which causes every
 * onlyAdmin function to require schedule -> minDelay -> execute via the
 * timelock (e.g. setOperator, setRateManager, setMaxTVL,
 * setSubAccountStatus, setPausedStatus, setVaultValidator, etc.).
 *
 * Output: deployments/<network>-timelock-admin-transfers.json
 *   {
 *     "to":   protocolConfig,
 *     "data": updateVaultAdmin(vault, timelock),
 *     ...
 *   }
 *
 * The operator and rateManager roles are NOT touched — keep those on the
 * EOAs that perform frequent rotations.
 *
 * Optional ENV variables:
 *   - INCLUDE_MISMATCHED=true  Include vaults whose current owner is not
 *                              the multisig you expect — by default they
 *                              are reported but excluded (the multisig
 *                              cannot satisfy `caller == owner()` for
 *                              those, so the tx would revert).
 */

type Vault = { key: string; address: string };

function collectVaults(deployment: any): Vault[] {
  const out: Vault[] = [];
  const c = deployment.contracts || {};
  for (const [k, v] of Object.entries<any>(c.vaults || {})) {
    if (v?.proxyAddress) out.push({ key: `vaults.${k}`, address: v.proxyAddress });
  }
  for (const [k, v] of Object.entries<any>(c.ethVaults || {})) {
    if (v?.proxyAddress) out.push({ key: `ethVaults.${k}`, address: v.proxyAddress });
  }
  return out;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const includeMismatched = process.env.INCLUDE_MISMATCHED === "true";

  const deploymentFile = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFile)) {
    console.error("❌ Deployment file not found:", deploymentFile);
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

  const timelock = deployment.contracts?.timelock?.address;
  if (!timelock || !ethers.isAddress(timelock)) {
    console.error("❌ contracts.timelock.address missing — deploy the timelock first.");
    process.exit(1);
  }
  const expectedSender = deployment.contracts?.timelock?.proposers?.[0];
  if (!expectedSender || !ethers.isAddress(expectedSender)) {
    console.error("❌ contracts.timelock.proposers[0] missing.");
    process.exit(1);
  }
  const protocolConfig = deployment.contracts?.protocolConfig?.proxyAddress;
  if (!protocolConfig || !ethers.isAddress(protocolConfig)) {
    console.error("❌ contracts.protocolConfig.proxyAddress missing.");
    process.exit(1);
  }

  console.log("Network:        ", networkName);
  console.log("ProtocolConfig: ", protocolConfig);
  console.log("Timelock:       ", timelock);
  console.log("Expected sender:", expectedSender);
  console.log();

  const vaults = collectVaults(deployment);
  if (vaults.length === 0) {
    console.error("❌ No vaults found in deployment file.");
    process.exit(1);
  }

  const pcIface = new ethers.Interface([
    "function updateVaultAdmin(address vault, address newAdmin)",
  ]);
  const ownableAbi = [
    "function owner() view returns (address)",
    // Optional read-only — if exposed on the vault. Falls back gracefully.
    "function admin() view returns (address)",
  ];

  const transfers: any[] = [];
  const skipped: any[] = [];

  for (const v of vaults) {
    let owner: string | undefined;
    let currentAdmin: string | undefined;
    try {
      const c = new ethers.Contract(v.address, ownableAbi, ethers.provider);
      owner = await c.owner();
    } catch (e: any) {
      skipped.push({ ...v, reason: `owner() failed: ${e?.message || e}` });
      continue;
    }
    try {
      const c = new ethers.Contract(v.address, ownableAbi, ethers.provider);
      currentAdmin = await c.admin();
    } catch {
      // Many of our vaults expose admin via roles.admin, not a top-level admin().
      // Pull from deployment file as a fallback for reporting purposes only.
      currentAdmin = (
        deployment.contracts.vaults?.[v.key.split(".")[1]] ||
        deployment.contracts.ethVaults?.[v.key.split(".")[1]]
      )?.admin;
    }

    if (currentAdmin?.toLowerCase() === timelock.toLowerCase()) {
      skipped.push({ ...v, reason: "admin is already the timelock" });
      continue;
    }

    const ownerMatches = owner!.toLowerCase() === expectedSender.toLowerCase();
    if (!ownerMatches && !includeMismatched) {
      skipped.push({
        ...v,
        reason: `owner ${owner} != expected sender ${expectedSender} — multisig cannot call updateVaultAdmin (caller != owner)`,
      });
      continue;
    }

    transfers.push({
      vault: v.key,
      vaultAddress: v.address,
      to: protocolConfig,
      value: "0",
      data: pcIface.encodeFunctionData("updateVaultAdmin", [v.address, timelock]),
      vaultOwner: owner,
      currentAdmin: currentAdmin || null,
      newAdmin: timelock,
      expectedSender,
    });
  }

  const outFile = `./deployments/${networkName}-timelock-admin-transfers.json`;
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: networkName,
        chainId: network.chainId.toString(),
        protocolConfig,
        timelock,
        expectedSender,
        warning:
          "Submit these BEFORE owner-transfer txs. Once the vault owner is the timelock, updateVaultAdmin must itself be scheduled.",
        generatedAt: new Date().toISOString(),
        transfers,
        skipped,
      },
      null,
      2
    )
  );

  console.log(`Generated ${transfers.length} updateVaultAdmin tx(s) → ${outFile}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s.key} (${s.address}): ${s.reason}`);
    if (skipped.some((s) => s.reason.startsWith("owner "))) {
      console.log(`(rerun with INCLUDE_MISMATCHED=true to include them anyway)`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
