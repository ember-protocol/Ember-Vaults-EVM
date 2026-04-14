import { ethers } from "hardhat";

async function main() {
  const PROTOCOL_PROXY_ADMIN_ADDRESS = "0xtest";
  const VAULT_ADDRESS = "0xtest";
  const NEW_OWNER = "0xtest";

  const [signer] = await ethers.getSigners();

  const protocolConfig = await ethers.getContractAt(
    "EmberProtocolConfig",
    PROTOCOL_PROXY_ADMIN_ADDRESS,
    signer
  );

  const tx = await protocolConfig.updateVaultAdmin(VAULT_ADDRESS, NEW_OWNER);
  await tx.wait();

  console.log("vault admin updated to new owner: ", NEW_OWNER);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
