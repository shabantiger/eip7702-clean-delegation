// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  RescueExecutor
 * @notice Minimal EIP-7702 rescue executor.
 *
 * DEPLOYMENT (one-time):
 *   Deploy this contract on your target network using Remix, Hardhat, or Foundry.
 *   Copy the deployed address into EXECUTOR_ADDRESS in your .env file.
 *
 * HOW IT WORKS:
 *   The eip7702-clean-delegation tool uses EIP-7702 to temporarily point your
 *   compromised wallet's code at this contract.  When called in that context:
 *     - address(this)  == your compromised wallet address
 *     - msg.sender     == your compromised wallet address  (for sub-calls)
 *   This means the staking contract sees your compromised address as the caller,
 *   so the withdrawal is authorised — but the tokens are sent directly to your
 *   safe wallet and never touch the compromised address.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract RescueExecutor {

    constructor() {}

    // -------------------------------------------------------------------------
    // Primary rescue function
    // -------------------------------------------------------------------------

    /**
     * @notice Unstake tokens and forward the full balance to a safe address,
     *         all in one atomic call.
     *
     * @param stakingContract  Address of the staking / pool contract.
     * @param unstakeCalldata  ABI-encoded calldata for the withdraw / exit call
     *                         (e.g. abi.encodeWithSignature("exit()") or
     *                               abi.encodeWithSignature("withdraw(uint256)", amount)).
     * @param tokenContract    Address of the ERC-20 token to rescue.
     * @param safeAddress      Destination for the rescued tokens (your new wallet).
     */
    function rescueTokens(
        address stakingContract,
        bytes calldata unstakeCalldata,
        address tokenContract,
        address safeAddress
    ) external {
        require(stakingContract != address(0), "RescueExecutor: zero staking address");
        require(tokenContract   != address(0), "RescueExecutor: zero token address");
        require(safeAddress     != address(0), "RescueExecutor: zero safe address");

        // 1. Call the staking contract to withdraw / unstake.
        //    msg.sender seen by the staking contract == address(this) == compromised wallet.
        (bool ok, bytes memory ret) = stakingContract.call(unstakeCalldata);
        if (!ok) {
            // Bubble up the revert reason from the staking contract.
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }

        // 2. Transfer the entire token balance to the safe address.
        //    Captures whatever amount the unstake just released.
        uint256 balance = IERC20(tokenContract).balanceOf(address(this));
        require(balance > 0, "RescueExecutor: no tokens to rescue");
        bool transferred = IERC20(tokenContract).transfer(safeAddress, balance);
        require(transferred, "RescueExecutor: token transfer failed");
    }

    // -------------------------------------------------------------------------
    // Generic batch executor (optional, advanced use)
    // -------------------------------------------------------------------------

    struct Call {
        address target;
        uint256 value;
        bytes   data;
    }

    /**
     * @notice Execute an arbitrary sequence of calls in the delegator's context.
     *         Reverts the entire batch if any call fails.
     */
    function execute(Call[] calldata calls) external payable {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly { revert(add(ret, 0x20), mload(ret)) }
            }
        }
    }

}
