/**
 * LayerZero V2 Configuration
 * Contains endpoint addresses and chain IDs for cross-chain bridging
 *
 * Official LayerZero V2 Endpoints:
 * https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
 */

export interface LayerZeroChainConfig {
  name: string;
  endpointId: number; // LayerZero Endpoint ID (eid)
  endpointAddress: string; // LayerZero Endpoint V2 contract address
  chainId: number; // Native chain ID
  isTestnet: boolean;
}

// LayerZero V2 Endpoint IDs (eid)
// See: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
export const LZ_ENDPOINT_IDS = {
  // EVM Mainnets
  ETHEREUM: 30101,
  ARBITRUM: 30110,
  OPTIMISM: 30111,
  POLYGON: 30109,
  BASE: 30184,
  BSC: 30102,
  AVALANCHE: 30106,
  PHAROS: 30407,

  // EVM Testnets
  ATLANTIC: 40436,
  SEPOLIA: 40161,
  ARBITRUM_SEPOLIA: 40231,
  OPTIMISM_SEPOLIA: 40232,
  BASE_SEPOLIA: 40245,
  BSC_TESTNET: 40102,

  // Non-EVM
  SUI_MAINNET: 30280,
  SUI_TESTNET: 40378,
} as const;

// LayerZero V2 Endpoint Addresses
export const LZ_ENDPOINTS: Record<string, LayerZeroChainConfig> = {
  // ============ EVM Mainnets ============
  mainnet: {
    name: "Ethereum Mainnet",
    endpointId: LZ_ENDPOINT_IDS.ETHEREUM,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 1,
    isTestnet: false,
  },
  arbitrum: {
    name: "Arbitrum One",
    endpointId: LZ_ENDPOINT_IDS.ARBITRUM,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 42161,
    isTestnet: false,
  },
  optimism: {
    name: "Optimism",
    endpointId: LZ_ENDPOINT_IDS.OPTIMISM,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 10,
    isTestnet: false,
  },
  polygon: {
    name: "Polygon PoS",
    endpointId: LZ_ENDPOINT_IDS.POLYGON,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 137,
    isTestnet: false,
  },
  base: {
    name: "Base",
    endpointId: LZ_ENDPOINT_IDS.BASE,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 8453,
    isTestnet: false,
  },
  bsc: {
    name: "BNB Smart Chain",
    endpointId: LZ_ENDPOINT_IDS.BSC,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 56,
    isTestnet: false,
  },
  avalanche: {
    name: "Avalanche C-Chain",
    endpointId: LZ_ENDPOINT_IDS.AVALANCHE,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fE728c",
    chainId: 43114,
    isTestnet: false,
  },
  pharos: {
    name: "Pharos Mainnet",
    endpointId: LZ_ENDPOINT_IDS.PHAROS,
    endpointAddress: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
    chainId: 1672,
    isTestnet: false,
  },

  // ============ EVM Testnets ============
  atlantic: {
    name: "Atlantic Testnet",
    endpointId: LZ_ENDPOINT_IDS.ATLANTIC,
    endpointAddress: "0x3aCAAf60502791D199a5a5F0B173D78229eBFe32",
    chainId: 688689,
    isTestnet: true,
  },
  sepolia: {
    name: "Sepolia Testnet",
    endpointId: LZ_ENDPOINT_IDS.SEPOLIA,
    endpointAddress: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    chainId: 11155111,
    isTestnet: true,
  },
  arbitrumSepolia: {
    name: "Arbitrum Sepolia",
    endpointId: LZ_ENDPOINT_IDS.ARBITRUM_SEPOLIA,
    endpointAddress: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    chainId: 421614,
    isTestnet: true,
  },
  optimismSepolia: {
    name: "Optimism Sepolia",
    endpointId: LZ_ENDPOINT_IDS.OPTIMISM_SEPOLIA,
    endpointAddress: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    chainId: 11155420,
    isTestnet: true,
  },
  baseSepolia: {
    name: "Base Sepolia",
    endpointId: LZ_ENDPOINT_IDS.BASE_SEPOLIA,
    endpointAddress: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    chainId: 84532,
    isTestnet: true,
  },
  bscTestnet: {
    name: "BNB Testnet",
    endpointId: LZ_ENDPOINT_IDS.BSC_TESTNET,
    endpointAddress: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    chainId: 97,
    isTestnet: true,
  },

  // ============ Non-EVM Chains ============
  suiMainnet: {
    name: "Sui Mainnet",
    endpointId: LZ_ENDPOINT_IDS.SUI_MAINNET,
    endpointAddress: "", // Sui uses package IDs, not addresses
    chainId: 0, // Sui doesn't use numeric chain IDs
    isTestnet: false,
  },
  suiTestnet: {
    name: "Sui Testnet",
    endpointId: LZ_ENDPOINT_IDS.SUI_TESTNET,
    endpointAddress: "", // Sui uses package IDs, not addresses
    chainId: 0,
    isTestnet: true,
  },
};

