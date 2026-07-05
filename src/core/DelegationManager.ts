import { ethers } from 'ethers';
import type {
  DelegationConfig,
  Provider,
  Signer,
  Authorization,
  SignerInfo,
  DelegationResult,
  AuthorizationParams,
  RevocationOptions,
  RescueConfig,
  RescueResult,
} from '../types/index.js';
import { ConfigManager } from '../utils/config.js';
import {
  TransactionError,
  AuthorizationError,
  DelegationError,
} from '../utils/errors.js';
import {
  validateBalance,
  formatBalance,
  waitWithTimeout,
} from '../utils/helpers.js';

export class DelegationManager {
  private provider!: Provider;
  private delegatorSigner!: Signer;
  private sponsorSigner?: Signer;
  private config: DelegationConfig;
  private resolvedChainId?: number;

  constructor(config: DelegationConfig | ConfigManager) {
    if (config instanceof ConfigManager) {
      this.config = config.getConfig();
    } else {
      this.config = new ConfigManager(config).getConfig();
    }

    this.initializeSigners();
  }

  private initializeSigners(): void {
    this.provider = new ethers.JsonRpcProvider(this.config.providerUrl);
    this.delegatorSigner = new ethers.Wallet(this.config.delegatorPrivateKey, this.provider);

    if (this.config.sponsorPrivateKey) {
      this.sponsorSigner = new ethers.Wallet(this.config.sponsorPrivateKey, this.provider);
    }
  }

  public static fromEnv(): DelegationManager {
    return new DelegationManager(ConfigManager.fromEnv());
  }

  public async getDelegatorInfo(): Promise<SignerInfo> {
    const balance = await this.provider.getBalance(this.delegatorSigner.address);
    const nonce = await this.delegatorSigner.getNonce();

    return {
      address: this.delegatorSigner.address,
      balance: formatBalance(balance),
      nonce,
    };
  }

  public async getSponsorInfo(): Promise<SignerInfo | null> {
    if (!this.sponsorSigner) {
      return null;
    }

    const balance = await this.provider.getBalance(this.sponsorSigner.address);
    const nonce = await this.sponsorSigner.getNonce();

    return {
      address: this.sponsorSigner.address,
      balance: formatBalance(balance),
      nonce,
    };
  }

