import { ethers, upgrades } from "hardhat";

// ERC-1967 implementation storage slot:
// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Reads a proxy's ERC-1967 implementation address, tolerant of RPC read lag.
 *
 * Some chains' RPCs (e.g. Pharos) don't surface the implementation storage
 * slot immediately after the proxy deploy tx is mined, which makes
 * `upgrades.erc1967.getImplementationAddress` throw
 * "...doesn't look like an ERC 1967 proxy with a logic contract address".
 * This polls the OZ helper and falls back to reading the slot directly,
 * retrying until the slot is visible.
 */
export async function getImplementationAddressWithRetry(
  proxyAddress: string,
  tries = 10,
  delayMs = 3000
): Promise<string> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Preferred path: OZ plugin (also validates it's a real ERC-1967 proxy).
    try {
      const impl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      if (impl && impl !== ethers.ZeroAddress) return impl;
    } catch {
      // fall through to a direct slot read on RPC lag / transient failure
    }

    // Fallback: read the implementation slot straight off-chain.
    try {
      const raw = await ethers.provider.getStorage(proxyAddress, ERC1967_IMPLEMENTATION_SLOT);
      const addr = ethers.getAddress("0x" + raw.slice(-40));
      if (addr !== ethers.ZeroAddress) return addr;
    } catch {
      // ignore and retry
    }

    if (attempt < tries) {
      console.log(
        `   ⏳ implementation slot not visible yet for ${proxyAddress}, retrying (${attempt}/${tries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Could not read ERC-1967 implementation address for ${proxyAddress} after ${tries} attempts`
  );
}
