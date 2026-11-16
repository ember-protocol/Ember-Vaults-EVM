import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat";
import "@openzeppelin/hardhat-upgrades";
import "solidity-coverage";
import * as dotenv from "dotenv";
import { ENV } from "./env";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    // 0.8.22 is the only compiler our own contracts ever use. Do not add another entry
    // here: hardhat picks the HIGHEST configured version a file's pragma allows, so a
    // second compiler would silently move every ^0.8.22 contract onto it and change
    // already-deployed implementation bytecode. CCIP's sources need ^0.8.24, and they get
    // there through `overrides` below, which is per-file and cannot leak.
    compilers: [
      {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
          viaIR: true,
        },
      },
    ],
    // The CCIP token pool, its factory, and the exact two @chainlink/contracts-ccip files
    // in their dependency closure that declare ^0.8.24. Every other file in that closure
    // (OpenZeppelin, the rest of CCIP) is ^0.8.20-or-lower and compiles fine on 0.8.22.
    //
    // evmVersion is pinned to paris — matching foundry.toml and Chainlink's own pool repo —
    // because 0.8.26 otherwise defaults to cancun and would emit MCOPY/TSTORE. Our vaults
    // already run PUSH0 bytecode on Pharos so shanghai is proven there, but cancun opcodes
    // are a separate question and paris costs nothing on a contract this small.
    overrides: Object.fromEntries(
      [
        "contracts/ccip/EmberTokenPool.sol",
        "contracts/ccip/EmberTokenPoolFactory.sol",
        "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol",
        "@chainlink/contracts-ccip/contracts/interfaces/IAdvancedPoolHooks.sol",
      ].map((sourceName) => [
        sourceName,
        {
          version: "0.8.26",
          settings: {
            optimizer: { enabled: true, runs: 100 },
            viaIR: true,
            evmVersion: "paris",
          },
        },
      ])
    ),
  },
  // ───────────────────────────────────────────────────────────────────────
  // Verification providers — hardhat-verify v2 has TWO independent providers
  // (`etherscan` and `blockscout`), each with its own customChains list.
  //
  // The Etherscan provider unconditionally rewrites the apiURL to
  // `api.etherscan.io/v2/api` when `apiKey` is a single string, then sends
  // `?chainid=<X>` as a query param. Pharos (1672) isn't on Etherscan's
  // chainlist so that request fails with "Missing or unsupported chainid".
  //
  // We split: Etherscan covers ethereum/base/monad/arbitrum/sepolia (single v2 key);
  // Blockscout covers Pharos/Atlantic via SocialScan's command_api endpoint.
  // The verify-contracts.ts script dispatches `verify:etherscan` vs
  // `verify:blockscout` based on the active network.
  // ───────────────────────────────────────────────────────────────────────
  etherscan: {
    // Single Etherscan v2 key — covers every Etherscan-family chain
    // (ethereum, base, sepolia, optimism, arbitrum, polygon, …) under the
    // unified v2 API. The per-network `apiKey: { ... }` shape is no longer
    // accepted by hardhat-verify v2.
    apiKey: process.env.ETHERSCAN_API_KEY || "empty",
    customChains: [
      // Base mainnet is an Etherscan-family chain so hardhat-verify could
      // resolve it from the default chain list, but pin it explicitly so
      // we never depend on the plugin's bundled chain catalogue staying
      // current.
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "monad",
        chainId: 143,
        urls: {
          apiURL: "https://api.monadscan.com/api",
          browserURL: "https://monadscan.com",
        },
      },
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://api-testnet.monadscan.com/api",
          browserURL: "https://testnet.monadscan.com",
        },
      },
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io",
        },
      },
    ],
  },
  blockscout: {
    // Enable the Blockscout-style provider so verify-contracts.ts can call
    // `verify:blockscout` directly for Pharos / Atlantic without the
    // Etherscan v2 routing kicking in. SocialScan (Hemera) accepts the
    // same Etherscan-shaped POST payload at its custom REST endpoint, so
    // the existing Blockscout provider works out of the box.
    enabled: true,
    customChains: [
      {
        network: "pharos",
        chainId: 1672,
        urls: {
          apiURL: "https://api.socialscan.io/pharos-mainnet/v1/explorer/command_api/contract",
          browserURL: "https://pharos.socialscan.io",
        },
      },
      {
        network: "atlantic",
        chainId: 688689,
        urls: {
          apiURL:
            "https://api.socialscan.io/pharos-atlantic-testnet/v1/explorer/command_api/contract",
          browserURL: "https://pharos-testnet.socialscan.io",
        },
      },
    ],
  },
  // Sourcify is an alternative path some teams enable alongside Etherscan.
  // Disable explicitly so the plugin doesn't print an info nag every run.
  sourcify: {
    enabled: false,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    externalArtifacts: ["externalArtifacts/*.json"],
  },
  gasReporter: {
    enabled: ENV.REPORT_GAS === "true" ? true : false,
  },
  defaultNetwork: ENV.DEPLOY_ON,
  networks: {
    // Local network with optional mainnet forking for upgrade testing
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true, // Allow large contracts for testing
      // Enable forking when FORK_MAINNET=true
      forking:
        process.env.FORK_MAINNET === "true" && process.env.MAINNET_RPC_URL
          ? {
              url: process.env.MAINNET_RPC_URL,
              // Optional: pin to a specific block for reproducibility
              // blockNumber: 24250000,
            }
          : undefined,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    atlantic: {
      url: process.env.PHAROS_TESTNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 688689,
      gasPrice: Number(process.env.PHAROS_TESTNET_GAS_PRICE_GWEI || "1") * 1_000_000_000,
    },
    pharos: {
      url: process.env.PHAROS_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1672,
      gasPrice: Number(process.env.PHAROS_GAS_PRICE_GWEI || "1") * 1_000_000_000_0,
    },
    base: {
      url: process.env.BASE_MAINNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 8453,
    },
    mantle_sepolia: {
      url: process.env.MANTLE_TESTNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 5003,
      // Mantle under-reports eth_estimateGas: a call needing ~33.6k came back low enough that
      // the transaction was mined with only intrinsic gas and reverted with no revert data
      // (status 0, gasUsed == gasLimit, `reason: null`). Pad every estimate on this chain.
      gasMultiplier: 3,
    },
    // Public mainnet RPC caps eth_getLogs at 100 blocks; use a private endpoint.
    monad: {
      url: process.env.MONAD_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 143,
    },
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 10143,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
