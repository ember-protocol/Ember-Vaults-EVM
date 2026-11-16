import { ethers } from "hardhat";
import { getImplementationAddressWithRetry } from "./utils/erc1967";
import { readLinkedLibraries } from "./utils/linked-libraries";
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
 * Verifies (and optionally updates) the on-chain-derived fields recorded in a
 * deployment file against the actual values read from the chain.
 *
 * Usage:
 *   yarn verify:deployment --network mainnet              # read-only, report drift
 *   UPDATE=true yarn verify:deployment --network mainnet  # rewrite drifted fields
 *
 * Note: pass UPDATE=true (or WRITE=true) as an env var, not a CLI flag —
 * Hardhat rejects flags it doesn't recognise before the script runs.
 *
 * Fields compared (where a getter exists):
 *   - proxies:        implementationAddress (ERC-1967 slot), version (version(), where exposed)
 *   - all contracts:  ownerAddress (owner())
 *   - vaults:         admin / operator / rateManager (roles()),
 *                     protocolConfig, validatorAddress, collateralToken, maxTVL
 *   - atomicLiquidityVaults:
 *                     admin / operator / rateManager, protocolConfig, validatorAddress,
 *                     collateralToken, maxTVL, strategyAddress, and the libraries linked into
 *                     the implementation (libraryAddress, vaultPlatformFeeLibAddress,
 *                     withdrawalQueueLibAddress)
 *   - depositParkingLots: vault, operator, protocolConfig
 *   - vaultValidator: protocolConfigAddress
 *   - protocolConfig: guardian (reported; not stored in file)
 *   - oftAdapters:    owner, vaultAddress (token()), peers
 *   - timelocks:      minDelay, proposer/executor/canceller role membership
 *
 * The proxy/contract addresses themselves (proxyAddress / address) are treated
 * as the identity of each entry and are never rewritten.
 */

interface Drift {
  location: string;
  field: string;
  fileValue: string;
  chainValue: string;
}

interface ReadError {
  location: string;
  detail: string;
}

const drifts: Drift[] = [];
const errors: ReadError[] = [];
let matched = 0;
const update = isUpdateMode();

/**
 * Compares one file field against its on-chain value. Records drift, and in
 * update mode writes the chain value back into the (file) object.
 */
function check(
  obj: Record<string, any>,
  field: string,
  chainValue: string | bigint | undefined,
  location: string,
  opts: { address?: boolean } = {}
): void {
  if (chainValue === undefined || chainValue === null) return;
  const fileRaw = obj[field];
  const chainStr = typeof chainValue === "bigint" ? chainValue.toString() : String(chainValue);

  // If the file has no such field, only populate it in update mode.
  const hasField = fileRaw !== undefined && fileRaw !== null;

  const equal = opts.address ? addrEq(fileRaw, chainStr) : hasField && String(fileRaw) === chainStr;

  if (hasField && equal) {
    matched++;
    return;
  }

  if (!hasField) {
    // Missing in file. Report as drift only when we have a meaningful value.
    drifts.push({
      location,
      field,
      fileValue: dim("(missing)"),
      chainValue: opts.address ? fmtAddr(chainStr) : chainStr,
    });
  } else {
    drifts.push({
      location,
      field,
      fileValue: opts.address ? fmtAddr(fileRaw) : String(fileRaw),
      chainValue: opts.address ? fmtAddr(chainStr) : chainStr,
    });
  }

  if (update) {
    obj[field] = opts.address ? fmtAddr(chainStr) : chainStr;
  }
}

async function safe<T>(
  location: string,
  label: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    errors.push({ location, detail: `${label}: ${e?.shortMessage || e?.message || e}` });
    return undefined;
  }
}

/**
 * Checks a proxy's implementation (ERC-1967 slot) and `version()`. Returns the implementation
 * address so callers can inspect its bytecode.
 */
async function checkProxy(
  obj: any,
  proxyAddress: string,
  location: string
): Promise<string | undefined> {
  const impl = await safe(location, "implementation", () =>
    getImplementationAddressWithRetry(proxyAddress, 4, 1500)
  );
  if (impl) check(obj, "implementationAddress", impl, location, { address: true });

  // Not every deployed version exposes version() (the first parking lots predate it), so a
  // revert here means "nothing to compare", not a read error.
  const versioned = new ethers.Contract(
    proxyAddress,
    ["function version() view returns (string)"],
    ethers.provider
  );
  const version = await versioned.version().catch(() => undefined);
  if (version) check(obj, "version", version, location);
  return impl;
}