/**
 * Get LayerZero endpoint config by network name
 */
export function getLzEndpoint(network: string): LayerZeroChainConfig {
  const config = LZ_ENDPOINTS[network];
  if (!config) {
    throw new Error(
      `Unknown network: ${network}. Available: ${Object.keys(LZ_ENDPOINTS).join(", ")}`
    );
  }
  return config;
}

/**
 * Get LayerZero endpoint ID by network name
 */
export function getLzEndpointId(network: string): number {
  return getLzEndpoint(network).endpointId;
}

/**
 * Get LayerZero endpoint address by network name
 */
export function getLzEndpointAddress(network: string): string {
  return getLzEndpoint(network).endpointAddress;
}

/**
 * Convert address to bytes32 format for LayerZero peer configuration
 * EVM addresses need to be left-padded with zeros to 32 bytes
 */
export function addressToBytes32(address: string): string {
  // Remove 0x prefix if present
  const cleanAddress = address.toLowerCase().replace("0x", "");
  // Pad to 64 characters (32 bytes)
  return "0x" + cleanAddress.padStart(64, "0");
}

/**
 * Convert bytes32 to address format
 * Extract the last 20 bytes (40 hex chars) as the address
 */
export function bytes32ToAddress(bytes32: string): string {
  const clean = bytes32.toLowerCase().replace("0x", "");
  return "0x" + clean.slice(-40);
}

/**
 * Default gas limits for LayerZero messaging
 */
export const DEFAULT_GAS_LIMITS = {
  // Gas limit for lzReceive execution on destination chain
  LZ_RECEIVE_GAS: 200_000n,
  // Gas limit for lzCompose execution (for composed messages)
  LZ_COMPOSE_GAS: 500_000n,
  // Native gas to airdrop on destination (0 for no airdrop)
  NATIVE_DROP_AMOUNT: 0n,
};

/**
 * OFT Configuration for bridging
 */
export interface OFTBridgeConfig {
  srcNetwork: string;
  dstNetwork: string;
  srcEndpointId: number;
  dstEndpointId: number;
  srcEndpointAddress: string;
  dstEndpointAddress: string;
}

/**
 * Create OFT bridge configuration between two networks
 */
export function createBridgeConfig(srcNetwork: string, dstNetwork: string): OFTBridgeConfig {
  const src = getLzEndpoint(srcNetwork);
  const dst = getLzEndpoint(dstNetwork);

  return {
    srcNetwork,
    dstNetwork,
    srcEndpointId: src.endpointId,
    dstEndpointId: dst.endpointId,
    srcEndpointAddress: src.endpointAddress,
    dstEndpointAddress: dst.endpointAddress,
  };
}

export default {
  LZ_ENDPOINT_IDS,
  LZ_ENDPOINTS,
  DEFAULT_GAS_LIMITS,
  getLzEndpoint,
  getLzEndpointId,
  getLzEndpointAddress,
  addressToBytes32,
  bytes32ToAddress,
  createBridgeConfig,
};
