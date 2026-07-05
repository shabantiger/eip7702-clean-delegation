# EIP-7702 Clean Delegation

A command-line tool to revoke malicious EIP-7702 delegations and atomically rescue staked tokens on Ethereum and BNB Smart Chain.

## What is EIP-7702?

EIP-7702 allows EOAs (regular wallets) to temporarily delegate their authority to smart contract code. Attackers abuse this to set up sweeper bots — any token that lands in your wallet is instantly stolen. This tool removes the malicious delegation and rescues your staked tokens before the sweeper can act.

## How the Rescue Works

The tool operates in two sponsored transactions (your compromised wallet never needs ETH):

```
TX 1 — Atomic rescue (sponsor pays gas):
  EIP-7702 sets compromised wallet code = RescueExecutor
  Calls compromised wallet → executor runs in its context:
    1. Calls staking contract exit/withdraw  (msg.sender = your compromised wallet ✓)
    2. Transfers full token balance → safe wallet
  Tokens NEVER touch the compromised wallet — sweeper has nothing to steal.

TX 2 — Revocation (sponsor pays gas):
  EIP-7702 sets compromised wallet code = ZeroAddress
  Malicious delegation removed.
```

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0.0 or higher)
- An EVM RPC provider (QuickNode, Alchemy, Infura, NodeReal, etc.)
- A **new safe wallet** (sponsor) with enough native gas token for 2 transactions (~0.003 BNB / ~0.005 ETH)
- Private key of the compromised wallet

## Installation

```bash
git clone https://github.com/codeesura/eip7702-clean-delegation.git
cd eip7702-clean-delegation
bun install
```

## Setup

### 1. Deploy the RescueExecutor contract (one-time)

Open `contracts/RescueExecutor.sol` in [Remix](https://remix.ethereum.org), compile with Solidity `^0.8.20`, and deploy to your network. Copy the deployed contract address.

### 2. Find your stake calldata

Run the stake inspector to automatically detect your staking positions and generate the correct calldata:

```bash
bun run scripts/check-stakes.ts
```

This prints your `TOKEN_CONTRACT`, `TOKEN_DECIMALS`, and `UNSTAKE_CALLDATA` values ready to paste into `.env`.

### 3. Configure `.env`

```env
# ── Core ──────────────────────────────────────────────────────────────────────
PROVIDER_URL=https://your-rpc-url

# Ethereum example:  https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY
# BSC example:       https://bsc-dataseed.binance.org/

DELEGATOR_PRIVATE_KEY=0x...   # compromised wallet private key
SPONSOR_PRIVATE_KEY=0x...     # new safe wallet private key (pays gas, receives tokens)

# Optional — auto-detected from RPC if omitted
# 1=Ethereum, 56=BSC mainnet, 97=BSC testnet, 11155111=Sepolia
CHAIN_ID=56

# ── Rescue mode ───────────────────────────────────────────────────────────────
RESCUE_MODE=true
STAKING_CONTRACT=0x...        # staking/pool contract address
UNSTAKE_CALLDATA=0x...        # from: bun run scripts/check-stakes.ts
TOKEN_CONTRACT=0x...          # ERC-20 token address
SAFE_ADDRESS=0x...            # destination (use your sponsor/new wallet address)
EXECUTOR_ADDRESS=0x...        # your deployed RescueExecutor contract address
TOKEN_DECIMALS=18
```

**Security rules:**
- Never commit `.env` to version control
- Never share private keys
- `SAFE_ADDRESS` should be a brand-new wallet the attacker has never seen

### 4. Run

```bash
bun start
```

## Revoke-Only Mode

To remove a malicious delegation without rescuing staked tokens, set `RESCUE_MODE=false` (or omit it) and run:

```bash
bun start
```

Only `PROVIDER_URL`, `DELEGATOR_PRIVATE_KEY`, and optionally `SPONSOR_PRIVATE_KEY` are required in this mode.

## Supported Networks

| Network | Chain ID | Notes |
|---|---|---|
| Ethereum Mainnet | 1 | Full EIP-7702 support |
| Sepolia Testnet | 11155111 | |
| Holesky Testnet | 17000 | |
| BSC Mainnet | 56 | BNB gas token |
| BSC Testnet | 97 | |

Other EIP-7702-compatible EVM chains work by setting `CHAIN_ID` and `PROVIDER_URL`.

## Project Structure

```
contracts/
  RescueExecutor.sol     Deploy this once per network
scripts/
  check-stakes.ts        Inspect stake positions & generate calldata
src/
  core/
    DelegationManager.ts Core logic — revoke & rescue
  types/index.ts         TypeScript types
  utils/                 Config, errors, helpers
index.ts                 CLI entry point
```

## License

[MIT](LICENSE)