  public async createRevocationAuthorization(
    params?: Partial<AuthorizationParams>
  ): Promise<Authorization> {
    try {
      const currentNonce = await this.delegatorSigner.getNonce();
      const chainId = params?.chainId ?? await this.getAuthorizationChainId();
      
      const authParams: AuthorizationParams = {
        address: ethers.ZeroAddress,
        nonce: currentNonce,
        chainId,
        ...params,
      };

      const authorization = await this.delegatorSigner.authorize(authParams);
      
      return authorization;
    } catch (error) {
      throw new AuthorizationError(
        `Failed to create revocation authorization: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public async revokeDelegation(
    authorization?: Authorization,
    options?: RevocationOptions
  ): Promise<DelegationResult> {
    try {
      await validateBalance(this.delegatorSigner);

      const auth = authorization || await this.createRevocationAuthorization();

      const txParams = {
        type: 4 as const,
        to: this.delegatorSigner.address,
        value: 0,
        gasLimit: options?.gasLimit || 50000,
        authorizationList: [auth],
        ...(await this.resolveFeeParams(options)),
      };

      const tx = await this.delegatorSigner.sendTransaction(txParams);
      const receipt = await waitWithTimeout(tx.wait(), 60000);

      if (!receipt) {
        throw new TransactionError('Transaction receipt is null', tx.hash);
      }

      return {
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        success: receipt.status === 1,
      };
    } catch (error) {
      if (error instanceof DelegationError) {
        throw error;
      }
      
      throw new TransactionError(
        `Failed to revoke delegation: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public async sponsoredRevokeDelegation(
    authorization?: Authorization,
    options?: RevocationOptions
  ): Promise<DelegationResult> {
    if (!this.sponsorSigner) {
      throw new DelegationError('Sponsor signer not configured');
    }

    try {
      await validateBalance(this.sponsorSigner);

      const auth = authorization || await this.createRevocationAuthorization();

      const txParams = {
        type: 4 as const,
        to: this.delegatorSigner.address,
        value: 0,
        gasLimit: options?.gasLimit || 50000,
        authorizationList: [auth],
        ...(await this.resolveFeeParams(options)),
      };

      const tx = await this.sponsorSigner.sendTransaction(txParams);
      const receipt = await waitWithTimeout(tx.wait(), 60000);

      if (!receipt) {
        throw new TransactionError('Transaction receipt is null', tx.hash);
      }

      return {
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        success: receipt.status === 1,
      };
    } catch (error) {
      if (error instanceof DelegationError) {
        throw error;
      }
      
      throw new TransactionError(
        `Failed to sponsor delegation revocation: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Atomically revokes the malicious EIP-7702 delegation AND rescues staked tokens
   * in two sponsored transactions:
   *
   *   TX 1: Sets delegator code = rescue executor, calls it to unstake + send tokens
   *         directly to safeAddress (tokens never touch the compromised wallet).
   *   TX 2: Revokes delegation (sets delegator code back to ZeroAddress).
   *
   * Both transactions are paid by the sponsor — no ETH ever lands in the
   * compromised wallet, so the sweeper bot has nothing to steal.
   *
   * Requires: sponsorPrivateKey must be configured.
   */
  public async rescueStakedTokens(rescueConfig: RescueConfig): Promise<RescueResult> {
    if (!this.sponsorSigner) {
      throw new DelegationError(
        'Sponsor signer is required for token rescue — it pays all gas fees'
      );
    }

    if (!ethers.isAddress(rescueConfig.stakingContractAddress)) {
      throw new AuthorizationError('Invalid staking contract address');
    }
    if (!ethers.isAddress(rescueConfig.tokenContractAddress)) {
      throw new AuthorizationError('Invalid token contract address');
    }
    if (!ethers.isAddress(rescueConfig.safeAddress)) {
      throw new AuthorizationError('Invalid safe address');
    }
    if (!ethers.isAddress(rescueConfig.executorAddress)) {
      throw new AuthorizationError('Invalid executor contract address');
    }

    // Build calldata for rescueTokens(stakingContract, unstakeCalldata, token, safe)
    // This runs in the delegator's EIP-7702 context, so:
    //   address(this) = delegator, msg.sender = delegator for all sub-calls
    const executorInterface = new ethers.Interface([
      'function rescueTokens(address stakingContract, bytes calldata unstakeCalldata, address tokenContract, address safeAddress) external',
    ]);
    const rescueCalldata = executorInterface.encodeFunctionData('rescueTokens', [
      rescueConfig.stakingContractAddress,
      rescueConfig.withdrawCalldata,
      rescueConfig.tokenContractAddress,
      rescueConfig.safeAddress,
    ]);

    // --- TX 1: delegate to rescue executor + execute unstake + transfer ---
    const delegatorNonce = await this.delegatorSigner.getNonce();
    const chainId = await this.getAuthorizationChainId();

    const rescueAuthorization = await this.delegatorSigner.authorize({
      address: rescueConfig.executorAddress,
      nonce: delegatorNonce,
      chainId,
    });

    const rescueTxParams = {
      type: 4 as const,
      // Call the delegator's address — its code is now the rescue executor,
      // running in the delegator's context (msg.sender = delegator for staking call)
      to: this.delegatorSigner.address,
      value: 0n,
      gasLimit: 400_000,
      authorizationList: [rescueAuthorization],
      data: rescueCalldata,
      ...(await this.resolveFeeParams()),
    };

    const rescueTx = await this.sponsorSigner.sendTransaction(rescueTxParams);
    const rescueReceipt = await waitWithTimeout(rescueTx.wait(), 120_000);

    if (!rescueReceipt) {
      throw new TransactionError('Rescue transaction receipt is null', rescueTx.hash);
    }
    if (rescueReceipt.status !== 1) {
      throw new TransactionError(
        'Rescue transaction failed on-chain — check unstake calldata and executor address',
        rescueTx.hash
      );
    }

    // Parse transferred token amount from Transfer(from, to, value) event logs
    const transferTopicHash = ethers.id('Transfer(address,address,uint256)');
    let rescuedAmount = 0n;
    for (const log of rescueReceipt.logs) {
      if (
        log.address.toLowerCase() === rescueConfig.tokenContractAddress.toLowerCase() &&
        log.topics[0] === transferTopicHash &&
        log.topics.length >= 3 &&
        log.topics[2] !== undefined
      ) {
        const toAddress = ethers.getAddress('0x' + log.topics[2].slice(26));
        if (toAddress.toLowerCase() === rescueConfig.safeAddress.toLowerCase()) {
          rescuedAmount += BigInt(log.data);
        }
      }
    }

    // --- TX 2: revoke delegation (set code back to ZeroAddress) ---
    const revocationAuthorization = await this.createRevocationAuthorization();
    const revokeTxParams = {
      type: 4 as const,
      to: this.delegatorSigner.address,
      value: 0n,
      gasLimit: 50_000,
      authorizationList: [revocationAuthorization],
      ...(await this.resolveFeeParams()),
    };

    const revokeTx = await this.sponsorSigner.sendTransaction(revokeTxParams);
    const revokeReceipt = await waitWithTimeout(revokeTx.wait(), 60_000);

    if (!revokeReceipt) {
      throw new TransactionError('Revocation transaction receipt is null', revokeTx.hash);
    }

    const decimals = rescueConfig.tokenDecimals ?? 18;
    return {
      rescueTxHash: rescueReceipt.hash,
      revocationTxHash: revokeReceipt.hash,
      tokenAmount: ethers.formatUnits(rescuedAmount, decimals),
      safeAddress: rescueConfig.safeAddress,
      blockNumber: rescueReceipt.blockNumber,
      success: revokeReceipt.status === 1,
    };
  }

  public getProvider(): Provider {
    return this.provider;
  }

  public getDelegatorSigner(): Signer {
    return this.delegatorSigner;
  }

  public getSponsorSigner(): Signer | undefined {
    return this.sponsorSigner;
  }

  private async getAuthorizationChainId(): Promise<number> {
    if (this.config.chainId) {
      return this.config.chainId;
    }

    if (this.resolvedChainId) {
      return this.resolvedChainId;
    }

    const network = await this.provider.getNetwork();
    this.resolvedChainId = Number(network.chainId);
    return this.resolvedChainId;
  }

  private async resolveFeeParams(options?: RevocationOptions): Promise<{
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }> {
    if (options?.gasPrice) {
      return { gasPrice: options.gasPrice };
    }

    if (options?.maxFeePerGas || options?.maxPriorityFeePerGas) {
      return {
        ...(options.maxFeePerGas && { maxFeePerGas: options.maxFeePerGas }),
        ...(options.maxPriorityFeePerGas && {
          maxPriorityFeePerGas: options.maxPriorityFeePerGas,
        }),
      };
    }

    const feeData = await this.provider.getFeeData();

    // Use EIP-1559 fields only when both are genuinely non-zero
    if (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n &&
        feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > 0n) {
      return {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
    }

    // EIP-7702 (type 4) requires EIP-1559 fee fields — not legacy gasPrice.
    // BSC and other chains may return 0 from getFeeData(), so we call
    // eth_gasPrice directly and use it for both fee fields.
    const gasPriceHex: string = await this.provider.send('eth_gasPrice', []);
    const gasPrice = BigInt(gasPriceHex);

    if (gasPrice > 0n) {
      return {
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
      };
    }

    // Absolute fallback: 3 Gwei (covers BSC mainnet minimum)
    const fallback = 3_000_000_000n;
    return {
      maxFeePerGas: fallback,
      maxPriorityFeePerGas: fallback,
    };
  }
}