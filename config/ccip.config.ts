/**
 * Chainlink CCIP per-network configuration.
 *
 * Addresses come from https://docs.chain.link/ccip/directory and every one of them has been
 * checked on-chain with `yarn ccip:verify-config` (each self-identifies via typeAndVersion).
 * Re-run that script after any CCIP upgrade rather than trusting this file — ramps in
 * particular are resolved from the Router at runtime and deliberately not hardcoded here.
 *
 * Chain selectors are CCIP's own chain ids and are NOT EVM chain ids. They come from
 * smartcontractkit/chain-selectors (also surfaced by @chainlink/ccip-sdk).
 */

export type CcipNetworkConfig = {
  /** Hardhat network name, matching hardhat.config.ts. */
  network: string;
  /** EVM chain id. */
  chainId: number;
  /** CCIP chain selector — used for every lane-scoped call. */
  chainSelector: bigint;
  router: string;
  /** RMN proxy, called ARMProxy on-chain. */
  rmnProxy: string;
  tokenAdminRegistry: string;
  /** RegistryModuleOwnerCustom — the contract that proposes a token admin. */
  registryModule: string;
  /** Human label for logs. */
  label: string;
  /** Env var holding this chain's RPC URL. Single source of truth for the standalone scripts. */
  rpcEnv: string;
};

export const CCIP_NETWORKS: Record<string, CcipNetworkConfig> = {
  sepolia: {
    network: "sepolia",
    rpcEnv: "SEPOLIA_RPC_URL",
    label: "Ethereum Sepolia",
    chainId: 11155111,
    chainSelector: 16015286601757825753n,
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    rmnProxy: "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991",
    tokenAdminRegistry: "0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82",
    registryModule: "0xa3c796d480638d7476792230da1E2ADa86e031b0",
  },
  atlantic: {
    network: "atlantic",
    rpcEnv: "PHAROS_TESTNET_RPC_URL",
    label: "Pharos Atlantic Testnet",
    chainId: 688689,
    chainSelector: 16098325658947243212n,
    router: "0x1E202D00714bFBcD7a5b4CF782791C38DA8BdC99",
    rmnProxy: "0xB45B9eb94F25683B47e5AFb0f74A05a58be86311",
    tokenAdminRegistry: "0xAd1652471967E7FBf524245782A7f4430F6a4243",
    registryModule: "0x5370103629Fe91F28708ec4DC1A7A70DC5396EBf",
  },
  mantle_sepolia: {
    network: "mantle_sepolia",
    rpcEnv: "MANTLE_TESTNET_RPC_URL",
    label: "Mantle Sepolia",
    chainId: 5003,
    chainSelector: 8236463271206331221n,
    router: "0xFd33fd627017fEf041445FC19a2B6521C9778f86",
    rmnProxy: "0xcCB84Ec3F6AFdD2052134f74aaAc95Ae41A7B333",
    tokenAdminRegistry: "0x0F1eE88A582f31d92510E300fc1330AA5a525D51",
    registryModule: "0xf76cE612250eeEb8889F49FBCB11f1c2705305F6",
  },
  mainnet: {
    network: "mainnet",
    rpcEnv: "MAINNET_RPC_URL",
    label: "Ethereum",
    chainId: 1,
    chainSelector: 5009297550715157269n,
    router: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D",
    rmnProxy: "0x411dE17f12D1A34ecC7F45f49844626267c75e81",
    tokenAdminRegistry: "0xb22764f98dD05c789929716D677382Df22C05Cb6",
    registryModule: "0x4855174E9479E211337832E109E7721d43A4CA64",
  },
  pharos: {
    network: "pharos",
    rpcEnv: "PHAROS_RPC_URL",
    label: "Pharos",
    chainId: 1672,
    chainSelector: 7801139999541420232n,
    router: "0x4e52dD94e9BCfeFE3C78153bDfB0AB1d30687297",
    rmnProxy: "0xF4486d70EBED800204898Ec99C812661551471dC",
    tokenAdminRegistry: "0xB79791184973589c38e114D43Eb8E4588C283A18",
    registryModule: "0xE27dd9BF01B55ce6803c0d81386A04212c718b95",
  },
};

/**
 * Lanes that exist in the Ember topology, per network.
 *
 * A list rather than a single value: Sepolia is a hub with two spokes, so there is no unambiguous
 * default and the scripts require REMOTE_NETWORK there. Only add a pair here after proving the
 * lane on-chain with `yarn ccip:verify-config` — a chain selector existing in
 * smartcontractkit/chain-selectors does not mean CCIP has deployed ramps for that route.
 */
export const LANE_PARTNERS: Record<string, string[]> = {
  sepolia: ["atlantic", "mantle_sepolia"],
  atlantic: ["sepolia"],
  mantle_sepolia: ["sepolia"],
  mainnet: ["pharos"],
  pharos: ["mainnet"],
};

/** Every network that has at least one configured lane. */
export function getLanePartners(network: string): string[] {
  return LANE_PARTNERS[network] ?? [];
}

export function getCcipConfig(network: string): CcipNetworkConfig {
  const cfg = CCIP_NETWORKS[network];
  if (!cfg) {
    throw new Error(
      `CCIP is not configured for network '${network}'. Known networks: ${Object.keys(
        CCIP_NETWORKS
      ).join(", ")}`
    );
  }
  return cfg;
}

/**
 * Resolves the remote side of a lane.
 *
 * Uses REMOTE_NETWORK when given, the sole partner when a network has exactly one, and otherwise
 * refuses rather than guessing — wiring the wrong lane is silent until a transfer fails.
 */
export function getRemoteConfig(network: string, override?: string): CcipNetworkConfig {
  const partners = getLanePartners(network);

  if (override) {
    if (override === network)
      throw new Error("REMOTE_NETWORK must differ from the current network.");
    if (partners.length > 0 && !partners.includes(override)) {
      throw new Error(
        `No configured lane '${network}' -> '${override}'. Known partners: ${partners.join(", ")}. ` +
          `If the lane is genuinely live, add it to LANE_PARTNERS after confirming with ccip:verify-config.`
      );
    }
    return getCcipConfig(override);
  }

  if (partners.length === 0) {
    throw new Error(
      `No lane partner configured for '${network}'. Set REMOTE_NETWORK, or add an entry to LANE_PARTNERS.`
    );
  }
  if (partners.length > 1) {
    throw new Error(
      `'${network}' has multiple lane partners (${partners.join(", ")}). ` +
        `Set REMOTE_NETWORK to pick one — there is no safe default.`
    );
  }
  return getCcipConfig(partners[0]);
}

/** Key used for the pool entry in deployments/<network>-deployment.json. */
export function poolKeyForVault(vaultKey: string): string {
  return `${vaultKey}CcipPool`;
}
