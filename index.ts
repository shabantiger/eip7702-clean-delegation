#!/usr/bin/env bun
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { DelegationManager } from './src/index.js';
import type { RescueConfig } from './src/index.js';
import {
  ConfigurationError,
  InsufficientBalanceError,
  TransactionError,
  AuthorizationError,
  DelegationError,
} from './src/index.js';

dotenv.config();

console.log('EIP-7702 Clean Delegation Tool');
console.log('================================\n');

async function getNativeTokenSymbol(manager: DelegationManager): Promise<string> {
  const network = await manager.getProvider().getNetwork();
  const chainId = Number(network.chainId);

  if (chainId === 56 || chainId === 97) {
    return 'BNB';
  }

  return 'ETH';
}

/**
 * Loads rescue configuration from environment variables.
 * Required env vars when RESCUE_MODE=true:
 *   STAKING_CONTRACT     — address of the staking/pool contract
 *   UNSTAKE_CALLDATA     — hex-encoded calldata for withdraw/exit/unstake function
 *   TOKEN_CONTRACT       — address of the ERC-20 token to rescue
 *   SAFE_ADDRESS         — destination address (defaults to SPONSOR address)
 *   EXECUTOR_ADDRESS     — address of your deployed RescueExecutor contract
 *   TOKEN_DECIMALS       — optional, defaults to 18
 */
