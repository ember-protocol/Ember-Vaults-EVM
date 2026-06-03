import { ethers } from "hardhat";
import * as fs from "fs";
import { getLzEndpoint, addressToBytes32 } from "../../config/layerzero.config";

/**
 * Deploys the EmberVaultMintBurnOFTAdapter contract for bridging vault receipt tokens
 *
 * Required ENV variables:
 * - VAULT_KEY: Key of the vault in deployment file (e.g., "emberExusdcVault")
 *
 * Optional ENV variables:
 * - OFT_DELEGATE: Address that can manage OApp configurations (defaults to deployer)
 */
async function main() {
  const isEthVault = process.env.IS_ETH_VAULT === "true";
  console.log("\n🌉 Deploying EmberVaultMintBurnOFTAdapter...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  // Load existing deployment file
  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  let deploymentInfo: any = {
    network: networkName,
    chainId: network.chainId.toString(),
    contracts: {},
  };

  if (fs.existsSync(deploymentFileName)) {
    console.log("📂 Loading existing deployment file:", deploymentFileName);
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  } else {
    console.error("❌ Error: Deployment file not found!");
    console.log("Please deploy the vault first using: yarn deploy:vault");
    process.exit(1);
  }

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;

  // Get vault key from environment
  const vaultKey = process.env.VAULT_KEY;
  if (!vaultKey) {
    console.error("❌ Error: VAULT_KEY environment variable is required!");
    console.log("\nAvailable vaults:");
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name} (${vault.proxyAddress})`);
      });
    }
    process.exit(1);
  }

  // Get vault info from deployment
  const vaultInfo = vaults?.[vaultKey];
  if (!vaultInfo) {
    console.error(`❌ Error: Vault '${vaultKey}' not found in deployment file!`);
    console.log("\nAvailable vaults:");
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        console.log(`  - ${key}`);
      });
    }
    process.exit(1);
  }

  // The receipt token IS the vault itself (ERC4626 vault is the token)
  const receiptTokenAddress = vaultInfo.proxyAddress;
  const delegate = process.env.OFT_DELEGATE || deployer.address;

  // Get LayerZero endpoint for this network
  let lzEndpointAddress: string;
  try {
    const lzConfig = getLzEndpoint(networkName);
    lzEndpointAddress = lzConfig.endpointAddress;
    console.log("LayerZero Endpoint ID:", lzConfig.endpointId);
  } catch (e) {
    console.error(`❌ Error: LayerZero endpoint not configured for network '${networkName}'`);
    console.log("Please check config/layerzero.config.ts for supported networks");
    process.exit(1);
  }

  if (!lzEndpointAddress) {
    console.error(`❌ Error: LayerZero endpoint address is empty for network '${networkName}'`);
    process.exit(1);
  }

  console.log("\nOFT Adapter Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Receipt Token Symbol:", vaultInfo.receiptTokenSymbol);
  console.log("  Receipt Token Address:", receiptTokenAddress);
  console.log("  LayerZero Endpoint:", lzEndpointAddress);
  console.log("  Delegate:", delegate);
  console.log();

  // Get receipt token info
  const receiptToken = await ethers.getContractAt("IERC20Metadata", receiptTokenAddress);
  const tokenName = await receiptToken.name();
  const tokenSymbol = await receiptToken.symbol();
  const tokenDecimals = await receiptToken.decimals();

  console.log("Receipt Token Details:");
  console.log("  Name:", tokenName);
  console.log("  Symbol:", tokenSymbol);
  console.log("  Decimals:", tokenDecimals);
  console.log();

  // Deploy the OFT Adapter
  const contractName = "EmberVaultMintBurnOFTAdapter";
  const OFTAdapterFactory = await ethers.getContractFactory(contractName);

  console.log(`Deploying ${contractName}...`);
  const adapter = await OFTAdapterFactory.deploy(receiptTokenAddress, lzEndpointAddress, delegate);

  await adapter.waitForDeployment();

  const adapterAddress = await adapter.getAddress();
  console.log(`✅ ${contractName} deployed to:`, adapterAddress);

  // Get deployment block number
  const deploymentTx = adapter.deploymentTransaction();
  let deploymentBlockNumber = 0;
  if (deploymentTx) {
    const receipt = await deploymentTx.wait();
    deploymentBlockNumber = receipt?.blockNumber || 0;
    console.log("📦 Deployed in block:", deploymentBlockNumber);
  }

  // Verify adapter configuration
  const adapterContract = await ethers.getContractAt(
    "EmberVaultMintBurnOFTAdapter",
    adapterAddress
  );
  const adapterToken = await adapterContract.token();
  const adapterOwner = await adapterContract.owner();
  const decimalConversionRate = await adapterContract.decimalConversionRate();

  console.log("\n📊 Adapter Details:");
  console.log("  Token:", adapterToken);
  console.log("  Owner:", adapterOwner);
  console.log("  Decimal Conversion Rate:", decimalConversionRate.toString());
  console.log("  Shared Decimals: 6 (default)");

  // Initialize OFT adapters object if it doesn't exist
  if (!deploymentInfo.contracts.oftAdapters) {
    deploymentInfo.contracts.oftAdapters = {};
  }

  // Create adapter key from vault key
  const adapterKey = `${vaultKey}OFTAdapter`;

  // Save adapter deployment info
  deploymentInfo.contracts.oftAdapters[adapterKey] = {
    address: adapterAddress,
    contractName: contractName,
    vaultKey: vaultKey,
    vaultAddress: vaultInfo.proxyAddress,
    receiptTokenSymbol: vaultInfo.receiptTokenSymbol,
    lzEndpointAddress: lzEndpointAddress,
    delegate: delegate,
    owner: adapterOwner,
    decimalConversionRate: decimalConversionRate.toString(),
    deployedAt: new Date().toISOString(),
    deploymentBlockNumber: deploymentBlockNumber,
    peers: {}, // Will be populated when peers are configured
  };

  // Save deployment information
  fs.writeFileSync(deploymentFileName, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✅ Deployment info saved to", deploymentFileName);

  console.log("\n" + "=".repeat(70));
  console.log(`🎉 ${contractName} Deployment Complete!`);
  console.log("=".repeat(70));
  console.log("\nAdapter Key:", adapterKey);
  console.log("Adapter Address:", adapterAddress);
  console.log("Contract:", contractName);
  console.log("Vault:", vaultInfo.name);
  console.log("Receipt Token:", vaultInfo.receiptTokenSymbol);
  console.log("LayerZero Endpoint:", lzEndpointAddress);
  console.log("Delegate:", delegate);
  console.log("Deployment Block:", deploymentBlockNumber);
  console.log("\nAdapter Address (bytes32):", addressToBytes32(adapterAddress));

  console.log("\n💡 Next Steps:");
  console.log("1. ⚠️  IMPORTANT: Authorize the adapter on the vault:");
  console.log(
    `   VAULT_KEY=${vaultKey} ADAPTER_KEY=${adapterKey} yarn bridge:set-adapter --network ${networkName}`
  );
  console.log("   This allows the adapter to mint/burn receipt tokens for cross-chain transfers.");
  console.log("");
  console.log("2. Deploy OFT on destination chain (Sui)");
  console.log("3. Configure peer connections:");
  console.log(
    `   ADAPTER_KEY=${adapterKey} DST_ENDPOINT_ID=<SUI_EID> PEER_ADDRESS=<SUI_OFT> yarn bridge:set-peer`
  );
  console.log("4. Bridge tokens:");
  console.log(
    `   ADAPTER_KEY=${adapterKey} DST_ENDPOINT_ID=<SUI_EID> AMOUNT=<AMOUNT> RECIPIENT=<SUI_ADDR> yarn bridge:send`
  );
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
