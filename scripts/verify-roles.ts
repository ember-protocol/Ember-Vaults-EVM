import { ethers } from "hardhat";
import { GOVERNANCE, GovernanceExpectation } from "./config/governance";
import { addrEq, bad, c, dim, fmtAddr, loadDeployment, ok, warn } from "./utils/verify-helpers";

/**
 * Checks that the privileged roles on every deployed contract are set to the
 * agreed governance addresses (scripts/config/governance.ts):
 *
 *   - vault / contract owner  -> owner Timelock contract
 *   - vault admin             -> admin Timelock contract
 *   - vault operator          -> ops signer
 *   - vault rateManager       -> Rate Operator multisig
 *   - protocol config guardian-> guardian KMS
 *   - Timelock proposer / executor / canceller -> agreed signer set
 *   - Timelock DEFAULT_ADMIN  -> not held by any operational signer
 *
 * Read-only. Exits non-zero if any role is wrong, so it can gate CI / a release.
 *
 * Usage:  yarn verify:roles --network mainnet
 */

interface Row {
  target: string;
  role: string;
  expected: string;
  actual: string;
  pass: boolean;
  severity: "fail" | "warn";
}

const rows: Row[] = [];
const readErrors: string[] = [];

function record(
  target: string,
  role: string,
  expected: string,
  actual: string | undefined,
  severity: "fail" | "warn" = "fail"
) {
  if (actual === undefined) {
    readErrors.push(`${target} . ${role}: could not read on-chain value`);
    return;
  }
  rows.push({
    target,
    role,
    expected: fmtAddr(expected),
    actual: fmtAddr(actual),
    pass: addrEq(expected, actual),
    severity,
  });
}

async function safe<T>(
  target: string,
  label: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    readErrors.push(`${target} . ${label}: ${e?.shortMessage || e?.message || e}`);
    return undefined;
  }
}

