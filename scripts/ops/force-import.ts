import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";

/**
 * One-time manifest reconciliation. For the active --network, reads
 * `deployments/<network>-deployment.json` and runs
 * `upgrades.forceImport(proxy, Factory, { kind: "uups" })` for every
 * UUPS proxy, then re-runs `upgrades.validateUpgrade` as a self-check.
 *
 * Premise: current HEAD source compiles to the same bytecode (storage layout)
 * as what is deployed in production. If that's not true for some proxy, the
 * self-check will fail loudly — do NOT commit the regenerated manifest in
 * that case.
 *
 * Output: in-place updates to `.openzeppelin/<chain>.json`. Review the diff,
 * then commit it.
 *
 * Usage:
 *   yarn hardhat run scripts/ops/force-import.ts --network mainnet
 *   yarn hardhat run scripts/ops/force-import.ts --network pharos
 *
 * Note: uses hardhat's `network.name` rather than ethers' chainId-derived
 * name so non-standard chains (pharos chainId 1672) resolve correctly.
 */

type Target = { key: string; address: string; contract: string };

function collectTargets(deployment: any): Target[] {
  const targets: Target[] = [];
  const c = deployment?.contracts ?? {};

  if (c.protocolConfig?.proxyAddress) {
    targets.push({
      key: "protocolConfig",
      address: c.protocolConfig.proxyAddress,
      contract: "EmberProtocolConfig",
    });
  }
  if (c.vaultValidator?.proxyAddress) {
    targets.push({
      key: "vaultValidator",
      address: c.vaultValidator.proxyAddress,
      contract: "EmberVaultValidator",
    });
  }
  for (const [k, v] of Object.entries(c.vaults ?? {})) {
    const proxy = (v as any)?.proxyAddress;
    if (proxy) targets.push({ key: `vaults.${k}`, address: proxy, contract: "EmberVault" });
  }
  for (const [k, v] of Object.entries(c.ethVaults ?? {})) {
    const proxy = (v as any)?.proxyAddress;
    if (proxy) targets.push({ key: `ethVaults.${k}`, address: proxy, contract: "EmberETHVault" });
  }
  return targets;
}

async function main() {
  const netName = network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const file = `./deployments/${netName}-deployment.json`;
  if (!fs.existsSync(file)) {
    console.error(`❌ Deployment file not found: ${file}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const targets = collectTargets(deployment);
  if (targets.length === 0) {
    console.error(`❌ No proxies found in ${file}`);
    process.exit(1);
  }

  console.log(`\n🔧 Reconciling OZ manifest for ${targets.length} proxy(ies)`);
  console.log(`   Network: ${netName} (chainId ${chainId})`);
  console.log(`   Manifest: .openzeppelin/<chain>.json\n`);

  const failures: { target: Target; error: string }[] = [];

  for (const t of targets) {
    process.stdout.write(`   ${t.key.padEnd(28)} [${t.contract}] ${t.address} ... `);
    try {
      const Factory = await ethers.getContractFactory(t.contract);
      await upgrades.forceImport(t.address, Factory, { kind: "uups" });
      await upgrades.validateUpgrade(t.address, Factory, { kind: "uups" });
      console.log("✅");
    } catch (err: any) {
      console.log("❌");
      failures.push({ target: t, error: err?.message ?? String(err) });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} proxy(ies) failed reconciliation:\n`);
    for (const { target, error } of failures) {
      console.error(`  ✗ ${target.key} (${target.address}) [${target.contract}]`);
      console.error(`    ${error.split("\n").join("\n    ")}\n`);
    }
    console.error("Do NOT commit .openzeppelin/<chain>.json — the manifest may be poisoned.");
    console.error("Investigate divergence between HEAD source and the deployed implementation.");
    process.exit(1);
  }

  console.log(`\n✅ All ${targets.length} proxy(ies) reconciled.`);
  console.log(`   Review the diff in .openzeppelin/<chain>.json, then commit.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
