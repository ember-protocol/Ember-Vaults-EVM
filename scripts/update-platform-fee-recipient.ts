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
 * Sets the platform fee recipient on EmberProtocolConfig via
 * `updatePlatformFeeRecipient(recipient)`.
 *
 * `updatePlatformFeeRecipient` is `onlyOwner`, so the configured signer
 * (PRIVATE_KEY) must be the current owner of protocolConfig.
 *
 * Required ENV:
 *   NEW_FEE_RECIPIENT  address to receive platform fees (non-zero).
 *
 * Optional ENV:
 *   CONTRACT_ADDRESS   explicit protocolConfig proxy address (overrides the
 *                      address resolved from the deployment file).
 *
 * Execution mode:
 *   Dry-run is the DEFAULT — the script only simulates (static call) and writes
 *   nothing. Pass UPDATE=true (or WRITE=true) to actually send the transaction
 *   and update the deployment file.
 *
 * Usage:
 *   # dry-run (default): simulate only
 *   NEW_FEE_RECIPIENT=0x... yarn update:fee-recipient --network arbitrum
 *   # execute:
 *   UPDATE=true NEW_FEE_RECIPIENT=0x... yarn update:fee-recipient --network arbitrum
 */

function fail(msg: string): never {
  console.error(bad(`\n❌ ${msg}`));
  process.exit(1);
}

async function main() {
  const newRecipient = process.env.NEW_FEE_RECIPIENT?.trim();
  const dryRun = !isUpdateMode(); // dry-run by default; UPDATE=true / WRITE=true to execute

  if (!newRecipient) fail("NEW_FEE_RECIPIENT is required.");
  if (!ethers.isAddress(newRecipient)) fail(`Invalid NEW_FEE_RECIPIENT: ${newRecipient}`);
  if (addrEq(newRecipient, ethers.ZeroAddress)) {
    // Mirrors the contract's `ZeroAddress()` revert.
    fail("NEW_FEE_RECIPIENT cannot be the zero address.");
  }

  const { path: filePath, networkName, data } = loadDeployment();
  const node = data.contracts?.protocolConfig;
  const address = process.env.CONTRACT_ADDRESS?.trim() || node?.proxyAddress;
  if (!address) fail("contracts.protocolConfig not found (and no CONTRACT_ADDRESS override).");

  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", address);

  const currentRecipient: string = (await protocolConfig.protocolConfig()).platformFeeRecipient;
  const owner: string = await protocolConfig.owner();

  console.log(`\n${c.bold}💸 Update platform fee recipient${c.reset}`);
  console.log(`  Network:  ${networkName} (chainId ${net.chainId})`);
  console.log(`  Signer:   ${fmtAddr(signer.address)}`);
  console.log(`  Target:   protocolConfig`);
  console.log(`  Address:  ${fmtAddr(address)}`);
  console.log(
    `  Mode:     ${dryRun ? warn("DRY-RUN (default — set UPDATE=true to execute)") : ok("EXECUTE")}`
  );

  console.log(`\n${c.bold}Fee recipient update${c.reset}`);
  console.log(`  Owner:             ${fmtAddr(owner)}`);
  console.log(`  Current recipient: ${fmtAddr(currentRecipient)}`);
  console.log(`  New recipient:     ${fmtAddr(newRecipient)}`);

  if (addrEq(currentRecipient, newRecipient)) {
    // Mirrors the contract's `SameValue()` revert — nothing to do.
    console.log(ok("  ✓ Fee recipient already set to the requested address — nothing to do."));
    console.log();
    return;
  }
  if (!addrEq(owner, signer.address)) {
    console.log(bad(`  Signer ${fmtAddr(signer.address)} is NOT the protocolConfig owner.`));
    console.log(
      dim(
        "  This contract is owned by another account (likely a Timelock).\n" +
          "  updatePlatformFeeRecipient is onlyOwner — produce the timelock/multisig tx instead."
      )
    );
    fail("Cannot update fee recipient: signer is not the owner.");
  }

  // Simulate first for a clean revert reason.
  try {
    await protocolConfig.updatePlatformFeeRecipient.staticCall(newRecipient);
  } catch (e: any) {
    fail(
      `updatePlatformFeeRecipient simulation reverted: ${e?.shortMessage || e?.reason || e?.message || e}`
    );
  }

  if (dryRun) {
    console.log(warn("  [DRY_RUN] simulation succeeded; not sending."));
    console.log();
    return;
  }

  const tx = await protocolConfig.updatePlatformFeeRecipient(newRecipient);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt?.blockNumber}`);

  const updated: string = (await protocolConfig.protocolConfig()).platformFeeRecipient;
  if (!addrEq(updated, newRecipient)) {
    fail(`Verification failed — fee recipient is ${updated}, expected ${newRecipient}.`);
  }
  console.log(ok("  ✓ Fee recipient updated."));

  if (node) {
    node.platformFeeRecipient = fmtAddr(newRecipient);
    node.platformFeeRecipientUpdatedAt = new Date().toISOString();
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