function loadRescueConfig(): RescueConfig {
  const missing: string[] = [];

  const stakingContractAddress = process.env.STAKING_CONTRACT || '';
  const withdrawCalldata = process.env.UNSTAKE_CALLDATA || '';
  const tokenContractAddress = process.env.TOKEN_CONTRACT || '';
  const executorAddress = process.env.EXECUTOR_ADDRESS || '';
  const safeAddress = process.env.SAFE_ADDRESS || process.env.SPONSOR_ADDRESS || '';

  if (!stakingContractAddress) missing.push('STAKING_CONTRACT');
  if (!withdrawCalldata) missing.push('UNSTAKE_CALLDATA');
  if (!tokenContractAddress) missing.push('TOKEN_CONTRACT');
  if (!executorAddress) missing.push('EXECUTOR_ADDRESS');
  if (!safeAddress) missing.push('SAFE_ADDRESS (or SPONSOR_ADDRESS)');

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Rescue mode requires these env vars: ${missing.join(', ')}`
    );
  }

  if (!ethers.isAddress(stakingContractAddress)) {
    throw new ConfigurationError('STAKING_CONTRACT is not a valid address');
  }
  if (!ethers.isAddress(tokenContractAddress)) {
    throw new ConfigurationError('TOKEN_CONTRACT is not a valid address');
  }
  if (!ethers.isAddress(executorAddress)) {
    throw new ConfigurationError('EXECUTOR_ADDRESS is not a valid address');
  }
  if (!ethers.isAddress(safeAddress)) {
    throw new ConfigurationError('SAFE_ADDRESS is not a valid address');
  }
  if (!withdrawCalldata.startsWith('0x')) {
    throw new ConfigurationError('UNSTAKE_CALLDATA must be a hex string starting with 0x');
  }

  return {
    stakingContractAddress,
    withdrawCalldata,
    tokenContractAddress,
    safeAddress,
    executorAddress,
    tokenDecimals: process.env.TOKEN_DECIMALS ? parseInt(process.env.TOKEN_DECIMALS) : 18,
  };
}

async function main() {
  try {
    const rescueMode = process.env.RESCUE_MODE === 'true';

    console.log('Initializing delegation manager...');
    const manager = DelegationManager.fromEnv();
    const nativeTokenSymbol = await getNativeTokenSymbol(manager);

    console.log('Getting account information...');
    const delegatorInfo = await manager.getDelegatorInfo();
    console.log(`Delegator: ${delegatorInfo.address}`);
    console.log(`Balance:   ${delegatorInfo.balance} ${nativeTokenSymbol}`);
    console.log(`Nonce:     ${delegatorInfo.nonce}\n`);

    const sponsorInfo = await manager.getSponsorInfo();
    if (sponsorInfo) {
      console.log('Sponsor (safe) account:');
      console.log(`Address: ${sponsorInfo.address}`);
      console.log(`Balance: ${sponsorInfo.balance} ${nativeTokenSymbol}`);
      console.log(`Nonce:   ${sponsorInfo.nonce}\n`);
    }

    if (rescueMode) {
      // -----------------------------------------------------------------------
      // RESCUE MODE: revoke malicious delegation + unstake + transfer to safe
      // -----------------------------------------------------------------------
      if (!sponsorInfo) {
        throw new DelegationError(
          'Rescue mode requires SPONSOR_PRIVATE_KEY — the sponsor pays gas and receives tokens'
        );
      }

      console.log('Rescue mode enabled.');
      console.log('Loading rescue configuration...');
      const rescueConfig = loadRescueConfig();

      console.log(`Staking contract: ${rescueConfig.stakingContractAddress}`);
      console.log(`Token contract:   ${rescueConfig.tokenContractAddress}`);
      console.log(`Safe address:     ${rescueConfig.safeAddress}`);
      console.log(`Executor:         ${rescueConfig.executorAddress}\n`);

      console.log('Step 1/2: Executing atomic unstake + transfer to safe address...');
      console.log('(Tokens flow directly to safe wallet — never touch the compromised address)\n');

      const result = await manager.rescueStakedTokens(rescueConfig);

      if (result.success) {
        console.log('✅ Tokens rescued and delegation revoked successfully!\n');
        console.log(`Rescue TX:     ${result.rescueTxHash}`);
        console.log(`Revoke TX:     ${result.revocationTxHash}`);
        console.log(`Token amount:  ${result.tokenAmount} tokens`);
        console.log(`Sent to:       ${result.safeAddress}`);
        console.log(`Block:         ${result.blockNumber}`);
      } else {
        console.error('Rescue completed but revocation may have failed. Check revoke TX.');
        console.log(`Rescue TX: ${result.rescueTxHash}`);
        console.log(`Revoke TX: ${result.revocationTxHash}`);
        process.exit(1);
      }
    } else {
      // -----------------------------------------------------------------------
      // REVOKE-ONLY MODE: just remove the malicious delegation
      // -----------------------------------------------------------------------
      console.log('Creating revocation authorization...');
      const authorization = await manager.createRevocationAuthorization();
      console.log('Authorization created successfully\n');

      if (sponsorInfo) {
        console.log('Executing sponsored delegation revocation...');
        const result = await manager.sponsoredRevokeDelegation(authorization);

        if (result.success) {
          console.log('Delegation revoked successfully via sponsor!');
          console.log(`Transaction: ${result.transactionHash}`);
          console.log(`Block: ${result.blockNumber}`);
          console.log(`Gas Used: ${result.gasUsed}`);
        } else {
          console.log('Revocation transaction failed');
          process.exit(1);
        }
      } else {
        console.log('Executing delegation revocation...');
        const result = await manager.revokeDelegation(authorization);

        if (result.success) {
          console.log('Delegation revoked successfully!');
          console.log(`Transaction: ${result.transactionHash}`);
          console.log(`Block: ${result.blockNumber}`);
          console.log(`Gas Used: ${result.gasUsed}`);
        } else {
          console.log('Revocation transaction failed');
          process.exit(1);
        }
      }
    }

    console.log('\nOperation completed successfully!');

  } catch (error) {
    console.error('\nError occurred:');

    if (error instanceof ConfigurationError) {
      console.error('Configuration Error:', error.message);
      console.error('Please check your .env file and ensure all required variables are set.');
    } else if (error instanceof InsufficientBalanceError) {
      console.error('Insufficient Balance:', error.message);
      console.error('Please add more native gas token to your account (ETH/BNB depending on your network).');
    } else if (error instanceof AuthorizationError) {
      console.error('Authorization Error:', error.message);
      console.error('Please check your private keys and network configuration.');
    } else if (error instanceof DelegationError) {
      console.error('Delegation Error:', error.message);
    } else if (error instanceof TransactionError) {
      console.error('Transaction Error:', error.message);
      console.error('This might be a gas, calldata, or network issue.');
    } else {
      console.error('Unknown Error:', error instanceof Error ? error.message : 'Something went wrong');
    }

    console.error('\nFor help, check the README.md file or your configuration.');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nProcess interrupted. Exiting gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nProcess terminated. Exiting gracefully...');
  process.exit(0);
});

// Run the main function
main();