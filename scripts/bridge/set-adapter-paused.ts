import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Toggles the paused state on an OFT adapter.
 *
 * Pausing blocks new outbound bridge sends. In-flight inbound messages are
 * still received while paused to avoid stuck funds. Only the adapter owner
 * can call pause()/unpause().
 *
 * Required ENV variables:
 * - ADAPTER_KEY: Key of the OFT adapter in deployment file
 * - PAUSE: "true" to pause, "false" to unpause
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  const adapterKey = process.env.ADAPTER_KEY;
  const pauseEnv = process.env.PAUSE;

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  const deploymentInfo = fs.existsSync(deploymentFileName)
    ? JSON.parse(fs.readFileSync(deploymentFileName, "utf8"))
    : null;

  if (!adapterKey || (pauseEnv !== "true" && pauseEnv !== "false")) {
    console.error("❌ Error: Missing or invalid environment variables!");
    console.log("\nRequired variables:");
    console.log("  ADAPTER_KEY  - Key of the OFT adapter in deployment file");
    console.log('  PAUSE        - "true" to pause, "false" to unpause');

    if (deploymentInfo?.contracts?.oftAdapters) {
      console.log("\nAvailable OFT adapters:");
      Object.keys(deploymentInfo.contracts.oftAdapters).forEach((key) => {
        const adapter = deploymentInfo.contracts.oftAdapters[key];
        console.log(`  - ${key}: ${adapter.address}`);
      });
    }

    console.log("\nExamples:");
    console.log(
      "  ADAPTER_KEY=emberExusdcVaultOFTAdapter PAUSE=true yarn bridge:set-adapter-paused --network sepolia"
    );
    console.log(
      "  ADAPTER_KEY=emberExusdcVaultOFTAdapter PAUSE=false yarn bridge:set-adapter-paused --network sepolia"
    );
    process.exit(1);
  }

  const shouldPause = pauseEnv === "true";

  console.log(`\n${shouldPause ? "⏸  Pausing" : "▶️  Unpausing"} OFT Adapter...\n`);
  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log();

  if (!deploymentInfo) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const adapterInfo = deploymentInfo.contracts.oftAdapters?.[adapterKey];
  if (!adapterInfo) {
    console.error(`❌ Error: OFT adapter '${adapterKey}' not found in deployment file!`);
    process.exit(1);
  }

  console.log("Configuration:");
  console.log("  Adapter Key:", adapterKey);
  console.log("  Adapter Address:", adapterInfo.address);
  console.log("  Target State:", shouldPause ? "paused" : "unpaused");
  console.log();

  const adapter = await ethers.getContractAt("EmberVaultMintBurnOFTAdapter", adapterInfo.address);

  const owner = await adapter.owner();
  console.log("Adapter owner:", owner);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.error("\n❌ Error: Signer is not the adapter owner!");
    console.log(`Only the owner can call ${shouldPause ? "pause()" : "unpause()"}.`);
    process.exit(1);
  }

  const isPaused = await adapter.paused();
  console.log("Current state:", isPaused ? "paused" : "unpaused");

  if (isPaused === shouldPause) {
    console.log(
      `\n✅ Adapter is already ${shouldPause ? "paused" : "unpaused"}. No action needed.`
    );
    process.exit(0);
  }

  console.log(`\n${shouldPause ? "Pausing" : "Unpausing"}...`);
  const tx = shouldPause ? await adapter.pause() : await adapter.unpause();
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  const newState = await adapter.paused();
  if (newState !== shouldPause) {
    console.error("\n❌ Error: Adapter did not transition to expected state!");
    console.log("Expected:", shouldPause ? "paused" : "unpaused");
    console.log("Got:", newState ? "paused" : "unpaused");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`✅ Adapter ${shouldPause ? "Paused" : "Unpaused"}`);
  console.log("=".repeat(70));
  console.log("\nAdapter:", adapterInfo.address);
  if (shouldPause) {
    console.log("Outbound bridge sends are now blocked. Inbound messages still process.");
  } else {
    console.log("Bridge operations resumed.");
  }
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