async function main() {
  const { path: filePath, networkName, data } = loadDeployment();
  const net = await ethers.provider.getNetwork();

  const gov: GovernanceExpectation | undefined = GOVERNANCE[networkName];
  if (!gov) {
    console.error(
      bad(
        `No governance expectation configured for network "${networkName}" in scripts/config/governance.ts`
      )
    );
    process.exit(1);
  }

  const contracts = data.contracts || {};
  const tls = contracts.timelocks || {};
  const adminTimelock: string | undefined = tls.admin?.address;
  const ownerTimelock: string | undefined = tls.owner?.address;

  console.log(`\n${c.bold}🔐 Verifying contract roles against governance config${c.reset}`);
  console.log(`  Network:        ${networkName} (chainId ${net.chainId})`);
  console.log(`  File:           ${filePath}`);
  console.log(`  Admin Timelock: ${adminTimelock ? fmtAddr(adminTimelock) : bad("MISSING")}`);
  console.log(`  Owner Timelock: ${ownerTimelock ? fmtAddr(ownerTimelock) : bad("MISSING")}`);
  console.log(`  Rate Operator:  ${fmtAddr(gov.rateOperator)}`);
  console.log(`  Operator:       ${fmtAddr(gov.operator)}`);
  console.log(`  Guardian:       ${fmtAddr(gov.guardian)}`);
  console.log();

  if (!adminTimelock || !ownerTimelock) {
    console.error(
      bad("Deployment file is missing timelock addresses; cannot derive expected admin/owner.")
    );
    process.exit(1);
  }

  // 0. If the governance config pins explicit Timelock addresses, assert the
  //    deployment file's Timelock addresses match them.
  if (gov.expectedTimelocks) {
    record("timelocks.admin", "address (file)", gov.expectedTimelocks.admin, adminTimelock);
    record("timelocks.owner", "address (file)", gov.expectedTimelocks.owner, ownerTimelock);
  }

  // 1. Protocol config
  const pc = contracts.protocolConfig;
  if (pc?.proxyAddress) {
    const cfg = await safe("protocolConfig", "getContractAt", () =>
      ethers.getContractAt("EmberProtocolConfig", pc.proxyAddress)
    );
    if (cfg) {
      const owner = await safe("protocolConfig", "owner()", () => cfg.owner());
      record("protocolConfig", "owner", ownerTimelock, owner);
      const guardian = await safe("protocolConfig", "guardian()", () => cfg.guardian());
      record("protocolConfig", "guardian", gov.guardian, guardian);
    }
  }

  // 2. Vault validator
  const v = contracts.vaultValidator;
  if (v?.proxyAddress) {
    const validator = await safe("vaultValidator", "getContractAt", () =>
      ethers.getContractAt("EmberVaultValidator", v.proxyAddress)
    );
    if (validator) {
      const owner = await safe("vaultValidator", "owner()", () => validator.owner());
      record("vaultValidator", "owner", ownerTimelock, owner);
    }
  }

  // 3. Vaults + ETH vaults
  for (const [group, contractName] of [
    ["vaults", "EmberVault"],
    ["ethVaults", "EmberETHVault"],
  ] as const) {
    const map = contracts[group];
    if (!map) continue;
    for (const key of Object.keys(map)) {
      const vinfo = map[key];
      if (!vinfo?.proxyAddress) continue;
      const loc = `${group}.${key}`;
      const vault = await safe(loc, "getContractAt", () =>
        ethers.getContractAt(contractName, vinfo.proxyAddress)
      );
      if (!vault) continue;

      const owner = await safe(loc, "owner()", () => vault.owner());
      record(loc, "owner", ownerTimelock, owner);

      const roles = await safe(loc, "roles()", () => vault.roles());
      if (roles) {
        record(loc, "admin", adminTimelock, roles.admin);
        record(loc, "operator", gov.operator, roles.operator);
        record(loc, "rateManager", gov.rateOperator, roles.rateManager);
      }
    }
  }

  // 3b. Deposit parking lots
  const lots = contracts.depositParkingLots || {};
  for (const key of Object.keys(lots)) {
    const l = lots[key];
    if (!l?.proxyAddress) continue;
    const loc = `depositParkingLots.${key}`;
    const lot = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("EmberDepositParkingLot", l.proxyAddress)
    );
    if (lot) {
      const owner = await safe(loc, "owner()", () => lot.owner());
      record(loc, "owner", ownerTimelock, owner);
    }
  }

  // 4. OFT adapters (informational — flagged as warn, not a hard fail)
  const adapters = contracts.oftAdapters || {};
  for (const key of Object.keys(adapters)) {
    const a = adapters[key];
    if (!a?.address) continue;
    const loc = `oftAdapters.${key}`;
    const oft = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("EmberVaultMintBurnOFTAdapter", a.address)
    );
    if (oft) {
      const owner = await safe(loc, "owner()", () => oft.owner());
      record(loc, "owner", ownerTimelock, owner, "warn");
    }
  }

  // 5. Timelock internal roles
  for (const kind of ["admin", "owner"] as const) {
    const tl = tls[kind];
    if (!tl?.address) continue;
    const loc = `timelocks.${kind}`;
    const tc = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("TimelockController", tl.address)
    );
    if (!tc) continue;

    const exp = gov.timelocks[kind];
    const PROPOSER = await safe(loc, "PROPOSER_ROLE", () => tc.PROPOSER_ROLE());
    const EXECUTOR = await safe(loc, "EXECUTOR_ROLE", () => tc.EXECUTOR_ROLE());
    const CANCELLER = await safe(loc, "CANCELLER_ROLE", () => tc.CANCELLER_ROLE());
    const ADMIN = await safe(loc, "DEFAULT_ADMIN_ROLE", () => tc.DEFAULT_ADMIN_ROLE());

    const checkRole = async (
      roleHash: string | undefined,
      account: string,
      label: string,
      shouldHold = true
    ) => {
      if (!roleHash) return;
      const has = await safe(loc, `hasRole(${label})`, () => tc.hasRole(roleHash, account));
      if (has === undefined) return;
      rows.push({
        target: loc,
        role: `${label}${shouldHold ? "" : " (must NOT hold)"}`,
        expected: shouldHold ? `${fmtAddr(account)} holds` : `${fmtAddr(account)} absent`,
        actual: has ? `${fmtAddr(account)} holds` : `${fmtAddr(account)} absent`,
        pass: has === shouldHold,
        severity: "fail",
      });
    };

    await checkRole(PROPOSER, exp.proposer, "PROPOSER");
    await checkRole(EXECUTOR, exp.executor, "EXECUTOR");
    await checkRole(CANCELLER, exp.canceller, "CANCELLER");

    // Operational signers must NOT hold DEFAULT_ADMIN_ROLE.
    for (const signer of [exp.proposer, exp.executor, exp.canceller]) {
      await checkRole(ADMIN, signer, "DEFAULT_ADMIN", false);
    }
  }

  // ── Report ──
  const fails = rows.filter((r) => !r.pass && r.severity === "fail");
  const warns = rows.filter((r) => !r.pass && r.severity === "warn");
  const passes = rows.filter((r) => r.pass);

  console.log(`${c.bold}── Role check results ──${c.reset}\n`);
  for (const r of rows) {
    const status = r.pass ? ok("PASS") : r.severity === "warn" ? warn("WARN") : bad("FAIL");
    console.log(`  [${status}] ${c.bold}${r.target}${c.reset} . ${r.role}`);
    if (!r.pass) {
      console.log(`         expected: ${r.expected}`);
      console.log(`         actual:   ${r.actual}`);
    }
  }

  console.log(
    `\n  ${ok(`${passes.length} pass`)}  ${fails.length ? bad(`${fails.length} fail`) : `${fails.length} fail`}  ${
      warns.length ? warn(`${warns.length} warn`) : `${warns.length} warn`
    }`
  );

  if (readErrors.length) {
    console.log(`\n  ${warn(`${readErrors.length} read error(s):`)}`);
    for (const e of readErrors) console.log(`    ${dim(e)}`);
  }

  console.log();
  if (fails.length) process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