async function verifyProtocolConfig(contracts: any) {
  const pc = contracts.protocolConfig;
  if (!pc?.proxyAddress) return;
  const loc = "protocolConfig";
  await checkProxy(pc, pc.proxyAddress, loc);
  const cfg = await safe(loc, "getContractAt", () =>
    ethers.getContractAt("EmberProtocolConfig", pc.proxyAddress)
  );
  if (!cfg) return;
  const owner = await safe(loc, "owner()", () => cfg.owner());
  check(pc, "ownerAddress", owner, loc, { address: true });
  const guardian = await safe(loc, "guardian()", () => cfg.guardian());
  if (guardian !== undefined) {
    // Not stored in the file; surface it for visibility.
    console.log(`  ${dim("protocolConfig.guardian (chain):")} ${fmtAddr(guardian)}`);
  }
}

async function verifyValidator(contracts: any) {
  const v = contracts.vaultValidator;
  if (!v?.proxyAddress) return;
  const loc = "vaultValidator";
  await checkProxy(v, v.proxyAddress, loc);
  const validator = await safe(loc, "getContractAt", () =>
    ethers.getContractAt("EmberVaultValidator", v.proxyAddress)
  );
  if (!validator) return;
  const owner = await safe(loc, "owner()", () => validator.owner());
  check(v, "ownerAddress", owner, loc, { address: true });
  const pc = await safe(loc, "protocolConfig()", () => validator.protocolConfig());
  check(v, "protocolConfigAddress", pc, loc, { address: true });
}

async function verifyVaults(vaultsMap: any, group: "vaults" | "ethVaults") {
  if (!vaultsMap) return;
  const contractName = group === "ethVaults" ? "EmberETHVault" : "EmberVault";
  for (const key of Object.keys(vaultsMap)) {
    const vinfo = vaultsMap[key];
    if (!vinfo?.proxyAddress) continue;
    const loc = `${group}.${key}`;
    await checkProxy(vinfo, vinfo.proxyAddress, loc);

    const vault = await safe(loc, "getContractAt", () =>
      ethers.getContractAt(contractName, vinfo.proxyAddress)
    );
    if (!vault) continue;

    const owner = await safe(loc, "owner()", () => vault.owner());
    check(vinfo, "ownerAddress", owner, loc, { address: true });

    const roles = await safe(loc, "roles()", () => vault.roles());
    if (roles) {
      check(vinfo, "admin", roles.admin, loc, { address: true });
      check(vinfo, "operator", roles.operator, loc, { address: true });
      check(vinfo, "rateManager", roles.rateManager, loc, { address: true });
    }

    const pc = await safe(loc, "protocolConfig()", () => vault.protocolConfig());
    check(vinfo, "protocolConfig", pc, loc, { address: true });

    const validator = await safe(loc, "vaultValidator()", () => vault.vaultValidator());
    if (validator && validator !== ethers.ZeroAddress) {
      check(vinfo, "validatorAddress", validator, loc, { address: true });
    }

    const asset = await safe(loc, "asset()", () => vault.asset());
    check(vinfo, "collateralToken", asset, loc, { address: true });

    const maxTVL = await safe(loc, "maxTVL()", () => vault.maxTVL());
    check(vinfo, "maxTVL", maxTVL, loc);
  }
}

/** Deployment-file field for each library linked into an AtomicLiquidity implementation. */
const ATOMIC_LIQUIDITY_LIB_FIELDS: Record<string, string> = {
  AtomicLiquidityLib: "libraryAddress",
  VaultPlatformFeeLib: "vaultPlatformFeeLibAddress",
  WithdrawalQueueLib: "withdrawalQueueLibAddress",
};

