import { ethers } from "hardhat";
import {
  addrEq,
  bad,
  c,
  dim,
  fmtAddr,
  isUpdateMode,
  loadDeployment,
  ok,
  saveDeployment,
  warn,
} from "./utils/verify-helpers";

/**
 * Updates the owner (and, for vaults, the admin) of any contract in the
 * deployment file — pick the contract with CONTRACT_TYPE.
 *
 * This is the *direct* transfer path: the configured signer (PRIVATE_KEY) must
 * be the current owner. If a contract is already owned by a Timelock, a direct
 * transfer is impossible — use the timelock generators instead:
 *   - yarn admin:gen-timelock-transfers        (ownership -> owner timelock)
 *   - yarn admin:gen-timelock-admin-transfers  (admin     -> admin timelock)
 *
 * Required ENV:
 *   CONTRACT_TYPE   vault | eth-vault | validator | protocol-config |
 *                   oft-adapter | custom
 *
 * Selecting the target:
 *   VAULT_KEY        key under contracts.vaults / contracts.ethVaults
 *                    (required for vault / eth-vault)
 *   ADAPTER_KEY      key under contracts.oftAdapters (required for oft-adapter)
 *   CONTRACT_ADDRESS explicit address (required for `custom`; optional override
 *                    for the singleton types)
 *
 * What to change (at least one required):
 *   NEW_OWNER        transfer ownership to this address (any type)
 *   NEW_ADMIN        set the vault admin to this address (vault / eth-vault only;
 *                    goes through protocolConfig.updateVaultAdmin, owner-gated)
 *
 * Execution mode:
 *   Dry-run is the DEFAULT — the script only simulates (static call) and writes
 *   nothing. Pass UPDATE=true (or WRITE=true) to actually send the transaction
 *   and update the deployment file. Use an env var, not a CLI flag — Hardhat
 *   rejects flags it doesn't recognise before the script runs.
 *
 * Usage:
 *   # dry-run (default): simulate only
 *   CONTRACT_TYPE=protocol-config NEW_OWNER=0x... yarn update:ownership --network mainnet
 *   # execute:
 *   UPDATE=true CONTRACT_TYPE=vault VAULT_KEY=emberUdl NEW_ADMIN=0x... yarn update:ownership --network base
 */

type TypeKey = "vault" | "eth-vault" | "validator" | "protocol-config" | "oft-adapter" | "custom";

interface TargetSpec {
  /** Hardhat artifact name to attach to (undefined => generic Ownable ABI). */
  contractName?: string;
  /** Resolved on-chain address. */
  address: string;
  /** The node in the deployment JSON to update (undefined => no file update). */
  fileNode?: Record<string, any>;
  /** Field name in the file holding the owner ("ownerAddress" or "owner"). */
  ownerField?: string;
  /** Whether this type has a separate `admin` role (vaults only). */
  supportsAdmin: boolean;
  /** Human label for logs. */
  label: string;
}

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

function fail(msg: string): never {
  console.error(bad(`\n❌ ${msg}`));
  process.exit(1);
}

