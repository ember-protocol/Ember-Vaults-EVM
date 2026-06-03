import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * CI gate: for the active hardhat --network, read
 * `deployments/<network>-deployment.json` and run `upgrades.validateUpgrade`
 * for every recorded UUPS proxy against the current source.
 *
 * Exits non-zero on the first validation failure (or on any other error).
 *
 * Usage:
 *   yarn hardhat run scripts/ci/validate-upgrades.ts --network mainnet
 *   yarn hardhat run scripts/ci/validate-upgrades.ts --network sepolia
 *
 * Requires the matching `.openzeppelin/<chain>.json` manifest to be present
 * for every proxy being checked. If a proxy is missing from the manifest,
 * register it once with `upgrades.forceImport(...)` and commit the manifest.
 */

type ProxyTarget = { key: string; address: string; contract: string };

function collectTargets(deployment: any): ProxyTarget[] {
  const targets: ProxyTarget[] = [];
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

async function probeRpc(): Promise<{ chainId: bigint; name: string; blockNumber: number }> {
  // Surface RPC issues as a clear, dedicated failure rather than letting them
  // bubble up out of validateUpgrade as opaque provider errors.
  const timeoutMs = 15_000;
  const probe = (async () => {
    const net = await ethers.provider.getNetwork();
    const blockNumber = await ethers.provider.getBlockNumber();
    return { chainId: net.chainId, name: net.name, blockNumber };
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`RPC probe timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([probe, timeout]);
}

async function main() {
  let netInfo;
  try {
    netInfo = await probeRpc();
    console.log(
      `🔌 RPC reachable — chainId ${netInfo.chainId} (${netInfo.name}), head block ${netInfo.blockNumber}`
    );
  } catch (err: any) {
    console.error("❌ RPC probe failed — cannot reach the configured network.");
    console.error("   ", err?.message ?? err);
    console.error(
      "   Set MAINNET_RPC_URL / SEPOLIA_RPC_URL to a working endpoint (repo secret or env)."
    );
    // Exit code 2 signals "infrastructure problem, retry me on a different RPC"
    // to the CI wrapper. Validation failures use exit code 1 so they don't get
    // retried (a layout incompatibility is the same regardless of which node
    // you ask).
    process.exit(2);
  }

  // Use hardhat's network name (which honors --network <name>) rather than
  // ethers' chainId-derived name. Non-standard chains like pharos (chainId
  // 1672) would otherwise resolve to "unknown".
  const netName = network.name;
  const deploymentFile = path.resolve(`./deployments/${netName}-deployment.json`);

  if (!fs.existsSync(deploymentFile)) {
    console.error(`❌ Deployment file not found: ${deploymentFile}`);
    console.error("   Pass --network <name> matching a file in ./deployments/.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const targets = collectTargets(deployment);

  if (targets.length === 0) {
    console.error(`❌ No proxies found in ${deploymentFile}`);
    process.exit(1);
  }

  console.log(`\n🔒 Validating upgrade compatibility for ${targets.length} proxy(ies)`);
  console.log(`   Network: ${netName} (chainId ${netInfo.chainId})`);
  console.log(`   Deployment: ${deploymentFile}\n`);

  const failures: { target: ProxyTarget; error: string }[] = [];

  for (const target of targets) {
    process.stdout.write(`   ${target.key} [${target.contract}] ${target.address} ... `);
    try {
      const Factory = await ethers.getContractFactory(target.contract);
      await upgrades.validateUpgrade(target.address, Factory, { kind: "uups" });
      console.log("✅");
    } catch (err: any) {
      console.log("❌");
      failures.push({ target, error: err?.message ?? String(err) });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} proxy(ies) failed upgrade validation:\n`);
    for (const { target, error } of failures) {
      console.error(`  ✗ ${target.key} (${target.address}) [${target.contract}]`);
      console.error(`    ${error.split("\n").join("\n    ")}\n`);
    }
    console.error("If a failure says the proxy is not registered, run `upgrades.forceImport` once");
    console.error("with the deployed implementation and commit the updated manifest.");
    process.exit(1);
  }

  console.log(
    `\n✅ All ${targets.length} proxy(ies) on ${network.name} pass upgrade validation.\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
