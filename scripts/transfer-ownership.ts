import { ethers } from "hardhat";

async function main() {
  const PROXY_ADMIN_ADDRESS = "";
  const NEW_OWNER = "";

  const [signer] = await ethers.getSigners();

  const ProxyAdmin = await ethers.getContractAt("EmberProtocolConfig", PROXY_ADMIN_ADDRESS, signer);

  const signerAddress = await signer.getAddress();

  signer.provider.getBalance(signerAddress).then((balance) => {
    console.log(`Signer balance: ${ethers.formatEther(balance)} ETH (${balance} wei)`);
  });

  signer.provider.getNetwork().then((network) => {
    console.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);
  });
  console.log("Signer address:", signerAddress);
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
