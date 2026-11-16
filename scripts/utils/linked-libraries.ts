import { artifacts, ethers } from "hardhat";

/**
 * Library addresses linked into a deployed contract, read from its runtime bytecode at the
 * offsets the compiled artifact records (`deployedLinkReferences`).
 *
 * Returns undefined when the deployed bytecode doesn't line up with this build: every reference
 * to a library must carry the same address, and that address must have code. A contract built
 * from different source has different offsets, so this fails closed rather than reporting
 * whatever 20 bytes happen to sit there.
 */
export async function readLinkedLibraries(
  contractName: string,
  address: string
): Promise<Record<string, string> | undefined> {
  const { deployedLinkReferences } = await artifacts.readArtifact(contractName);
  const code = (await ethers.provider.getCode(address)).slice(2);
  const linked: Record<string, string> = {};
  try {
    for (const libraries of Object.values(deployedLinkReferences)) {
      for (const [name, refs] of Object.entries(libraries)) {
        const found = new Set(
          refs.map((r) => code.slice(r.start * 2, (r.start + r.length) * 2).toLowerCase())
        );
        if (found.size !== 1) return undefined;
        const library = ethers.getAddress("0x" + [...found][0]);
        if ((await ethers.provider.getCode(library)) === "0x") return undefined;
        linked[name] = library;
      }
    }
  } catch {
    return undefined;
  }
  return linked;
}
