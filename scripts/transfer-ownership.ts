import { ethers } from "hardhat";

async function main() {
  const PROXY_ADMIN_ADDRESS = "0x0b9342C15143E8F54a83f887C280A922f4c48771";
  const NEW_OWNER = "0xE9F9f43F89e4C375DBEB845477b35DBE3ccBe4c6";

  const [signer] = await ethers.getSigners();

  const ProxyAdmin = await ethers.getContractAt("EmberVault", PROXY_ADMIN_ADDRESS, signer);

  const currentOwner = await ProxyAdmin.owner();
  console.log("Current ProxyAdmin owner:", currentOwner);

  const tx = await ProxyAdmin.transferOwnership(NEW_OWNER);
  await tx.wait();

  console.log("ProxyAdmin ownership transferred to:", NEW_OWNER);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