async function verifyAtomicLiquidityVaults(map: any) {
  if (!map) return;
  for (const key of Object.keys(map)) {
    const info = map[key];
    if (!info?.proxyAddress) continue;
    const loc = `atomicLiquidityVaults.${key}`;
    const impl = await checkProxy(info, info.proxyAddress, loc);

    const vault = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("AtomicLiquidity", info.proxyAddress)
    );
    if (!vault) continue;

    const owner = await safe(loc, "owner()", () => vault.owner());
    check(info, "ownerAddress", owner, loc, { address: true });

    const roles = await safe(loc, "roles()", () => vault.roles());
    if (roles) {
      check(info, "admin", roles.admin, loc, { address: true });
      check(info, "operator", roles.operator, loc, { address: true });
      check(info, "rateManager", roles.rateManager, loc, { address: true });
    }

    const pc = await safe(loc, "protocolConfig()", () => vault.protocolConfig());
    check(info, "protocolConfig", pc, loc, { address: true });

    const validator = await safe(loc, "vaultValidator()", () => vault.vaultValidator());
    if (validator && validator !== ethers.ZeroAddress) {
      check(info, "validatorAddress", validator, loc, { address: true });
    }

    const collateral = await safe(loc, "collateralToken()", () => vault.collateralToken());
    check(info, "collateralToken", collateral, loc, { address: true });

    const maxTVL = await safe(loc, "maxTVL()", () => vault.maxTVL());
    check(info, "maxTVL", maxTVL, loc);

    const strategy = await safe(loc, "strategy()", () => vault.strategy());
    check(info, "strategyAddress", strategy, loc, { address: true });

    // The implementation is linked to its libraries at deploy time, so the library fields
    // describe the implementation, not the proxy. Read them from its bytecode.
    if (impl) {
      const linked = await readLinkedLibraries("AtomicLiquidity", impl);
      if (!linked) {
        errors.push({
          location: loc,
          detail:
            "linked libraries: implementation bytecode does not match this build's link references",
        });
      } else {
        for (const [library, field] of Object.entries(ATOMIC_LIQUIDITY_LIB_FIELDS)) {
          check(info, field, linked[library], loc, { address: true });
        }
      }
    }
  }
}

async function verifyDepositParkingLots(map: any) {
  if (!map) return;
  for (const key of Object.keys(map)) {
    const info = map[key];
    if (!info?.proxyAddress) continue;
    const loc = `depositParkingLots.${key}`;
    await checkProxy(info, info.proxyAddress, loc);

    const lot = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("EmberDepositParkingLot", info.proxyAddress)
    );
    if (!lot) continue;

    const owner = await safe(loc, "owner()", () => lot.owner());
    check(info, "ownerAddress", owner, loc, { address: true });

    const vault = await safe(loc, "vault()", () => lot.vault());
    check(info, "vault", vault, loc, { address: true });

    const operator = await safe(loc, "operator()", () => lot.operator());
    check(info, "operator", operator, loc, { address: true });

    const pc = await safe(loc, "protocolConfig()", () => lot.protocolConfig());
    check(info, "protocolConfig", pc, loc, { address: true });
  }
}

async function verifyOftAdapters(contracts: any) {
  const adapters = contracts.oftAdapters;
  if (!adapters) return;
  for (const key of Object.keys(adapters)) {
    const a = adapters[key];
    if (!a?.address) continue;
    const loc = `oftAdapters.${key}`;
    const oft = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("EmberVaultMintBurnOFTAdapter", a.address)
    );
    if (!oft) continue;
    const owner = await safe(loc, "owner()", () => oft.owner());
    check(a, "owner", owner, loc, { address: true });
    const token = await safe(loc, "token()", () => oft.token());
    check(a, "vaultAddress", token, loc, { address: true });

    // Peers: compare configured bytes32 per eid.
    if (a.peers) {
      for (const eid of Object.keys(a.peers)) {
        const peer = await safe(loc, `peers(${eid})`, () => oft.peers(eid));
        if (peer !== undefined) {
          const peerEntry = a.peers[eid];
          if (
            peerEntry?.peerAddress &&
            peer.toLowerCase() !== peerEntry.peerAddress.toLowerCase()
          ) {
            drifts.push({
              location: `${loc}.peers.${eid}`,
              field: "peerAddress",
              fileValue: peerEntry.peerAddress,
              chainValue: peer,
            });
            if (update) peerEntry.peerAddress = peer;
          } else if (peerEntry?.peerAddress) {
            matched++;
          }
        }
      }
    }
  }
}

