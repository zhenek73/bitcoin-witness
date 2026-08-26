# Deploying to EOS mainnet

`cleos` has no usable Windows build and the Leap Docker image is not publicly pullable, so this
deploys with [`@wharfkit/antelope`](https://wharfkit.com) instead — plain Node, no toolchain.

## What it does

Three steps, each of which inspects the chain first and skips itself if already done. Re-running
after a partial failure is safe.

1. **auth** — sets `active` to the new key **and** grants `btcwitness11@eosio.code`, in a single
   `updateauth`. Doing both at once matters: `updateauth` replaces the permission wholesale, so
   rotating the key in a separate later transaction would silently wipe `eosio.code` and leave the
   contract unable to send its inline action to `evm.xsat`. Signed by `owner`.
2. **ram** — buys RAM for the contract. It has no tables of its own, so this only covers code and
   ABI and will not grow with use. Paid by `PAYER_ACCOUNT`.
3. **code** — `setcode` + `setabi` in one transaction. Signed by the new `active` key.

## Running it

```bash
npm install
cp .env.example .env      # fill in the keys
npm run check             # read-only: reports what still needs doing
npm run deploy            # runs the pending steps
node deploy.mjs --step auth   # or one step at a time
```

`--check` signs nothing and is safe to run at any point.

## Keys

Keys are read from `.env`, used to sign locally, and never printed or transmitted anywhere except
as signatures. `.env` is gitignored. `owner` stays on the original key as the recovery path — if
anything goes wrong with `active`, you can always rewrite it.

## CPU

Both accounts have effectively no staked CPU, and staking is no longer a practical way to get it
on EOS — for scale, an account with ~22,000 EOS staked has about 20 ms. Use PowerUp (cheap while
the network sits near 3% utilization) or let Greymass Fuel cosign. RAM and NET behave normally;
only CPU has this quirk.
