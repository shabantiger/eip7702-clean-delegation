import { ethers } from 'ethers';

export interface DelegationConfig {
  providerUrl: string;
  delegatorPrivateKey: string;
  sponsorPrivateKey?: string;
  chainId?: number;
  gasLimit?: number;
}

export interface SignerInfo {
  address: string;
  balance: string;
  nonce: number;
}

export interface DelegationResult {
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  success: boolean;
}

export interface AuthorizationParams {
  address: string;
  nonce: number;
  chainId: number;
}

export interface RevocationOptions {
  gasLimit?: number;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Configuration for the atomic stake-rescue operation.
 *
 * How it works:
 *   TX 1 — EIP-7702 sets the delegator's code to `executorAddress`, then calls
 *           the delegator (which now runs executor code in delegator's context).
 *           The executor: (a) calls the staking contract to withdraw,
 *                         (b) transfers the full token balance to `safeAddress`.
 *           Tokens NEVER sit in the compromised wallet — they flow directly
 *           staking contract → safeAddress in one atomic transaction.
 *   TX 2 — EIP-7702 revokes delegation (sets code back to ZeroAddress).
 *
 * The executor contract (deploy once, source below) must implement:
 *   rescueTokens(address stakingContract, bytes unstakeCalldata, address token, address safe)
 *
 * --- Solidity source for the RescueExecutor contract ---
 * // SPDX-License-Identifier: MIT
 * // pragma solidity ^0.8.20;
 * // interface IERC20 {
 * //   function balanceOf(address) external view returns (uint256);
 * //   function transfer(address to, uint256 amount) external returns (bool);
 * // }
 * // contract RescueExecutor {
 * //   function rescueTokens(
 * //     address stakingContract,
 * //     bytes calldata unstakeCalldata,
 * //     address tokenContract,
 * //     address safeAddress
 * //   ) external {
 * //     (bool ok, bytes memory ret) = stakingContract.call(unstakeCalldata);
 * //     if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
 * //     uint256 bal = IERC20(tokenContract).balanceOf(address(this));
 * //     if (bal > 0) IERC20(tokenContract).transfer(safeAddress, bal);
 * //   }
 * // }
 */
export interface RescueConfig {
  /** Address of the staking/pool contract that holds your tokens */
  stakingContractAddress: string;
  /**
   * ABI-encoded calldata for the withdraw/exit/unstake function.
   * Example (ethers.js):
   *   new ethers.Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw', [amount])
   *   new ethers.Interface(['function exit()']).encodeFunctionData('exit')
   */
  withdrawCalldata: string;
  /** Address of the ERC-20 token contract to rescue */
  tokenContractAddress: string;
  /**
   * Destination for rescued tokens.
   * MUST be your sponsor/safe wallet — tokens land here directly,
   * never touching the compromised address.
   */
  safeAddress: string;
  /**
   * Address of the deployed RescueExecutor contract.
   * Deploy it once from the Solidity source above.
   */
  executorAddress: string;
  /** Token decimals for display formatting (default: 18) */
  tokenDecimals?: number;
}

export interface RescueResult {
  /** Hash of the atomic unstake+transfer transaction */
  rescueTxHash: string;
  /** Hash of the delegation revocation transaction */
  revocationTxHash: string;
  /** Human-readable token amount transferred to safeAddress */
  tokenAmount: string;
  safeAddress: string;
  blockNumber: number;
  success: boolean;
}

export type Provider = ethers.JsonRpcProvider;
export type Signer = ethers.Wallet;
export type Authorization = ethers.Authorization;
export type TransactionReceipt = ethers.TransactionReceipt;