# highload-wallet-contract-v3

⚠️ `timeout` must be greater then 0. We recommend using a timeout from 1 hour to 24 hours.

⚠️ This highload-wallet has a limit of 8380415 messages per timeout. If you fill the dictionary completely during the timeout, you will have to wait for the timeout before the dictionary is freed.

⚠️ Use an `subwallet_id` different from the `subwallet_id`'s of other contracts (regular wallets or vesting wallets). We recommend using `0x1oad` as `subwallet_id`.

`query_id` is a composite ID consisting of a shift ([0 .. 8191]) and a bitnumber ([0 .. 1022]). Use `HighloadQueryId.ts` wrapper.

`npm install`

Build:

`npm run build`

Test:

`npm run test`

Author: [Andrew Gutarev](https://github.com/pyAndr3w)