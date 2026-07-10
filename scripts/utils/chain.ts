import { ethers } from "hardhat";

/**
 * Waits until the given address has contract code visible to the connected RPC.
 *
 * `waitForDeployment()` resolves once the deploy tx is mined, but some chains'
 * RPCs (e.g. base, Pharos) lag in surfacing the new code to read calls, so an
 * immediately-following view call (e.g. `PROPOSER_ROLE()`) returns `0x` and
 * ethers throws `BAD_DATA: could not decode result data`. Poll until the code
 * is visible before reading from a freshly deployed contract.
 */
export async function waitForCode(address: string, tries = 15, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const code = await ethers.provider.getCode(address);
      if (code && code !== "0x") return;
    } catch {
      // transient RPC failure — retry
    }
    if (attempt < tries) {
      console.log(
        `   ⏳ contract code not visible yet at ${address}, retrying (${attempt}/${tries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`No contract code at ${address} after ${tries} attempts`);
}
