import { ethers } from "hardhat";
import {
  addrEq,
  bad,
  c,
  dim,
  fmtAddr,
  isUpdateMode,
  loadDeployment,
  ok,
  saveDeployment,
  warn,
} from "./utils/verify-helpers";

/**
 * Sets the guardian on EmberProtocolConfig via `setGuardian(newGuardian)`.
 *
 * The guardian is the emergency-response role (blacklist + pause fast-paths).
 * `setGuardian` is `onlyOwner`, so the configured signer (PRIVATE_KEY) must be
 * the current owner of protocolConfig. If protocolConfig is owned by a Timelock
 * a direct call is impossible — generate the timelock tx instead:
 *   - yarn admin:gen-timelock-transfers (for the surrounding ownership flow)
 *
 * Required ENV:
 *   NEW_GUARDIAN     address to set as guardian. Pass the zero address
 *                    (0x0000...0000) to DISABLE all guardian-gated functions.
 *
 * Optional ENV:
 *   CONTRACT_ADDRESS explicit protocolConfig proxy address (overrides the
 *                    address resolved from the deployment file).
 *
 * Execution mode:
 *   Dry-run is the DEFAULT — the script only simulates (static call) and writes
 *   nothing. Pass UPDATE=true (or WRITE=true) to actually send the transaction
 *   and update the deployment file. Use an env var, not a CLI flag — Hardhat
 *   rejects flags it doesn't recognise before the script runs.
 *
 * Usage:
 *   # dry-run (default): simulate only
 *   NEW_GUARDIAN=0x... yarn update:guardian --network base
 *   # execute:
 *   UPDATE=true NEW_GUARDIAN=0x... yarn update:guardian --network base
 *   # disable the guardian role entirely:
 *   UPDATE=true NEW_GUARDIAN=0x0000000000000000000000000000000000000000 yarn update:guardian --network base
 */

function fail(msg: string): never {
  console.error(bad(`\n❌ ${msg}`));
  process.exit(1);
}

async function main() {
  const newGuardian = process.env.NEW_GUARDIAN?.trim();
  const dryRun = !isUpdateMode(); // dry-run by default; UPDATE=true / WRITE=true to execute

  if (!newGuardian)
    fail("NEW_GUARDIAN is required (use the zero address to disable the guardian).");
  if (!ethers.isAddress(newGuardian)) fail(`Invalid NEW_GUARDIAN: ${newGuardian}`);

  const { path: filePath, networkName, data } = loadDeployment();
  const node = data.contracts?.protocolConfig;
  const address = process.env.CONTRACT_ADDRESS?.trim() || node?.proxyAddress;
  if (!address) fail("contracts.protocolConfig not found (and no CONTRACT_ADDRESS override).");

  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", address);

  const currentGuardian: string = await protocolConfig.guardian();
  const owner: string = await protocolConfig.owner();
  const disabling = addrEq(newGuardian, ethers.ZeroAddress);

  console.log(`\n${c.bold}🛡️  Update guardian${c.reset}`);
  console.log(`  Network:  ${networkName} (chainId ${net.chainId})`);
  console.log(`  Signer:   ${fmtAddr(signer.address)}`);
  console.log(`  Target:   protocolConfig`);
  console.log(`  Address:  ${fmtAddr(address)}`);
  console.log(
    `  Mode:     ${dryRun ? warn("DRY-RUN (default — set UPDATE=true to execute)") : ok("EXECUTE")}`
  );

  console.log(`\n${c.bold}Guardian update${c.reset}`);
  console.log(`  Owner:            ${fmtAddr(owner)}`);
  console.log(`  Current guardian: ${fmtAddr(currentGuardian)}`);
  console.log(
    `  New guardian:     ${fmtAddr(newGuardian)}${disabling ? dim("  (disables guardian-gated functions)") : ""}`
  );

  if (addrEq(currentGuardian, newGuardian)) {
    // Mirrors the contract's `SameValue()` revert — nothing to do.
    console.log(ok("  ✓ Guardian already set to the requested address — nothing to do."));
    console.log();
    return;
  }
  if (!addrEq(owner, signer.address)) {
    console.log(bad(`  Signer ${fmtAddr(signer.address)} is NOT the protocolConfig owner.`));
    if (ethers.isAddress(owner)) {
      console.log(
        dim(
          "  This contract is owned by another account (likely a Timelock).\n" +
            "  setGuardian is onlyOwner — produce the timelock/multisig tx instead."
        )
      );
    }
    fail("Cannot set guardian: signer is not the owner.");
  }

  // Simulate first for a clean revert reason.
  try {
    await protocolConfig.setGuardian.staticCall(newGuardian);
  } catch (e: any) {
    fail(`setGuardian simulation reverted: ${e?.shortMessage || e?.reason || e?.message || e}`);
  }

  if (dryRun) {
    console.log(warn("  [DRY_RUN] simulation succeeded; not sending."));
    console.log();
    return;
  }

  const tx = await protocolConfig.setGuardian(newGuardian);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt?.blockNumber}`);

  const updated: string = await protocolConfig.guardian();
  if (!addrEq(updated, newGuardian)) {
    fail(`Verification failed — guardian is ${updated}, expected ${newGuardian}.`);
  }
  console.log(ok("  ✓ Guardian updated."));

  if (node) {
    node.guardian = fmtAddr(newGuardian);
    node.guardianUpdatedAt = new Date().toISOString();
    saveDeployment({ path: filePath, networkName, data });
    console.log(`\n  ${ok(`Deployment file updated: ${filePath}`)}`);
  } else {
    console.log(dim("\n  No file changes written (protocolConfig node not in deployment file)."));
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
