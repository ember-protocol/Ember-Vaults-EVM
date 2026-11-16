import { ethers } from "hardhat";
import * as fs from "fs";
import { getCcipConfig, poolKeyForVault } from "../../config/ccip.config";

/**
 * Sets the pool's allowed finality — which faster-than-finality (FTF) modes it will accept.
 *
 * Default is WAIT_FOR_FINALITY_FLAG (0x00000000), meaning the pool accepts only fully finalized
 * messages. FTF trades reorg safety for latency, and per Chainlink's FINALITY_INVARIANTS it must
 * be opted into at EVERY layer: sender, pool, executor and CCV (the receiver layer is skipped for
 * token-only transfers). Two of those layers are Chainlink's, so setting this alone does not make
 * FTF work — it only stops the pool being the one that rejects it.
 *
 * Encoding (FinalityCodec):
 *   0x00000000  wait for full finality — the default, and always accepted
 *   0x00010000  WAIT_FOR_SAFE_FLAG — wait for the `safe` head
 *   0x0000NNNN  block depth N in the low 16 bits
 *
 * A *requested* value must be exactly one mode. An *allowed* value may combine them, so
 * 0x00010001 permits both safe-tag requests and any depth >= 1. Depth matching is a floor: an
 * allowed depth of N permits requests of N or deeper, and rejects anything shallower.
 *
 * Required ENV:
 *   VAULT_KEY   Key of the vault in the deployment file
 *
 * Required ENV (cont.):
 *   FINALITY    bytes4 to allow. REQUIRED — there is deliberately no default. This script runs
 *               against mainnet as readily as testnet, and the permissive value is only ever
 *               right on testnet, so enabling faster-than-finality has to be a typed decision
 *               rather than something you get by omission.
 *                 0x00000000  wait for full finality — disables FTF
 *                 0x00010001  safe flag + any depth — permissive, testnet
 */

const WAIT_FOR_FINALITY = "0x00000000";

function describe(value: string): string {
  const n = Number(BigInt(value));
  if (n === 0) return "wait for full finality (FTF disabled)";
  const depth = n & 0xffff;
  const safe = (n & 0x00010000) !== 0;
  const parts: string[] = [];
  if (safe) parts.push("WAIT_FOR_SAFE_FLAG");
  if (depth > 0) parts.push(`block depth >= ${depth}`);
  const unknown = n & ~0x0001ffff;
  if (unknown) parts.push(`reserved flag bits 0x${unknown.toString(16)}`);
  return parts.join(" + ") || "unrecognised";
}

async function main() {
  console.log("\n⏱️  Setting pool allowed finality...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const ccip = getCcipConfig(networkName);

  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY is required.");
    process.exit(1);
  }

  if (!process.env.FINALITY) {
    console.error("❌ Error: FINALITY is required — this script has no default.");
    console.error("   Faster-than-finality trades reorg safety for latency, and this script");
    console.error("   runs on mainnet as readily as testnet, so the value must be explicit.");
    console.error("     FINALITY=0x00000000  wait for full finality (disables FTF)");
    console.error("     FINALITY=0x00010001  safe flag + any depth (permissive, testnet)");
    process.exit(1);
  }
  const requested = process.env.FINALITY.toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(requested)) {
    console.error(`❌ Error: FINALITY must be a bytes4 hex value, got '${requested}'.`);
    process.exit(1);
  }

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const poolKey = poolKeyForVault(vaultKey);
  const poolInfo = deploymentInfo.contracts.ccipTokenPools?.[poolKey];
  if (!poolInfo) {
    console.error(`❌ Error: no pool '${poolKey}' in ${deploymentFileName}.`);
    process.exit(1);
  }

  const pool = await ethers.getContractAt("EmberTokenPool", poolInfo.address);
  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("❌ Error: setAllowedFinalityConfig is onlyOwner.");
    console.log("   Pool owner:", owner);
    console.log("   Signer:    ", signer.address);
    process.exit(1);
  }

  const current: string = await pool.getAllowedFinalityConfig();
  console.log("Network:", ccip.label);
  console.log("Pool:   ", poolInfo.address);
  console.log("Current:", current, "-", describe(current));
  console.log("New:    ", requested, "-", describe(requested));

  if (current.toLowerCase() === requested) {
    console.log("\n✅ Already set. Nothing to do.\n");
    return;
  }

  if (requested !== WAIT_FOR_FINALITY) {
    console.log("\n⚠️  Enabling FTF accepts reorg risk: shares can be minted on the destination");
    console.log("    against a source burn that is not yet final. Per INV-FIN-REORG-1 a reorg can");
    console.log("    also re-emit a send under a different messageNumber, which any indexer");
    console.log("    correlating on message identity has to tolerate.");
  }

  const tx = await pool.setAllowedFinalityConfig(requested);
  const receipt = await tx.wait();
  console.log("\n✅ Confirmed in block", receipt?.blockNumber);

  // Poll: tx.wait() only proves the tx was mined on the node that answered.
  let confirmed: string = await pool.getAllowedFinalityConfig();
  for (let i = 0; i < 20 && confirmed.toLowerCase() !== requested; i++) {
    if (i === 0) console.log("  ⏳ waiting for the change to be visible on the RPC...");
    await new Promise((r) => setTimeout(r, 3000));
    confirmed = await pool.getAllowedFinalityConfig();
  }
  console.log("   allowedFinalityConfig now:", confirmed, "-", describe(confirmed));

  poolInfo.allowedFinalityConfig = confirmed;
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2) + "\n");

  console.log("\n💡 The pool now permits it, but FTF needs every layer to agree. Send with:");
  console.log(
    `   VAULT_KEY=${vaultKey} AMOUNT=1 FINALITY=0x00010000 yarn ccip:send --network ${networkName}`
  );
  console.log("   A revert at send time means the executor or a CCV rejected the mode.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
