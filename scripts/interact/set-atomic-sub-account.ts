import { ethers } from "hardhat";
import * as fs from "fs";

/**
 * Adds or removes sub-accounts on an AtomicLiquidity vault.
 *
 * Sub-accounts are the only addresses `supplyToSubAccount` will send collateral
 * to — it reverts `InvalidValue()` for anything else, which is indistinguishable
 * from a dozen other causes once it reaches an RPC as a bare
 * `execution reverted (unknown custom error)`. A vault initialized with an empty
 * sub-account list stays that way until someone calls this, so the first supply
 * on a new vault fails unless registration happened first.
 *
 * Required ENV variables:
 * - VAULT_KEY: key under contracts.atomicLiquidityVaults in the deployment file
 * - ACCOUNTS:  address, or comma-separated addresses, to add or remove
 * - STATUS:    true to add, false to remove
 *
 * Usage:
 *   VAULT_KEY=<key> ACCOUNTS=0x… STATUS=true \
 *     yarn interact:set-atomic-sub-account --network <NETWORK>
 *
 * Notes:
 * - The signer must be the vault ADMIN, not the operator. The operator is the
 *   one who later calls `supplyToSubAccount`, which is an easy mix-up: the
 *   admin is checked against the live `roles().admin` before anything is sent.
 * - Calls route through the vault's OWN `protocolConfig`, not the network
 *   default. `setSubAccountStatus` is `onlyProtocolConfig` and compares against
 *   the address the vault itself stores; atomic vaults are deployed separately
 *   and can point at a different config than the classic vaults on the same
 *   network, in which case the network default would revert.
 * - Every rule `EmberProtocolConfig.setVaultSubAccount` enforces is checked
 *   first — already-set (SameValue), the three role addresses (InvalidValue),
 *   and the protocol blacklist (Blacklisted) — so a misconfigured run reports
 *   which rule it broke instead of an opaque custom error.
 * - Addresses already in the requested state are skipped, so the script is
 *   re-runnable over a list where only some entries are new.
 */

type VaultRecord = {
  proxyAddress?: string;
  name?: string;
  admin?: string;
  operator?: string;
  protocolConfig?: string;
  [key: string]: unknown;
};

