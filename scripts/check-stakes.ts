#!/usr/bin/env bun
/**
 * Run this script FIRST to inspect your staked positions and generate
 * the correct UNSTAKE_CALLDATA and TOKEN_CONTRACT values for your .env
 *
 * Usage:
 *   bun run scripts/check-stakes.ts
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const STAKING_CONTRACT = '0x8f5aF1E069Cf63118bdD018203F5228343cc4f94';

const ABI = [
  'function stakingToken() view returns (address)',
  'function stakeNum(address account) view returns (uint256)',
  'function stakeTimeAmount(address account, uint256 ith) view returns (uint256 stakeType, uint256 amount, uint256 stakeTime, uint256 reward)',
  'function getStakeData(address account) view returns (tuple(uint256 stakeType, uint256 amount, uint256 stakeTime, uint256 reward)[])',
  'function getMustStakeTime(uint256 stakeType) view returns (uint256)',
  'function getNowTIme() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const EXIT_IFACE  = new ethers.Interface(['function exit(uint256 ith)']);
const WITH_IFACE  = new ethers.Interface(['function withdraw(uint256 amount)']);

async function main() {
  const providerUrl = process.env.PROVIDER_URL;
  const wallet      = process.env.DELEGATOR_PRIVATE_KEY;

  if (!providerUrl || !wallet) {
    console.error('PROVIDER_URL and DELEGATOR_PRIVATE_KEY must be set in .env');
    process.exit(1);
  }

  const provider  = new ethers.JsonRpcProvider(providerUrl);
  const signer    = new ethers.Wallet(wallet, provider);
  const account   = signer.address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const staking   = new ethers.Contract(STAKING_CONTRACT, ABI, provider) as any;

  console.log('=== QuackAiStake Position Inspector ===\n');
  console.log(`Account : ${account}`);

  // --- token info ---
  const tokenAddress: string = await staking.stakingToken();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider) as any;
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  const tokenBalance = await token.balanceOf(account);

  console.log(`Token   : ${symbol} (${tokenAddress})`);
  console.log(`Wallet token balance (unstaked): ${ethers.formatUnits(tokenBalance, decimals)} ${symbol}\n`);

  // --- stake positions ---
  const stakeCount: bigint = await staking.stakeNum(account);
  console.log(`Stake positions found: ${stakeCount}\n`);

  if (stakeCount === 0n) {
    console.log('No active stake positions. Nothing to rescue via exit().');
    console.log('\n--- ENV values ---');
    console.log(`TOKEN_CONTRACT=${tokenAddress}`);
    process.exit(0);
  }

  const nowTime: bigint = await staking.getNowTIme();
  let totalStaked = 0n;

  for (let i = 0n; i < stakeCount; i++) {
    const pos = await staking.stakeTimeAmount(account, i);

    console.log(`--- Position ${i} ---`);
    console.log(`  Type      : ${pos.stakeType}`);
    console.log(`  Amount    : ${ethers.formatUnits(pos.amount, decimals)} ${symbol}`);
    console.log(`  Reward    : ${ethers.formatUnits(pos.reward,  decimals)} ${symbol}`);

    const calldata = EXIT_IFACE.encodeFunctionData('exit', [i]);
    console.log(`  UNSTAKE_CALLDATA for this position: ${calldata}\n`);
    totalStaked += pos.amount;
  }

  console.log(`Total staked: ${ethers.formatUnits(totalStaked, decimals)} ${symbol}\n`);

  console.log('=== Copy these into your .env ===\n');
  console.log(`TOKEN_CONTRACT=${tokenAddress}`);
  console.log(`TOKEN_DECIMALS=${decimals}`);

  if (stakeCount === 1n) {
    const calldata = EXIT_IFACE.encodeFunctionData('exit', [0n]);
    console.log(`UNSTAKE_CALLDATA=${calldata}`);
    console.log('\n(Single position — use the calldata above)');
  } else {
    console.log('\nYou have MULTIPLE stake positions.');
    console.log('The tool will exit them one by one.');
    console.log('Set UNSTAKE_CALLDATA to the calldata for position 0 first,');
    console.log('then re-run with position 1, 2, ... for each remaining position.\n');
    for (let i = 0n; i < stakeCount; i++) {
      console.log(`  Position ${i}: UNSTAKE_CALLDATA=${EXIT_IFACE.encodeFunctionData('exit', [i])}`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
