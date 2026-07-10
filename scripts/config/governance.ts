/**
 * Expected governance / role configuration per network.
 *
 * This is the source of truth that the role checker (scripts/verify-roles.ts)
 * compares on-chain state against. Values are taken from the agreed governance
 * setup:
 *
 *   - Vault / contract `admin`  -> the chain's *admin* Timelock contract
 *   - Vault / contract `owner`  -> the chain's *owner* Timelock contract
 *   - `rateManager` (Rate Operator) -> the rate-operator multisig
 *   - `operator`                -> the ops signer that runs day-to-day operations
 *   - `guardian` (protocol cfg) -> the guardian KMS key
 *
 * The Timelock contract addresses themselves are read from each deployment
 * file's `contracts.timelocks` section (so a new chain works without edits
 * here). Where a chain's expected Timelock addresses are explicitly known they
 * are pinned in `expectedTimelocks` below and the checker asserts the
 * deployment file matches them — defence against a tampered deployment file.
 *
 * The proposer / executor / canceller signer set is shared across chains.
 */

// Shared signer set for the two Timelocks (same on every chain).
const ADMIN_TIMELOCK_PROPOSER = "0xE9F9f43F89e4C375DBEB845477b35DBE3ccBe4c6"; // multisig
const OWNER_TIMELOCK_PROPOSER = "0x203d4ceC733Dcda6eD87bd3b7aB6cb37149201C2"; // multisig
const TIMELOCK_EXECUTOR = "0xA2160f1dee338b921D13c9d02a7E2caDB02aF38f"; // KMS
const TIMELOCK_CANCELLER = "0x71aA7564fAE10A393F2Bf0efA9E6350d872f07f7"; // KMS

// Shared role holders (same on every chain).
const RATE_OPERATOR = "0x291C3315707A8Ebcd6a6D202cA639002eA4Ff01D"; // multisig
const OPERATOR = "0x71da2342b11AE27aF0a7E2507eCeF6CC89572738"; // ops signer
const GUARDIAN = "0x819dC332Ed395500a1fA4bC421876C367af1e03B"; // KMS

export interface TimelockRoleExpectation {
  proposer: string;
  executor: string;
  canceller: string;
}

export interface GovernanceExpectation {
  /** Rate Operator (the `rateManager` role on vaults). */
  rateOperator: string;
  /** Day-to-day ops signer (the `operator` role on vaults). */
  operator: string;
  /** Guardian on the protocol config. */
  guardian: string;
  /**
   * Optional pinned Timelock contract addresses. When set, the checker asserts
   * the deployment file's `timelocks.{admin,owner}.address` equal these. When
   * omitted the checker trusts (and uses) the deployment file's addresses.
   */
  expectedTimelocks?: {
    admin: string;
    owner: string;
  };
  /** Expected internal role holders for each Timelock. */
  timelocks: {
    admin: TimelockRoleExpectation;
    owner: TimelockRoleExpectation;
  };
}

const SHARED_TIMELOCK_ROLES: GovernanceExpectation["timelocks"] = {
  admin: {
    proposer: ADMIN_TIMELOCK_PROPOSER,
    executor: TIMELOCK_EXECUTOR,
    canceller: TIMELOCK_CANCELLER,
  },
  owner: {
    proposer: OWNER_TIMELOCK_PROPOSER,
    executor: TIMELOCK_EXECUTOR,
    canceller: TIMELOCK_CANCELLER,
  },
};

export const GOVERNANCE: Record<string, GovernanceExpectation> = {
  mainnet: {
    rateOperator: RATE_OPERATOR,
    operator: OPERATOR,
    guardian: GUARDIAN,
    expectedTimelocks: {
      admin: "0x3BCbDEE23B83a05464Cb8c9Bef63862aA282790c",
      owner: "0x12917E06b55995e7a5D73681cE491774C73b7C6a",
    },
    timelocks: SHARED_TIMELOCK_ROLES,
  },
  pharos: {
    rateOperator: RATE_OPERATOR,
    operator: OPERATOR,
    guardian: GUARDIAN,
    expectedTimelocks: {
      admin: "0x72526A6d64dd7340A4197B3138102d7eAff54DA4",
      owner: "0x13A3Ac6BDBAcf932aB6972E32EA253B25dD0d836",
    },
    timelocks: SHARED_TIMELOCK_ROLES,
  },
  // Base uses the same signer set; Timelock contract addresses are taken from
  // the deployment file (no explicit pin provided yet).
  base: {
    rateOperator: RATE_OPERATOR,
    operator: OPERATOR,
    guardian: GUARDIAN,
    timelocks: SHARED_TIMELOCK_ROLES,
  },
};