async function main() {
  console.log("\n👥 Setting Atomic Vault Sub-Accounts...\n");

  const vaultKey = process.env.VAULT_KEY;
  const accountsRaw = process.env.ACCOUNTS;
  const statusRaw = process.env.STATUS;

  if (!vaultKey || !accountsRaw || statusRaw === undefined) {
    console.error("❌ Error: Missing required environment variables!");
    console.log("Required:");
    console.log("  VAULT_KEY  - key under contracts.atomicLiquidityVaults");
    console.log("  ACCOUNTS   - address or comma-separated addresses");
    console.log("  STATUS     - true (add) | false (remove)");
    process.exit(1);
  }

  const normalizedStatus = statusRaw.trim().toLowerCase();
  if (normalizedStatus !== "true" && normalizedStatus !== "false") {
    console.error(`❌ Error: STATUS must be 'true' or 'false', got '${statusRaw}'`);
    process.exit(1);
  }
  const targetStatus = normalizedStatus === "true";

  const accounts = accountsRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (accounts.length === 0) {
    console.error("❌ Error: ACCOUNTS is empty");
    process.exit(1);
  }

  for (const account of accounts) {
    if (!ethers.isAddress(account)) {
      console.error(`❌ Error: '${account}' is not a valid address`);
      process.exit(1);
    }
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    console.error("❌ Error: No signer configured for this network.");
    console.log("Set the deployer/admin private key for the target network before running.");
    process.exit(1);
  }

  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer:", signer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(signer.address)),
    "ETH\n"
  );

  const deploymentFileName = `./deployments/${networkName}-deployment.json`;
  if (!fs.existsSync(deploymentFileName)) {
    console.error("❌ Error: Deployment file not found:", deploymentFileName);
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFileName, "utf8"));
  const atomicVaults = deploymentInfo.contracts?.atomicLiquidityVaults as
    Record<string, VaultRecord> | undefined;

  if (!atomicVaults || Object.keys(atomicVaults).length === 0) {
    console.error("❌ Error: No atomicLiquidityVaults found in deployment file!");
    process.exit(1);
  }

  const vaultInfo = atomicVaults[vaultKey];
  if (!vaultInfo?.proxyAddress) {
    console.error(`❌ Error: Vault '${vaultKey}' not found or missing proxy address`);
    console.log("Available atomic vaults:");
    Object.keys(atomicVaults).forEach((key) => console.log(`  - ${key}`));
    process.exit(1);
  }

  // onlyProtocolConfig compares against the config the vault stores, so the
  // vault's own entry wins over the network default.
  const defaultProtocolConfigAddress = deploymentInfo.contracts?.protocolConfig?.proxyAddress;
  const protocolConfigAddress = vaultInfo.protocolConfig || defaultProtocolConfigAddress;
  if (!protocolConfigAddress) {
    console.error("❌ Error: No protocol config recorded for this vault or network");
    process.exit(1);
  }
  if (
    defaultProtocolConfigAddress &&
    protocolConfigAddress.toLowerCase() !== defaultProtocolConfigAddress.toLowerCase()
  ) {
    console.log(
      `⚠️  Vault stores protocol config ${protocolConfigAddress}, which differs from the network default ${defaultProtocolConfigAddress}. Routing through the vault's own.`
    );
  }

  const vault = await ethers.getContractAt("AtomicLiquidity", vaultInfo.proxyAddress);
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);

  const roles = await vault.roles();

  console.log("Vault Key:", vaultKey);
  console.log("Vault Name:", vaultInfo.name || "Unknown");
  console.log("Vault Address:", vaultInfo.proxyAddress);
  console.log("Protocol Config:", protocolConfigAddress);
  console.log("Vault Admin:", roles.admin);
  console.log("Vault Operator:", roles.operator);
  console.log("Vault Rate Manager:", roles.rateManager);
  console.log("Action:", targetStatus ? "ADD sub-account(s)" : "REMOVE sub-account(s)");
  console.log("Accounts:", accounts.join(", "), "\n");

  if (signer.address.toLowerCase() !== roles.admin.toLowerCase()) {
    console.error(`❌ Error: Signer (${signer.address}) is not the vault admin (${roles.admin}).`);
    console.log(
      "Only the admin can change sub-accounts. The operator signs supplyToSubAccount, not this."
    );
    process.exit(1);
  }

  const results: Array<{
    account: string;
    status: "updated" | "skipped" | "failed";
    detail: string;
  }> = [];

  for (const account of accounts) {
    const checksummed = ethers.getAddress(account);
    console.log("-".repeat(70));
    console.log(`🛠️  ${checksummed}`);

    try {
      const currentStatus: boolean = await vault.subAccounts(checksummed);
      console.log("   Current:", currentStatus, "-> Target:", targetStatus);

      if (currentStatus === targetStatus) {
        console.log("   ✅ Already in the requested state. Skipping.");
        results.push({ account: checksummed, status: "skipped", detail: "already set" });
        continue;
      }

      // Mirror EmberProtocolConfig.setVaultSubAccount's own rules so a bad
      // input is named here rather than surfacing as a bare custom error.
      if (targetStatus) {
        if (checksummed === ethers.ZeroAddress) {
          throw new Error("zero address cannot be a sub-account (ZeroAddress)");
        }
        for (const [label, roleAddress] of [
          ["admin", roles.admin],
          ["operator", roles.operator],
          ["rate manager", roles.rateManager],
        ] as const) {
          if (checksummed.toLowerCase() === roleAddress.toLowerCase()) {
            throw new Error(
              `address is the vault ${label}; roles cannot be sub-accounts (InvalidValue)`
            );
          }
        }
        if (await protocolConfig.isAccountBlacklisted(checksummed)) {
          throw new Error("address is blacklisted by the protocol config (Blacklisted)");
        }
      }

      const tx = await protocolConfig.setVaultSubAccount(
        vaultInfo.proxyAddress,
        checksummed,
        targetStatus
      );
      console.log("   Transaction hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("   Confirmed in block:", receipt?.blockNumber);

      // Some RPCs lag in reflecting a just-mined tx, so re-read until the
      // change is visible rather than reporting a false failure.
      let updated: boolean = await vault.subAccounts(checksummed);
      for (let attempt = 1; attempt < 15 && updated !== targetStatus; attempt++) {
        console.log(`   ⏳ sub-account read not reflected yet, re-checking (${attempt}/15)...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        updated = await vault.subAccounts(checksummed);
      }
      if (updated !== targetStatus) {
        throw new Error(`verification failed: expected ${targetStatus} but read ${updated}`);
      }

      console.log("   ✅ Sub-account updated.");
      results.push({ account: checksummed, status: "updated", detail: tx.hash });
    } catch (error: any) {
      const message = error.shortMessage ?? error.message;
      console.error(`   ❌ Failed: ${message}`);
      results.push({ account: checksummed, status: "failed", detail: message });
    }
  }

  const updated = results.filter((result) => result.status === "updated");
  const skipped = results.filter((result) => result.status === "skipped");
  const failed = results.filter((result) => result.status === "failed");

  console.log("\n" + "=".repeat(70));
  console.log("📊 SUB-ACCOUNT UPDATE SUMMARY");
  console.log("=".repeat(70));
  console.log(`\n✅ Updated: ${updated.length}`);
  console.log(`⏭️  Skipped: ${skipped.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  for (const result of [...updated, ...skipped, ...failed]) {
    console.log(`  - ${result.account} -> ${result.status} (${result.detail})`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
