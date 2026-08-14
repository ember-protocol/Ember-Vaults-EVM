// SPDX-License-Identifier: UNLICENSED
/*
  Copyright (c) 2026 Ember Protocol Inc.
  Proprietary Smart Contract License – All Rights Reserved.
*/
pragma solidity ^0.8.22;

/// @title WithdrawalQueueLib
/// @notice Per-account withdrawal-queue bookkeeping hoisted out of the vault implementations
///         to keep them under EIP-170. Currently linked by EmberETHVault; the `Account` type
///         and logic are vault-agnostic so other vaults (e.g. AtomicLiquidity) can adopt it.
/// @dev External library: `updateAccountState` runs via DELEGATECALL in the calling vault's
///      storage context, so the `accounts` mapping reference resolves to the vault's storage.
///      The vault declares `accounts` as `mapping(address => WithdrawalQueueLib.Account)` so
///      the slot type matches this parameter.
library WithdrawalQueueLib {
  struct Account {
    uint256 totalPendingWithdrawalShares;
    uint256[] pendingWithdrawalRequestSequenceNumbers;
    uint256[] cancelWithdrawRequestSequenceNumbers;
  }

  error InvalidRequest();
  error InsufficientShares();

  /// @notice Re-declared in each vault too. DELEGATECALL keeps `address(this)` as the proxy, so
  ///         off-chain indexers see the event emitted by the vault address.
  event RequestCancelled(
    address indexed vault,
    address indexed owner,
    uint256 requestSequenceNumber,
    uint256[] cancelWithdrawRequestSequenceNumbers,
    uint256 timestamp
  );

  /// @notice Records a cancellation on `owner`'s account: the request must be currently pending
  ///         and not already cancelled, else reverts `InvalidRequest`. Appends the seq to the
  ///         cancel list (the shares are actually returned later, when the operator pops the
  ///         request from the queue) and emits `RequestCancelled`.
  /// @dev External (DELEGATECALL) so `address(this)` on the event is the vault proxy. Hoisted out
  ///      of the vault to keep it under EIP-170.
  /// @param accounts Storage ref to the vault's per-owner account map.
  /// @param owner The request owner (the canceller).
  /// @param requestSequenceNumber The pending request to cancel.
  /// @param timestampMs Chain time in ms for the event.
  function cancel(
    mapping(address => Account) storage accounts,
    address owner,
    uint256 requestSequenceNumber,
    uint256 timestampMs
  ) external {
    Account storage accountState = accounts[owner];
    if (accountState.totalPendingWithdrawalShares == 0) revert InvalidRequest();

    uint256[] storage cancelList = accountState.cancelWithdrawRequestSequenceNumbers;
    for (uint256 i = 0; i < cancelList.length; i++) {
      if (cancelList[i] == requestSequenceNumber) revert InvalidRequest();
    }

    uint256[] storage pendingList = accountState.pendingWithdrawalRequestSequenceNumbers;
    bool found = false;
    for (uint256 i = 0; i < pendingList.length; i++) {
      if (pendingList[i] == requestSequenceNumber) {
        found = true;
        break;
      }
    }
    if (!found) revert InvalidRequest();

    cancelList.push(requestSequenceNumber);
    emit RequestCancelled(address(this), owner, requestSequenceNumber, cancelList, timestampMs);
  }

  /// @notice Adds or removes a pending withdrawal request from an owner's account bookkeeping.
  /// @dev On `add`: increments the pending-share total and pushes `reqSeqNum`. On remove:
  ///      decrements the total, swap-and-pops `reqSeqNum` from the pending array, and (when
  ///      `index != type(uint256).max`) swap-and-pops the cancel array at `index`.
  /// @param accounts Storage ref to the vault's per-owner account map.
  /// @param owner The request owner whose bookkeeping is updated.
  /// @param shares The request's share amount.
  /// @param reqSeqNum The request's sequence number (the pending-array key).
  /// @param add True to enqueue, false to dequeue.
  /// @param index Cancel-array index to remove on dequeue, or type(uint256).max for none.
  function updateAccountState(
    mapping(address => Account) storage accounts,
    address owner,
    uint256 shares,
    uint256 reqSeqNum,
    bool add,
    uint256 index
  ) external {
    if (add && index != type(uint256).max) revert InvalidRequest();

    Account storage accountState = accounts[owner];

    if (add) {
      unchecked {
        accountState.totalPendingWithdrawalShares += shares;
      }
      accountState.pendingWithdrawalRequestSequenceNumbers.push(reqSeqNum);
    } else {
      if (accountState.totalPendingWithdrawalShares < shares) revert InsufficientShares();
      unchecked {
        accountState.totalPendingWithdrawalShares -= shares;
      }

      uint256[] storage pendingSeqNums = accountState.pendingWithdrawalRequestSequenceNumbers;
      uint256 pendingLength = pendingSeqNums.length;
      if (pendingLength == 0) revert InvalidRequest();

      uint256 seqNumIndex = 0;
      bool found = false;
      for (uint256 i; i < pendingLength; ) {
        if (pendingSeqNums[i] == reqSeqNum) {
          seqNumIndex = i;
          found = true;
          break;
        }
        unchecked {
          ++i;
        }
      }

      if (!found) revert InvalidRequest();

      // Swap-and-pop the removed sequence number out of the pending array.
      uint256 lastIndex = pendingLength - 1;
      if (seqNumIndex != lastIndex) {
        pendingSeqNums[seqNumIndex] = pendingSeqNums[lastIndex];
      }
      pendingSeqNums.pop();

      // If this request was cancelled, swap-and-pop its entry from the cancel array.
      if (index != type(uint256).max) {
        uint256[] storage cancelSeqNums = accountState.cancelWithdrawRequestSequenceNumbers;
        uint256 cancelLength = cancelSeqNums.length;
        if (index < cancelLength) {
          unchecked {
            uint256 lastCancelIndex = cancelLength - 1;
            if (index != lastCancelIndex) {
              cancelSeqNums[index] = cancelSeqNums[lastCancelIndex];
            }
          }
          cancelSeqNums.pop();
        }
      }
    }
  }
}
