// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { EmberTokenPool } from "./EmberTokenPool.sol";
import { IEmberVaultToken } from "../interfaces/IEmberVaultToken.sol";

/**
 * @title EmberTokenPoolFactory
 * @notice CREATE2 deployment factory for {EmberTokenPool}.
 *
 * @dev Deploys a pool for a given Ember vault token and immediately proposes ownership to
 *      `poolOwner`. Ownership transfer is two-step (Ownable2Step), so `poolOwner` must call
 *      `acceptOwnership()` on the pool before it can configure it (applyChainUpdates, etc.).
 *
 *      The CREATE2 salt is namespaced by the caller, so a deployment cannot be front-run or
 *      squatted by another sender reusing the same salt.
 *
 *      Derived from smartcontractkit/ember-custom-token-pool.
 */
contract EmberTokenPoolFactory {
  error ZeroAddressInvalid();

  event PoolDeployed(
    address indexed pool,
    address indexed token,
    address indexed deployer,
    address poolOwner,
    bytes32 salt
  );

  /**
   * @notice Deploys an {EmberTokenPool} via CREATE2 and proposes ownership to `poolOwner`.
   * @param token The Ember vault token this pool burns / mints.
   * @param localTokenDecimals The token's decimals on this chain (validated against `token.decimals()`).
   * @param advancedPoolHooks Optional advanced pool hooks contract; `address(0)` for none.
   * @param rmnProxy The chain's RMN proxy.
   * @param router The chain's CCIP router.
   * @param poolOwner The address that will own the pool (must call `acceptOwnership()`).
   * @param salt Caller-chosen salt; the effective CREATE2 salt is `keccak256(msg.sender, salt)`.
   * @return pool The deployed pool address.
   */
  function deployPool(
    IEmberVaultToken token,
    uint8 localTokenDecimals,
    address advancedPoolHooks,
    address rmnProxy,
    address router,
    address poolOwner,
    bytes32 salt
  ) external returns (address pool) {
    if (poolOwner == address(0)) revert ZeroAddressInvalid();

    EmberTokenPool deployed = new EmberTokenPool{ salt: _effectiveSalt(msg.sender, salt) }(
      token,
      localTokenDecimals,
      advancedPoolHooks,
      rmnProxy,
      router
    );
    // The factory is the initial owner (Ownable2StepMsgSender); hand it off.
    deployed.transferOwnership(poolOwner);

    pool = address(deployed);
    emit PoolDeployed(pool, address(token), msg.sender, poolOwner, salt);
  }

  /// @notice Predicts the pool address `deployer` would get from `deployPool` with these args.
  function predictPoolAddress(
    IEmberVaultToken token,
    uint8 localTokenDecimals,
    address advancedPoolHooks,
    address rmnProxy,
    address router,
    address deployer,
    bytes32 salt
  ) external view returns (address) {
    bytes32 initCodeHash = keccak256(
      abi.encodePacked(
        type(EmberTokenPool).creationCode,
        abi.encode(token, localTokenDecimals, advancedPoolHooks, rmnProxy, router)
      )
    );
    return
      address(
        uint160(
          uint256(
            keccak256(
              abi.encodePacked(
                bytes1(0xff),
                address(this),
                _effectiveSalt(deployer, salt),
                initCodeHash
              )
            )
          )
        )
      );
  }

  function _effectiveSalt(address deployer, bytes32 salt) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(deployer, salt));
  }
}
