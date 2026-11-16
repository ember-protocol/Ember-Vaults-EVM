import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Updates the vault's minWithdrawableShares (the smallest number of shares a
 * single withdrawal request is allowed to burn).
 *
 * On-chain path:
 *   EmberProtocolConfig.updateVaultMinWithdrawableShares(vault, newValue)
 *     -> IEmberVault(vault).setMinWithdrawableShares(msg.sender, newValue)
 *   which is onlyAdmin(caller). Signer here MUST therefore be the vault admin.
 *   If the vault's admin is a Timelock or a Safe, use the tx-bytes flow in
 *   ember-utils instead (yarn evm-update-vault-min-withdrawal-shares).
 *
 * Units:
 *   The value is in vault SHARE units — NOT wei and NOT deposit-asset units.
 *   Shares carry the collateral's decimals (EmberVault inherits OZ
 *   ERC4626Upgradeable and overrides neither decimals() nor _decimalsOffset()),
 *   so for a 6-decimal collateral 1000000 = 1 share.
 *   The contract rejects 0 (InvalidValue) and reverts on same-value (SameValue).
 *
 * Required ENV variables:
 *   VAULT_KEY                   - Key of the vault in deployment file (e.g. "emberUdl")
 *   NEW_MIN_WITHDRAWABLE_SHARES - New minWithdrawableShares, in share units
 *
 * Optional ENV variables:
 *   IS_ETH_VAULT                - "true" to target ethVaults instead of vaults
 */
async function main() {
  console.log("\n👤 Updating Vault Min Withdrawable Shares...\n");

  const isEthVault = process.env.IS_ETH_VAULT === "true";

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

  // Parameters
  const vaultKey = process.env.VAULT_KEY;
  const newMinWithdrawableShares = process.env.NEW_MIN_WITHDRAWABLE_SHARES;

  if (!vaultKey || !newMinWithdrawableShares) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("\nRequired variables:");
    console.log("  VAULT_KEY                   - Key of the vault in deployment file");
    console.log(
      "  NEW_MIN_WITHDRAWABLE_SHARES - New minWithdrawableShares in share units (e.g. 1000000)"
    );

    console.log("\nAvailable vaults:");
    const vaults = isEthVault
      ? deploymentInfo.contracts.ethVaults
      : deploymentInfo.contracts.vaults;
    if (vaults) {
      Object.keys(vaults).forEach((key) => {
        const vault = vaults[key];
        console.log(`  - ${key}: ${vault.name}`);
        console.log(`      Address: ${vault.proxyAddress}`);
        console.log(`      Current Admin: ${vault.admin}`);
      });
    }

    process.exit(1);
  }

  // Parse the share amount. Reject non-numeric input and zero (the contract
  // reverts with InvalidValue on 0, so catch it before spending gas).
  let newMinSharesBig: bigint;
  try {
    newMinSharesBig = BigInt(newMinWithdrawableShares);
  } catch {
    console.error(
      `❌ Error: NEW_MIN_WITHDRAWABLE_SHARES must be an integer in share units, got "${newMinWithdrawableShares}"`
    );
    process.exit(1);
  }
  if (newMinSharesBig <= 0n) {
    console.error(
      `❌ Error: NEW_MIN_WITHDRAWABLE_SHARES must be > 0 (contract reverts with InvalidValue on 0). Got ${newMinSharesBig.toString()}.`
    );
    process.exit(1);
  }

  const vaults = isEthVault ? deploymentInfo.contracts.ethVaults : deploymentInfo.contracts.vaults;
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

  const protocolConfigAddress = deploymentInfo.contracts.protocolConfig?.proxyAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: Protocol config not found in deployment file!");
    process.exit(1);
  }

  // Read current on-chain state through the vault-side view. minWithdrawableShares
  // is not recorded in the deployment file, so chain is the only source for it.
  const vaultContractName = isEthVault ? "EmberETHVault" : "EmberVault";
  const vault = await ethers.getContractAt(vaultContractName, vaultInfo.proxyAddress);
  const vaultRoles = await vault.roles();
  const currentAdmin = vaultRoles.admin;
  const vaultOwner = await vault.owner();
  const currentMinShares: bigint = await vault.minWithdrawableShares();

  // Shares carry the collateral's decimals, so render the raw uint in whole
  // shares as well — the raw value alone makes an off-by-a-decimal easy to miss.
  const shareDecimals = Number(await vault.decimals());
  const asShares = (v: bigint) => {
    const unit = 10n ** BigInt(shareDecimals);
    const whole = v / unit;
    const frac = (v % unit).toString().padStart(shareDecimals, "0").replace(/0+$/, "");
    return frac.length > 0 ? `${whole.toString()}.${frac} shares` : `${whole.toString()} shares`;
  };

  console.log("Configuration:");
  console.log("  Vault Key:", vaultKey);
  console.log("  Vault Name:", vaultInfo.name);
  console.log("  Vault Address:", vaultInfo.proxyAddress);
  console.log("  Protocol Config:", protocolConfigAddress);
  console.log("  Vault Owner:", vaultOwner);
  console.log("  Current Admin:", currentAdmin);
  console.log("  Current Operator:", vaultRoles.operator);
  console.log("  Current Rate Manager:", vaultRoles.rateManager);
  console.log("  Share Decimals:", shareDecimals.toString());
  console.log(
    "  Current Min Withdrawable Shares:",
    `${currentMinShares.toString()} (${asShares(currentMinShares)})`
  );
  console.log(
    "  New Min Withdrawable Shares:    ",
    `${newMinSharesBig.toString()} (${asShares(newMinSharesBig)})`
  );
  console.log(
    "  Signer matches Admin:  ",
    signer.address.toLowerCase() === currentAdmin.toLowerCase()
  );
  console.log();

  // Skip on same-value up-front so we don't spend gas on a guaranteed
  // SameValue revert.
  if (currentMinShares === newMinSharesBig) {
    console.log("✅ New minWithdrawableShares equals current. No action needed.");
    process.exit(0);
  }

  // Warn (not block) when the signer isn't the vault admin — the on-chain
  // check will still reject, but surfacing it here saves a failed tx.
  if (signer.address.toLowerCase() !== currentAdmin.toLowerCase()) {
    console.warn(
      `⚠️  Signer ${signer.address} is not the vault admin ${currentAdmin}. The tx will revert with Unauthorized(). If the admin is a Timelock/Safe, use scripts/evm/update-vault-min-withdrawal-shares-evm.ts in ember-utils to produce tx bytes for offline signing.`
    );
  }

  console.log("Updating vault minWithdrawableShares...");
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  const tx = await protocolConfig.updateVaultMinWithdrawableShares(
    vaultInfo.proxyAddress,
    newMinSharesBig
  );
  console.log("Transaction hash:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed in block:", receipt?.blockNumber);

  // Verify on-chain state
  const updated: bigint = await vault.minWithdrawableShares();
  if (updated === newMinSharesBig) {
    console.log("\n✅ Vault minWithdrawableShares updated successfully!");
    console.log("Updated Min Withdrawable Shares:", `${updated.toString()} (${asShares(updated)})`);
  } else {
    console.error("\n❌ Error: minWithdrawableShares verification failed!");
    console.log("Expected:", newMinSharesBig.toString());
    console.log("Got:     ", updated.toString());
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