function resolveTarget(type: TypeKey, deployment: any): TargetSpec {
  const contracts = deployment.contracts || {};
  const override = process.env.CONTRACT_ADDRESS?.trim();

  switch (type) {
    case "vault":
    case "eth-vault": {
      const group = type === "eth-vault" ? "ethVaults" : "vaults";
      const contractName = type === "eth-vault" ? "EmberETHVault" : "EmberVault";
      const map = contracts[group] || {};
      const key = process.env.VAULT_KEY?.trim();
      if (!key) {
        console.log(`\nAvailable ${group}:`);
        Object.keys(map).forEach((k) =>
          console.log(`  - ${k}: ${map[k].name} (${map[k].proxyAddress})`)
        );
        fail(`VAULT_KEY is required for CONTRACT_TYPE=${type}.`);
      }
      const node = map[key!];
      if (!node) fail(`Vault '${key}' not found under contracts.${group}.`);
      return {
        contractName,
        address: override || node.proxyAddress,
        fileNode: node,
        ownerField: "ownerAddress",
        supportsAdmin: true,
        label: `${group}.${key} (${node.name})`,
      };
    }
    case "validator": {
      const node = contracts.vaultValidator;
      if (!node?.proxyAddress && !override) fail("contracts.vaultValidator not found.");
      return {
        contractName: "EmberVaultValidator",
        address: override || node.proxyAddress,
        fileNode: node,
        ownerField: "ownerAddress",
        supportsAdmin: false,
        label: "vaultValidator",
      };
    }
    case "protocol-config": {
      const node = contracts.protocolConfig;
      if (!node?.proxyAddress && !override) fail("contracts.protocolConfig not found.");
      return {
        contractName: "EmberProtocolConfig",
        address: override || node.proxyAddress,
        fileNode: node,
        ownerField: "ownerAddress",
        supportsAdmin: false,
        label: "protocolConfig",
      };
    }
    case "oft-adapter": {
      const map = contracts.oftAdapters || {};
      const key = process.env.ADAPTER_KEY?.trim() || process.env.VAULT_KEY?.trim();
      if (!key && !override) {
        console.log(`\nAvailable oftAdapters:`);
        Object.keys(map).forEach((k) => console.log(`  - ${k} (${map[k].address})`));
        fail("ADAPTER_KEY is required for CONTRACT_TYPE=oft-adapter.");
      }
      const node = key ? map[key] : undefined;
      if (key && !node) fail(`OFT adapter '${key}' not found under contracts.oftAdapters.`);
      return {
        contractName: "EmberVaultMintBurnOFTAdapter",
        address: override || node!.address,
        fileNode: node,
        ownerField: "owner",
        supportsAdmin: false,
        label: `oftAdapters.${key}`,
      };
    }
    case "custom": {
      if (!override) fail("CONTRACT_ADDRESS is required for CONTRACT_TYPE=custom.");
      return {
        contractName: undefined, // generic Ownable
        address: override,
        fileNode: undefined, // unknown location => no file update
        ownerField: undefined,
        supportsAdmin: false,
        label: `custom (${override})`,
      };
    }
    default:
      fail(`Unknown CONTRACT_TYPE '${type}'.`);
  }
}

/** Transfers Ownable ownership directly (signer must be the current owner). */
async function transferOwner(
  target: TargetSpec,
  signerAddr: string,
  newOwner: string,
  dryRun: boolean
): Promise<boolean> {
  const ownable = target.contractName
    ? await ethers.getContractAt(target.contractName, target.address)
    : new ethers.Contract(target.address, OWNABLE_ABI, (await ethers.getSigners())[0]);

  const currentOwner: string = await ownable.owner();
  console.log(`\n${c.bold}Owner transfer${c.reset}`);
  console.log(`  Current owner: ${fmtAddr(currentOwner)}`);
  console.log(`  New owner:     ${fmtAddr(newOwner)}`);

  if (addrEq(currentOwner, newOwner)) {
    console.log(ok("  ✓ Already owned by the requested address — nothing to do."));
    return false;
  }
  if (!addrEq(currentOwner, signerAddr)) {
    console.log(bad(`  Signer ${fmtAddr(signerAddr)} is NOT the current owner.`));
    if (ethers.isAddress(currentOwner)) {
      console.log(
        dim(
          "  This contract is owned by another account (likely a Timelock).\n" +
            "  Use `yarn admin:gen-timelock-transfers` to produce the multisig/timelock tx instead."
        )
      );
    }
    fail("Cannot transfer ownership: signer is not the owner.");
  }

  // Simulate first for a clean revert reason.
  try {
    await ownable.transferOwnership.staticCall(newOwner);
  } catch (e: any) {
    fail(
      `transferOwnership simulation reverted: ${e?.shortMessage || e?.reason || e?.message || e}`
    );
  }

  if (dryRun) {
    console.log(warn("  [DRY_RUN] simulation succeeded; not sending."));
    return false;
  }

  const tx = await ownable.transferOwnership(newOwner);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt?.blockNumber}`);

  const updated: string = await ownable.owner();
  if (!addrEq(updated, newOwner)) {
    fail(`Verification failed — owner is ${updated}, expected ${newOwner}.`);
  }
  console.log(ok("  ✓ Ownership transferred."));
  return true;
}

/**
 * Sets a vault's admin via protocolConfig.updateVaultAdmin (owner-gated).
 * Mirrors the validation in scripts/update-vault-admin.ts.
 */
async function transferAdmin(
  target: TargetSpec,
  deployment: any,
  signerAddr: string,
  newAdmin: string,
  dryRun: boolean
): Promise<boolean> {
  const vault = await ethers.getContractAt(target.contractName!, target.address);
  const roles = await vault.roles();
  const vaultOwner: string = await vault.owner();
  const currentAdmin: string = roles.admin;

  console.log(`\n${c.bold}Admin update${c.reset}`);
  console.log(`  Vault owner:   ${fmtAddr(vaultOwner)}`);
  console.log(`  Current admin: ${fmtAddr(currentAdmin)}`);
  console.log(`  New admin:     ${fmtAddr(newAdmin)}`);

  if (addrEq(currentAdmin, newAdmin)) {
    console.log(ok("  ✓ Admin already set — nothing to do."));
    return false;
  }
  if (!addrEq(vaultOwner, signerAddr)) {
    console.log(bad(`  Signer ${fmtAddr(signerAddr)} is NOT the vault owner.`));
    console.log(dim("  Use `yarn admin:gen-timelock-admin-transfers` if the owner is a Timelock."));
    fail("Cannot update admin: signer is not the vault owner.");
  }

  // Same guards the dedicated admin script enforces.
  if (addrEq(newAdmin, roles.operator)) fail("New admin cannot be the current operator.");
  if (addrEq(newAdmin, roles.rateManager)) fail("New admin cannot be the current rate manager.");
  if (await vault.subAccounts(newAdmin)) fail("New admin cannot be a sub-account.");

  const protocolConfigAddress =
    (await vault.protocolConfig()) || deployment.contracts.protocolConfig?.proxyAddress;
  const protocolConfig = await ethers.getContractAt("EmberProtocolConfig", protocolConfigAddress);
  if (await protocolConfig.isAccountBlacklisted(newAdmin)) fail("New admin is blacklisted.");

  try {
    await protocolConfig.updateVaultAdmin.staticCall(target.address, newAdmin);
  } catch (e: any) {
    fail(
      `updateVaultAdmin simulation reverted: ${e?.shortMessage || e?.reason || e?.message || e}`
    );
  }

  if (dryRun) {
    console.log(warn("  [DRY_RUN] simulation succeeded; not sending."));
    return false;
  }

  const tx = await protocolConfig.updateVaultAdmin(target.address, newAdmin);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt?.blockNumber}`);

  const updated = await vault.roles();
  if (!addrEq(updated.admin, newAdmin)) {
    fail(`Verification failed — admin is ${updated.admin}, expected ${newAdmin}.`);
  }
  console.log(ok("  ✓ Admin updated."));
  return true;
}

