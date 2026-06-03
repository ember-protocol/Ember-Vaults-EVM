import { ethers } from "hardhat";
import * as fs from "fs";
import { getLzEndpointAddress } from "../../config/layerzero.config";

/**
 * Sets the LayerZero delegate on an OFT adapter (OApp).
 *
 * The delegate is the address authorized to call setConfig / setSendLibrary /
 * setReceiveLibrary on the LayerZero endpoint on behalf of the OApp. Only the
 * OApp owner can change it.
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 *
 * Optional ENV variables:
 * - DELEGATE_ADDRESS: Delegate to set (defaults to signer)
 */
async function main() {
  console.log("\n👤 Setting LayerZero Delegate...\n");

  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  // Load deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const adapterKey = process.env.ADAPTER_KEY;

  if (!adapterKey) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY       - Key of the OFT adapter in deployment file");
    console.log("\nOptional variables:");
    console.log("  DELEGATE_ADDRESS  - Delegate to set (default: signer)");

    console.log("\nAvailable OFT adapters:");
    if (deploymentInfo.contracts.oftAdapters) {
      Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
        const adapter = deploymentInfo.contracts.oftAdapters[key];
        console.log(`  - ${key}: ${adapter.address}`);
      });
    } else {
      console.log("  No OFT adapters found.");
    }

    console.log("\nExample:");
    console.log(
      "  ADAPTER_KEY=emberExusdcVaultOFTAdapter yarn bridge:set-delegate --network sepolia"
    );
    process.exit(1);
  }

  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found in deployment file!`);
    process.exit(1);
  }

  const delegateAddress = ethers.getAddress(process.env.DELEGATE_ADDRESS || signer.address);

  console.log("Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter (OApp):", adapterInfo.address);
  console.log("  New Delegate:", delegateAddress);
  console.log();

  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  // Only the OApp owner can change the delegate
  const owner = await adapter.owner();
  console.log("Adapter owner:", owner);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("\n❌ Error: Signer is not the adapter owner!");
    console.log("Only the owner can call setDelegate().");
    process.exit(1);
  }

  // Read current delegate from the endpoint
  const endpointAddress = getLzEndpointAddress(networkName);
  const endpoint = new ethers.Contract(
    endpointAddress,
    ["function delegates(address oapp) external view returns (address)"],
    signer
  );

  const currentDelegate = await endpoint.delegates(adapterInfo.address);
  console.log(
    "Current delegate:",
    currentDelegate === ethers.ZeroAddress ? "(none)" : currentDelegate
  );

  if (currentDelegate.toLowerCase() === delegateAddress.toLowerCase()) {
    console.log("\n✅ Delegate is already set to the requested address. No action needed.");
    process.exit(0);
  }

  console.log("\nSetting delegate...");
  const tx = await adapter.setDelegate(delegateAddress);
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  const newDelegate = await endpoint.delegates(adapterInfo.address);
  if (newDelegate.toLowerCase() !== delegateAddress.toLowerCase()) {
    console.error("\n❌ Error: Delegate verification failed!");
    console.log("Expected:", delegateAddress);
    console.log("Got:", newDelegate);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ Delegate Set Successfully!");
  console.log("=".repeat(70));
  console.log("\nAdapter:", adapterInfo.address);
  console.log("Delegate:", newDelegate);
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