const TL_ROLES = ["proposers", "executors", "cancellers"] as const;
const TL_ROLE_GETTER: Record<(typeof TL_ROLES)[number], string> = {
  proposers: "PROPOSER_ROLE",
  executors: "EXECUTOR_ROLE",
  cancellers: "CANCELLER_ROLE",
};

async function verifyTimelocks(contracts: any) {
  const tls = contracts.timelocks;
  if (!tls) return;
  for (const kind of Object.keys(tls)) {
    const tl = tls[kind];
    if (!tl?.address) continue;
    const loc = `timelocks.${kind}`;
    const tc = await safe(loc, "getContractAt", () =>
      ethers.getContractAt("TimelockController", tl.address)
    );
    if (!tc) continue;

    const minDelay = await safe(loc, "getMinDelay()", () => tc.getMinDelay());
    check(tl, "minDelay", minDelay, loc);

    // Verify each recorded role holder actually holds the on-chain role.
    for (const arrKey of TL_ROLES) {
      const listed: string[] = tl[arrKey] || [];
      const roleHash = await safe(
        loc,
        TL_ROLE_GETTER[arrKey],
        () => (tc as any)[TL_ROLE_GETTER[arrKey]]() as Promise<string>
      );
      if (!roleHash) continue;
      for (const addr of listed) {
        const has = await safe(loc, `hasRole(${arrKey})`, () => tc.hasRole(roleHash, addr));
        if (has === undefined) continue;
        if (!has) {
          drifts.push({
            location: `${loc}.${arrKey}`,
            field: fmtAddr(addr),
            fileValue: "listed in file",
            chainValue: bad("does NOT hold role on-chain"),
          });
        } else {
          matched++;
        }
      }
    }
  }
}

async function main() {
  const { path: filePath, networkName, data } = loadDeployment();
  const net = await ethers.provider.getNetwork();

  console.log(`\n${c.bold}🔎 Verifying deployment file against chain${c.reset}`);
  console.log(`  Network:   ${networkName} (chainId ${net.chainId})`);
  console.log(`  File:      ${filePath}`);
  console.log(`  Mode:      ${update ? warn("UPDATE (file will be rewritten)") : "read-only"}`);

  // Sanity: chainId in file should match the connected chain.
  if (data.chainId && data.chainId.toString() !== net.chainId.toString()) {
    console.log(
      bad(
        `\n❌ chainId mismatch: file says ${data.chainId}, connected chain is ${net.chainId}. Aborting.`
      )
    );
    process.exit(1);
  }
  console.log();

  const contracts = data.contracts || {};
  await verifyProtocolConfig(contracts);
  await verifyValidator(contracts);
  await verifyVaults(contracts.vaults, "vaults");
  await verifyVaults(contracts.ethVaults, "ethVaults");
  await verifyAtomicLiquidityVaults(contracts.atomicLiquidityVaults);
  await verifyDepositParkingLots(contracts.depositParkingLots);
  await verifyOftAdapters(contracts);
  await verifyTimelocks(contracts);

  // Report
  console.log(`\n${c.bold}── Results ──${c.reset}`);
  console.log(`  ${ok(`${matched} field(s) match chain`)}`);

  if (drifts.length) {
    console.log(`\n  ${bad(`${drifts.length} field(s) drifted:`)}`);
    for (const d of drifts) {
      console.log(`    ${c.bold}${d.location}${c.reset} . ${d.field}`);
      console.log(`        file:  ${d.fileValue}`);
      console.log(`        chain: ${d.chainValue}`);
    }
  } else {
    console.log(`  ${ok("No drift detected.")}`);
  }

  if (errors.length) {
    console.log(`\n  ${warn(`${errors.length} read error(s) (could not verify):`)}`);
    for (const e of errors) {
      console.log(`    ${dim(`${e.location}: ${e.detail}`)}`);
    }
  }

  if (update && drifts.length) {
    saveDeployment({ path: filePath, networkName, data });
    console.log(`\n  ${warn(`✍️  Updated ${drifts.length} field(s) and wrote ${filePath}`)}`);
  } else if (!update && drifts.length) {
    console.log(`\n  ${dim("Re-run with --update to write chain values into the file.")}`);
  }

  console.log();
  // Non-zero exit on drift in read-only mode so CI can gate on it.
  if (!update && drifts.length) process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
