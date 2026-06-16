// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Brings OZ's TimelockController into the hardhat compilation set so its
// artifact is available for deploy scripts. No project-level wrapper is
// needed — the contract is used as-is.
import "@openzeppelin/contracts/governance/TimelockController.sol";