async function main() {
  const type = process.env.CONTRACT_TYPE?.trim() as TypeKey | undefined;
  const newOwner = process.env.NEW_OWNER?.trim();
  const newAdmin = process.env.NEW_ADMIN?.trim();
  const dryRun = !isUpdateMode(); // dry-run by default; UPDATE=true / WRITE=true to execute

  if (!type) {
    fail(
      "CONTRACT_TYPE is required. One of: vault | eth-vault | validator | " +
        "protocol-config | oft-adapter | custom"
    );
  }
  if (!newOwner && !newAdmin) fail("Provide NEW_OWNER and/or NEW_ADMIN.");
  if (newOwner && !ethers.isAddress(newOwner)) fail(`Invalid NEW_OWNER: ${newOwner}`);
  if (newAdmin && !ethers.isAddress(newAdmin)) fail(`Invalid NEW_ADMIN: ${newAdmin}`);

  const { path: filePath, networkName, data } = loadDeployment();
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const target = resolveTarget(type!, data);

  console.log(`\n${c.bold}🔧 Update ownership / admin${c.reset}`);
  console.log(`  Network:  ${networkName} (chainId ${net.chainId})`);
  console.log(`  Signer:   ${fmtAddr(signer.address)}`);
  console.log(`  Type:     ${type}`);
  console.log(`  Target:   ${target.label}`);
  console.log(`  Address:  ${fmtAddr(target.address)}`);
  console.log(
    `  Mode:     ${dryRun ? warn("DRY-RUN (default — set UPDATE=true to execute)") : ok("EXECUTE")}`
  );

  if (newAdmin && !target.supportsAdmin) {
    fail(`CONTRACT_TYPE=${type} has no separate admin role; NEW_ADMIN is only valid for vaults.`);
  }

  let changed = false;

  if (newAdmin) {
    const did = await transferAdmin(target, data, signer.address, newAdmin, dryRun);
    if (did && target.fileNode) {
      target.fileNode.admin = fmtAddr(newAdmin);
      target.fileNode.adminUpdatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (newOwner) {
    const did = await transferOwner(target, signer.address, newOwner, dryRun);
    if (did && target.fileNode && target.ownerField) {
      target.fileNode[target.ownerField] = fmtAddr(newOwner);
      target.fileNode.ownerUpdatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    saveDeployment({ path: filePath, networkName, data });
    console.log(`\n  ${ok(`Deployment file updated: ${filePath}`)}`);
  } else if (!dryRun) {
    console.log(dim("\n  No file changes written (no state changed)."));
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
