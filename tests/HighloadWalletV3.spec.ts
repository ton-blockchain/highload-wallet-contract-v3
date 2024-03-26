import { Blockchain, EmulationError, SandboxContract, createShardAccount } from '@ton/sandbox';
import { beginCell, Cell, Address, OutActionSendMsg, SendMode, toNano, Dictionary, BitString, internal as internal_relaxed } from '@ton/core';
import { HighloadWalletV3 } from '../wrappers/HighloadWalletV3';
import '@ton/test-utils';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed } from "ton-crypto";
import { randomBytes } from "crypto";
import { SUBWALLET_ID } from "./imports/const";
import { Errors } from "./imports/const";
import { getRandomInt } from "../utils";
import { compile } from '@ton/blueprint';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { QueryIterator, maxShift } from '../wrappers/QueryIterator';


describe('HighloadWalletV3', () => {
    let keyPair: KeyPair;
    let code: Cell;

    let blockchain: Blockchain;
    let highloadWalletV3: SandboxContract<HighloadWalletV3>;
    let shouldRejectWith: (p: Promise<unknown>, code: number) => Promise<void>;
    let getContractData: (address: Address) => Promise<Cell>;

    beforeAll(async () => {
        keyPair = keyPairFromSeed(await getSecureRandomBytes(32));
        code    = await compile('HighloadWalletV3');
        shouldRejectWith = async (p, code) => {
            try {
                await p;
                throw new Error(`Should throw ${code}`);
            }
            catch(e: unknown) {
                if(e instanceof EmulationError) {
                    expect(e.exitCode !== undefined && e.exitCode == code).toBe(true);
                }
                else {
                    throw e;
                }
            }
        }
        getContractData = async (address: Address) => {
          const smc = await blockchain.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get data on inactive account");
          if(!smc.account.account.storage.state.state.data)
            throw("Data is not present");
          return smc.account.account.storage.state.state.data
        }
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1000;
        // blockchain.verbosity = {
        //     print: true,
        //     blockchainLogs: true,
        //     vmLogs: 'vm_logs',
        //     debugLogs: true,
        // }

        highloadWalletV3 = blockchain.openContract(
            HighloadWalletV3.createFromConfig(
                {
                    publicKey: keyPair.publicKey,
                    subwalletId: SUBWALLET_ID,
                    timeout: 128
                },
                code
            )
        );

        const deployer = await blockchain.treasury('deployer');

        const deployResult = await highloadWalletV3.sendDeploy(deployer.getSender(), toNano('999999'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: highloadWalletV3.address,
            deploy: true
        });
    });

    it('should deploy', async () => {
        expect(await highloadWalletV3.getPublicKey()).toEqual(keyPair.publicKey);
    });

    it('should pass check sign', async () => {
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        try {
            const testResult = await highloadWalletV3.sendExternalMessage(
                keyPair.secretKey,
                {
                    query_id: rndQuery,
                    createdAt: 1000,
                    actions: [],
                    subwalletId: SUBWALLET_ID
                }
            );

            expect(testResult.transactions).toHaveTransaction({
                to: highloadWalletV3.address,
                success: true
            });
        } catch (e: any) {
            console.log(e.vmLogs)
            // Otherwise test will never fail
            throw e;
        }
    });

    it('should fail check sign', async () => {
        let badKey: Buffer;
        // Just in case we win a lotto
        do {
            badKey = randomBytes(64);
        } while(badKey.equals(keyPair.secretKey));


        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            badKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        ), Errors.invalid_signature);
    });

    it('should fail subwallet check', async () => {
        let badSubwallet;

        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        const curSubwallet = await highloadWalletV3.getSubwalletId();
        expect(curSubwallet).toEqual(SUBWALLET_ID);
        do {
            badSubwallet = getRandomInt(0, 1000);
        } while(badSubwallet == curSubwallet);

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: badSubwallet
            }), Errors.invalid_subwallet);
    });

    it('should fail check created time', async () => {
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        const curTimeout = await highloadWalletV3.getTimeout();
        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000 - getRandomInt(curTimeout + 1, curTimeout + 200),
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        ), Errors.invalid_creation_time);
    });

    it('should fail check query_id in actual queries', async () => {
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));

        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        );
        expect(testResult.transactions).toHaveTransaction({
            to: highloadWalletV3.address,
            success: true
        });
        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(true);

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        ), Errors.already_executed)
    });
    it('should work max bitNumber = 1022', async () => {
        const rndShift = getRandomInt(0, maxShift);
        const maxBit   = 1022;
        const queryId  = (rndShift << 10) + maxBit;
        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                actions: [],
                subwalletId: SUBWALLET_ID
            })).resolves.not.toThrow(EmulationError);
        expect(await highloadWalletV3.getProcessed(queryId)).toBe(true);
    });

    it('should reject with bitNumber = 1023', async () => {
        const rndShift = getRandomInt(0, maxShift);
        const bitNum   = 1023;
        const queryId  = (rndShift << 10) + bitNum;

        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                actions: [],
                subwalletId: SUBWALLET_ID
            })).rejects.toThrow(EmulationError);

        expect(await highloadWalletV3.getProcessed(queryId)).toBe(false);
    });
    // Just in case
    it('should work with max shift = 16383', async () => {
        expect(maxShift).toEqual(16383);
        const rndBit = getRandomInt(0, 1022);
        const queryId  = (maxShift << 10) + rndBit;

        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                actions: [],
                subwalletId: SUBWALLET_ID
            })).resolves.not.toThrow(EmulationError);
    });
    it('should fail check query_id in old queries', async () => {
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));

        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        );
        expect(testResult.transactions).toHaveTransaction({
            to: highloadWalletV3.address,
            success: true
        });

        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(true);

        blockchain.now = 1000 + 100;

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1050,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        ), Errors.already_executed)
    });

    it('should be cleared queries hashmaps', async () => {

        let newQuery: QueryIterator;
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));

        const testResult1 = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        );
        expect(testResult1.transactions).toHaveTransaction({
            to: highloadWalletV3.address,
            success: true
        });

        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(true);
        blockchain.now = 1000 + 260;
        // is_processed should account for query expiery
        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(false);


        do {
            newQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        } while(Number(newQuery) == Number(rndQuery));



        const testResult2 = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1200,
                query_id: newQuery,
                actions: [],
                subwalletId: SUBWALLET_ID
            }
        );
        expect(testResult2.transactions).toHaveTransaction({
            to: highloadWalletV3.address,
            success: true
        });
        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(false);
        expect(await highloadWalletV3.getProcessed(Number(newQuery))).toBe(true);
        expect(await highloadWalletV3.getLastCleaned()).toEqual(testResult2.transactions[0].now);
    });

    it('should send ordinary transaction and set processed accordingly', async () => {
        const testBody   = beginCell().storeUint(getRandomInt(0, 1000000), 32).endCell();
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));

        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [{
                    type: 'sendMsg',
                    mode: SendMode.NONE,
                    outMsg: {
                        info: {
                            type: 'external-out',
                            createdAt: 0,
                            createdLt: 0n
                        },
                        body: testBody
                    }
                }],
                subwalletId: SUBWALLET_ID
            }
        );

        const sentTx = findTransactionRequired(testResult.transactions, {
            to: highloadWalletV3.address,
            success: true,
            outMessagesCount: 1,
            actionResultCode: 0,
        });
        expect(sentTx.externals.length).toBe(1);
        expect(sentTx.externals[0].body).toEqualCell(testBody);

        const processed = await highloadWalletV3.getProcessed(Number(rndQuery));
        expect(processed).toBe(true);
    });
    it('should handle max actions (255) in single batch', async () => {
        const baseInt = getRandomInt(0, 100000);
        const actions : OutActionSendMsg[] = new Array(255);
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));

        for(let i = 0; i < 255; i++) {
            actions[i] = {
                type: 'sendMsg',
                mode: SendMode.NONE,
                outMsg: {
                    info: {
                        type: 'external-out',
                        createdAt: blockchain.now!,
                        createdLt: blockchain.lt
                    },
                    body: beginCell().storeUint(baseInt + i, 32).endCell()
                }
            };
        }

        const res = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions,
                subwalletId: SUBWALLET_ID
            });

        const batchTx = findTransactionRequired(res.transactions, {
            on: highloadWalletV3.address,
            outMessagesCount: 255
        });

        expect(batchTx.externals.length).toBe(255);
        for(let i = 0; i < 255; i++) {
            expect(batchTx.externals[i].body).toEqualCell(actions[i].outMsg.body);
        }

        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(true);
    });
    // Could/should replace previous test?
    it('should be able to send internal messages', async () => {
        const actions : OutActionSendMsg[] = new Array(255);
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        const testAddr = randomAddress(0);
        // Let's make a mix to be tricky
        const internalCount = getRandomInt(100, 254);
        const externalCount = 255 - internalCount;

        for(let i = 0; i < 255; i++) {
            const msgBody = beginCell().storeUint(i, 32).endCell();
            if(i < externalCount) {
                actions[i] = {
                    type: 'sendMsg',
                    mode: SendMode.NONE,
                    outMsg: {
                        info: {
                            type: 'external-out',
                            createdAt: blockchain.now!,
                            createdLt: blockchain.lt
                        },
                        body: msgBody
                    }
                };
            }
            else {
                actions[i] = {
                    type: 'sendMsg',
                    mode: SendMode.NONE,
                    outMsg: internal_relaxed({
                        to: testAddr,
                        value: toNano('0.015'),
                        body: msgBody
                    })
                }
            }
        }

        const res = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions,
                subwalletId: SUBWALLET_ID
            });


        const batchTx = findTransactionRequired(res.transactions, {
            on: highloadWalletV3.address,
            outMessagesCount: 255
        });
        expect(batchTx.externals.length).toBe(externalCount);

        for(let i = 0; i < externalCount; i++) {
            expect(actions[i].outMsg.info.type == 'external-out').toBe(true);
            expect(batchTx.externals[i].body).toEqualCell(actions[i].outMsg.body);
        }
        for(let i = externalCount; i < internalCount; i++) {
            expect(actions[i].outMsg.info.type == 'internal').toBe(true);
            expect(res.transactions).toHaveTransaction({
                on: testAddr,
                from: highloadWalletV3.address,
                body: actions[i].outMsg.body
            });
        }
        expect(await highloadWalletV3.getProcessed(Number(rndQuery))).toBe(true);
    });
    it('queries dictionary with max keys should fit in credit limit', async () => {
        // 2 ** 14 - 1 = maxShift keys
        const rndQuery = new QueryIterator(getRandomInt(0, maxShift), getRandomInt(0, 1022));
        const newQueries = Dictionary.empty(Dictionary.Keys.Uint(14), Dictionary.Values.Cell());
        const padding = new BitString(Buffer.alloc(128, 0), 0, 1023 - 14);

        for(let i = 0; i < maxShift; i++) {
            newQueries.set(i, beginCell().storeUint(i, 14).storeBits(padding).endCell());
        }

        const smc = await blockchain.getContract(highloadWalletV3.address);
        const walletState = await getContractData(highloadWalletV3.address);
        const ws   = walletState.beginParse();
        const head = ws.loadBits(256 + 32); // pubkey + subwallet
        const tail = ws.skip(2 + 40).loadBits(16);

        const newState = beginCell()
                          .storeBits(head)
                          .storeDict(null)
                          .storeDict(newQueries)
                          .storeUint(2000, 40) // Make dictionary is not nulled
                          .storeBits(tail)
                        .endCell();

        await blockchain.setShardAccount(highloadWalletV3.address, createShardAccount({
            address: highloadWalletV3.address,
            code,
            data: newState,
            balance: smc.balance,
            workchain: 0
        }));

        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: rndQuery,
                actions: [{
                    type: 'sendMsg',
                    mode: SendMode.NONE,
                    outMsg: {
                        info: {
                            type: 'external-out',
                            createdAt: blockchain.now!,
                            createdLt: blockchain.lt
                        },
                        body: beginCell().storeUint(1234, 32).endCell(),
                    }}],
                subwalletId: SUBWALLET_ID
            })).resolves.not.toThrow();
    });
    it('should send hundred ordinary transactions', async () => {
        for (let x = 0; x < 10; x++) {
            if (x > 4) { blockchain.now = 1200; }
            for (let y = 0; y < 11; y++) {
                const testResult = await highloadWalletV3.sendExternalMessage(
                    keyPair.secretKey,
                    {
                        createdAt: x > 4 ? 1100  : 1000,
                        query_id: new QueryIterator(x, y < 5 ? 1022 - y : y),
                        actions: [{
                            type: 'sendMsg',
                            mode: SendMode.NONE,
                            outMsg: {
                                info: {
                                    type: 'external-out',
                                    createdAt: 0,
                                    createdLt: 0n
                                },
                                body: beginCell().endCell()
                            }
                        }],
                        subwalletId: SUBWALLET_ID
                    }
                );

                expect(testResult.transactions).toHaveTransaction({
                    to: highloadWalletV3.address,
                    success: true,
                    outMessagesCount: 1,
                    actionResultCode: 0
                });
              }
        }
    });
});
