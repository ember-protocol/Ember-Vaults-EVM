import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

/**
 * Deploys an EmberDepositParkingLot (UUPS proxy) bound to an EmberVault.
 *
 * After deploying, set this parking lot on the vault so it can forward deposits (this also
 * gates direct deposits to the parking lot). Must be called through the protocol config by
 * the vault admin:
 *   protocolConfig.setVaultParkingLot(vault, parkingLotProxy)   [vault admin]
 *
 * Required ENV:
 * - PARKING_LOT_VAULT     : target EmberVault proxy address
 * - PARKING_LOT_OPERATOR  : operator allowed to process the queue
 * Optional ENV:
 * - PARKING_LOT_OWNER     : owner/admin (defaults to deployer)
 * - PARKING_LOT_KEY       : key under contracts.depositParkingLots (defaults to "default")
 */
async function main() {
  console.log("\n🅿️  Deploying EmberDepositParkingLot...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const deploymentFileName = `./deployments/${network.name}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found! Deploy the protocol config + vault first.");
    process.exit(1);
  }
  const deploymentInfo: any = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  const vaultAddress = process.env.PARKING_LOT_VAULT;
  const operator = process.env.PARKING_LOT_OPERATOR;
  const owner = process.env.PARKING_LOT_OWNER || deployer.address;
  const key = process.env.PARKING_LOT_KEY || "default";

  if (!protocolConfigAddress || !vaultAddress || !operator) {
    console.error("❌ Error: Missing required configuration.");
    console.log("  protocolConfig (from deployment file):", protocolConfigAddress);
    console.log("  PARKING_LOT_VAULT     :", vaultAddress);
    console.log("  PARKING_LOT_OPERATOR  :", operator);
    process.exit(1);
  }

  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Target Vault   :", vaultAddress);
  console.log("  Operator       :", operator);
  console.log("  Owner          :", owner);

  // F-4 trust assumption: the parking lot custodies live user escrow and is UUPS-upgradeable by
  // its owner with no on-chain delay. For production the owner MUST be a Timelock and/or multisig
  // (an upgrade can move escrowed funds). Warn loudly if it resolves to the deployer EOA.
  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    console.warn(
      "\n⚠️  WARNING: parking-lot owner is the deployer EOA. This contract holds live user escrow\n" +
        "    and can be drained via a UUPS upgrade with no delay. Set PARKING_LOT_OWNER to a\n" +
        "    Timelock and/or multisig before using this in production."
    );
  }

  const factory = await ethers.getContractFactory("EmberDepositParkingLot");
  const parkingLot = (await upgrades.deployProxy(
    factory,
    [protocolConfigAddress, vaultAddress, operator, owner],
    { initializer: "initialize", kind: "uups" }
  )) as any;
  await parkingLot.waitForDeployment();

  const proxyAddress = await parkingLot.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  const deploymentTx = parkingLot.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
  }

  console.log("✅ EmberDepositParkingLot proxy:", proxyAddress);
  console.log("📝 Implementation:", implementationAddress);

  if (!deploymentInfo.contracts.depositParkingLots) {
    deploymentInfo.contracts.depositParkingLots = {};
  }
  deploymentInfo.contracts.depositParkingLots[key] = {
    proxyAddress,
    implementationAddress,
    ownerAddress: owner,
    vault: vaultAddress,
    operator,
    protocolConfig: protocolConfigAddress,
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber,
  };
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log(
    "\n💡 Next: set this parking lot on the vault (as the vault admin, via protocol config):"
  );
  console.log(`   protocolConfig.setVaultParkingLot("<vault>", "${proxyAddress}")`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
