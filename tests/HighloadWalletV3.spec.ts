import { Blockchain, EmulationError, SandboxContract, createShardAccount, internal } from '@ton/sandbox';
import { beginCell, Cell, SendMode, toNano, Address, internal as internal_relaxed, Dictionary, BitString, OutActionSendMsg } from '@ton/core';
import {HighloadWalletV3, TIMEOUT_SIZE, TIMESTAMP_SIZE} from '../wrappers/HighloadWalletV3';
import '@ton/test-utils';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed } from "ton-crypto";
import { randomBytes } from "crypto";
import {SUBWALLET_ID, Errors, DEFAULT_TIMEOUT, maxKeyCount, maxShift} from "./imports/const";
import { compile } from '@ton/blueprint';
import { getRandomInt } from '../utils';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { MsgGenerator } from '../wrappers/MsgGenerator';
import {HighloadQueryId} from "../wrappers/HighloadQueryId";


describe('HighloadWalletV3', () => {
    let keyPair: KeyPair;
    let code: Cell;

    let blockchain: Blockchain;
    let highloadWalletV3: SandboxContract<HighloadWalletV3>;

    let shouldRejectWith: (p: Promise<unknown>, code: number) => Promise<void>;
    let getContractData: (address: Address) => Promise<Cell>;
    let getContractCode: (address: Address) => Promise<Cell>;

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
        getContractCode = async (address: Address) => {
          const smc = await blockchain.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get code on inactive account");
          if(!smc.account.account.storage.state.state.code)
            throw("Code is not present");
          return smc.account.account.storage.state.state.code;
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
                    timeout: DEFAULT_TIMEOUT
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
        try {
            const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: HighloadQueryId.fromQueryId(0n), value: 0n})
            const rndShift   = getRandomInt(0, maxShift);
            const rndBitNum  = getRandomInt(0, 1022);

            const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

            const testResult = await highloadWalletV3.sendExternalMessage(
                keyPair.secretKey,
                {
                    createdAt: 1000,
                    query_id: queryId,
                    message,
                    mode: 128,
                    subwalletId: SUBWALLET_ID,
                    timeout: DEFAULT_TIMEOUT
                }
            );

            expect(testResult.transactions).toHaveTransaction({
                from: highloadWalletV3.address,
                to: highloadWalletV3.address,
                success: true,
            });
        } catch (e: any) {
            console.log(e.vmLogs)
            throw(e);
        }

    });


    it('should fail check sign', async () => {
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: HighloadQueryId.fromQueryId(0n), value: 0n})

        let badKey: Buffer;
        // Just in case we win a lotto
        do {
            badKey = randomBytes(64);
        } while(badKey.equals(keyPair.secretKey));

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            badKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        ), Errors.invalid_signature)
    });

    it('should fail subwallet check', async () => {
        let badSubwallet;

        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: HighloadQueryId.fromQueryId(0n), value: 0n})
        const curSubwallet= await highloadWalletV3.getSubwalletId();
        expect(curSubwallet).toEqual(SUBWALLET_ID);

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        do {
            badSubwallet = getRandomInt(0, 1000);
        } while(badSubwallet == curSubwallet);

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                mode: 128,
                message,
                subwalletId: badSubwallet,
                timeout: DEFAULT_TIMEOUT
            }), Errors.invalid_subwallet);
    });
    it('should fail check created time', async () => {
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: HighloadQueryId.fromQueryId(0n), value: 0n})

        const curTimeout = await highloadWalletV3.getTimeout();

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));


        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000 - getRandomInt(curTimeout + 1, curTimeout + 200),
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        ), Errors.invalid_creation_time);
    });

    it('should fail check query_id in actual queries', async () => {
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: new HighloadQueryId(), value: 0n})

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );
        expect(testResult.transactions).toHaveTransaction({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            success: true
        });
        expect(await highloadWalletV3.getProcessed(queryId)).toBe(true);

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        ), Errors.already_executed);
    });
    it('should work with max bitNumber = 1022', async () => {
        // bitNumber is a low part of 24 bit query_id
        const shift = getRandomInt(0, maxShift);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(shift), BigInt(1022));

        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message: internal_relaxed({
                    to: randomAddress(0),
                    value: 0n,
                }),
                mode: 0,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            })).resolves.not.toThrow(EmulationError);
    });

    it('should reject bitNumber = 1023', async () => {
        // bitNumber is a low part of 24 bit query_id
        const shift = getRandomInt(0, maxShift);
        const queryId = BigInt((shift << 10) + 1023);

        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message: internal_relaxed({
                    to: randomAddress(0),
                    value: 0n,
                }),
                mode: 0,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            })).rejects.toThrow(EmulationError);
    });
    it('should work with max shift = maxShift', async () => {
        // Shift is a high part of 24 bit query_id
        const rndBitNum = getRandomInt(0, 1022);
        const qIter =  HighloadQueryId.fromShiftAndBitNumber(BigInt(maxShift), BigInt(rndBitNum));
        await expect(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: qIter,
                message: internal_relaxed({
                    to: randomAddress(0),
                    value: 0n,
                }),
                mode: 0,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            })).resolves.not.toThrow(EmulationError);
    });

    it('should fail check query_id in old queries', async () => {
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: new HighloadQueryId(), value: 0n})

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );
        expect(testResult.transactions).toHaveTransaction({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            success: true
        });

        blockchain.now = 1000 + 100;
        expect(await highloadWalletV3.getProcessed(queryId)).toBe(true);

        await shouldRejectWith(highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1050,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        ), Errors.already_executed)
    });

    it('should be cleared queries hashmaps', async () => {
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: new HighloadQueryId(), value: 0n})

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        const testResult1 = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );
        expect(testResult1.transactions).toHaveTransaction({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            success: true
        });

        expect(await highloadWalletV3.getProcessed(queryId)).toBe(true);
        blockchain.now = 1000 + 260;
        // get_is_processed should account for query expiery
        expect(await highloadWalletV3.getProcessed(queryId)).toBe(false);

        const newShift   = getRandomInt(0, maxShift);
        const newBitNum  = getRandomInt(0, 1022);

        const newQueryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(newShift), BigInt(newBitNum));

        const testResult2 = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1200,
                query_id: newQueryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );
        expect(testResult2.transactions).toHaveTransaction({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            success: true
        });
        expect(await highloadWalletV3.getProcessed(queryId)).toBe(false);
        expect(await highloadWalletV3.getProcessed(newQueryId)).toBe(true);
        expect(await highloadWalletV3.getLastCleaned()).toEqual(testResult2.transactions[0].now);
    });
    it('queries dictionary with max keys should fit in credit limit', async () => {
        // 2 ** 14 = 16384 keys
        // Artificial situation where both dict's get looked up
        const message = highloadWalletV3.createInternalTransfer({actions: [], queryId: new HighloadQueryId(), value: 0n})
        const newQueries = Dictionary.empty(Dictionary.Keys.Uint(13), Dictionary.Values.Cell());
        const padding = new BitString(Buffer.alloc(128, 0), 0, 1023 - 13);

        for(let i = 0; i < maxKeyCount; i++) {
            newQueries.set(i, beginCell().storeUint(i, 13).storeBits(padding).endCell());
        }

        const oldQueries = Dictionary.empty(Dictionary.Keys.Uint(13), Dictionary.Values.Cell());
        for(let i = 0; i < maxKeyCount; i++) {
            oldQueries.set(i, beginCell().storeBits(padding).storeUint(i, 13).endCell());
        }

        const smc = await blockchain.getContract(highloadWalletV3.address);
        const walletState = await getContractData(highloadWalletV3.address);
        const ws   = walletState.beginParse();
        const head = ws.loadBits(256 + 32); // pubkey + subwallet
        const tail = ws.skip(2 + TIMESTAMP_SIZE).loadBits(TIMEOUT_SIZE);

        const newState = beginCell()
                          .storeBits(head)
                          .storeDict(oldQueries)
                          .storeDict(newQueries)
                          .storeUint(blockchain.now!, TIMESTAMP_SIZE) // DO NOT CLEAN
                          .storeBits(tail)
                        .endCell();

        await blockchain.setShardAccount(highloadWalletV3.address, createShardAccount({
            address: highloadWalletV3.address,
            code,
            data: newState,
            balance: smc.balance,
            workchain: 0
        }));

        const rndShift   = maxShift;
        const rndBitNum  = 700;

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));
        const res     = highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            });
        await expect(res).resolves.not.toThrow();
        expect((await res).transactions).toHaveTransaction({
            on: highloadWalletV3.address,
            aborted: false,
            outMessagesCount: 1
        });
    });
    it('should send internal message', async () => {
        const testAddr   = randomAddress(0);
        const testBody   = beginCell().storeUint(getRandomInt(0, 1000000), 32).endCell();

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = 1022;

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        let res = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                query_id: queryId,
                message: internal_relaxed({
                    to: testAddr,
                    bounce: false,
                    value: toNano('123'),
                    body: testBody
                }),
                createdAt: 1000,
                mode: SendMode.PAY_GAS_SEPARATELY,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
        });
        expect(res.transactions).toHaveTransaction({
            on: testAddr,
            from: highloadWalletV3.address,
            value: toNano('123'),
            body: testBody
        });

        expect(await highloadWalletV3.getProcessed(queryId)).toBe(true);

        // second transfer rejected

        let fail = false;
        try {
            await highloadWalletV3.sendExternalMessage(
                keyPair.secretKey,
                {
                    query_id: queryId,
                    message: internal_relaxed({
                        to: testAddr,
                        bounce: false,
                        value: toNano('123'),
                        body: testBody
                    }),
                    createdAt: 1000,
                    mode: SendMode.PAY_GAS_SEPARATELY,
                    subwalletId: SUBWALLET_ID,
                    timeout: DEFAULT_TIMEOUT
                });
        } catch (e) {
            fail = true;
        }

        expect(fail).toBe(true);
    });
    it('should ignore set_code action', async () => {
        const mockCode   = beginCell().storeUint(getRandomInt(0, 1000000), 32).endCell();
        const testBody   = beginCell().storeUint(getRandomInt(0, 1000000), 32).endCell();
        const testAddr   = randomAddress();

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        // In case test suite is broken
        expect(await getContractCode(highloadWalletV3.address)).toEqualCell(code);
        const message = highloadWalletV3.createInternalTransfer({
            actions: [{
                type: 'setCode',
                newCode: mockCode
            },
            {
                type: 'sendMsg',
                mode: SendMode.PAY_GAS_SEPARATELY,
                outMsg: internal_relaxed({
                    to: testAddr,
                    value: toNano('0.1'),
                    body: testBody
                })
            }],
            queryId: HighloadQueryId.fromQueryId(123n),
            value: 0n
        });

        const res = await highloadWalletV3.sendExternalMessage(keyPair.secretKey, {
            createdAt: 1000,
            query_id: queryId,
            message,
            mode: 128,
            subwalletId: SUBWALLET_ID,
            timeout: DEFAULT_TIMEOUT
        });

        // Code should not change
        expect(await getContractCode(highloadWalletV3.address)).toEqualCell(code);
        // Rest of the action pack should execute
        expect(res.transactions).toHaveTransaction({
            from: highloadWalletV3.address,
            to: testAddr,
            body: testBody,
            value: toNano('0.1')
        });
    });
    it('should send external message', async () => {
        const testBody   = beginCell().storeUint(getRandomInt(0, 1000000), 32).endCell();

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));

        const message = highloadWalletV3.createInternalTransfer({actions: [{
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
                }], queryId: new HighloadQueryId(), value: 0n})
        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: queryId,
                message,
                mode: 128,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );

        const sentTx = findTransactionRequired(testResult.transactions, {
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            success: true,
            outMessagesCount: 1,
            actionResultCode: 0
        });

        expect(sentTx.externals.length).toBe(1);
        expect(sentTx.externals[0].body).toEqualCell(testBody);

        const processed = await highloadWalletV3.getProcessed(queryId);
        expect(processed).toBe(true);
    });
    it('should handle 254 actions in one go', async () => {
        const curQuery = new HighloadQueryId();
        let outMsgs: OutActionSendMsg[] = new Array(254);

        for(let i = 0; i < 254; i++) {
            outMsgs[i] = {
                type: 'sendMsg',
                mode: SendMode.NONE,
                outMsg: internal_relaxed({
                    to: randomAddress(),
                    value: toNano('0.015'),
                    body: beginCell().storeUint(i, 32).endCell()
                }),
            }
        }

        const res = await highloadWalletV3.sendBatch(keyPair.secretKey, outMsgs, SUBWALLET_ID, curQuery, DEFAULT_TIMEOUT, 1000);

        expect(res.transactions).toHaveTransaction({
            on: highloadWalletV3.address,
            outMessagesCount: 254
        });
        for(let i = 0; i < 254; i++) {
            expect(res.transactions).toHaveTransaction({
                from: highloadWalletV3.address,
                body: outMsgs[i].outMsg.body
            })
        }
        expect(await highloadWalletV3.getProcessed(curQuery)).toBe(true);
    });
    it('should be able to go beyond 255 messages with chained internal_transfer', async () => {
        const msgCount  = getRandomInt(256, 507);
        const msgs : OutActionSendMsg[] = new Array(msgCount);
        const curQuery = new HighloadQueryId();

        for(let i = 0; i < msgCount; i++) {
            msgs[i] = {
                type: 'sendMsg',
                mode: SendMode.PAY_GAS_SEPARATELY,
                outMsg: internal_relaxed({
                    to: randomAddress(0),
                    value: toNano('0.015'),
                    body: beginCell().storeUint(i, 32).endCell()
                })
            };
        }

        const res = await highloadWalletV3.sendBatch(keyPair.secretKey, msgs, SUBWALLET_ID, curQuery, DEFAULT_TIMEOUT, 1000);

        expect(res.transactions).toHaveTransaction({
            on: highloadWalletV3.address,
            outMessagesCount: 254
        });
        expect(res.transactions).toHaveTransaction({
            on: highloadWalletV3.address,
            outMessagesCount: msgCount - 253
        });
        for(let i = 0; i < msgCount; i++) {
            expect(res.transactions).toHaveTransaction({
                from: highloadWalletV3.address,
                body: msgs[i].outMsg.body
            });
        }
        expect(await highloadWalletV3.getProcessed(curQuery)).toBe(true);
    });
    it('should ignore internal transfer from address different from self', async () => {
        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));
        const testAddr   = randomAddress(0);

        const transferBody = HighloadWalletV3.createInternalTransferBody({
            queryId,
            actions: [{
                type: 'sendMsg',
                mode: SendMode.PAY_GAS_SEPARATELY,
                outMsg: internal_relaxed({
                    to: testAddr,
                    value: toNano('1000')
                })
            }]});

        let res = await blockchain.sendMessage(internal({
            from: testAddr,
            to: highloadWalletV3.address,
            value: toNano('1'),
            body: transferBody
        }));

        expect(res.transactions).not.toHaveTransaction({
            on: testAddr,
            from: highloadWalletV3.address,
            value: toNano('1000')
        });

        // Make sure we failed because of source address

        res = await blockchain.sendMessage(internal({
            from: highloadWalletV3.address, // Self
            to: highloadWalletV3.address,
            value: toNano('1'),
            body: transferBody
        }));
        expect(res.transactions).toHaveTransaction({
            on: testAddr,
            from: highloadWalletV3.address,
            value: toNano('1000')
        });
    });
    it('should ignore bounced messages', async () => {

        const rndShift   = getRandomInt(0, maxShift);
        const rndBitNum  = getRandomInt(0, 1022);

        const queryId = HighloadQueryId.fromShiftAndBitNumber(BigInt(rndShift), BigInt(rndBitNum));
        const testAddr   = randomAddress(0);

        const transferBody = HighloadWalletV3.createInternalTransferBody({
            queryId,
            actions: [{
                type: 'sendMsg',
                mode: SendMode.PAY_GAS_SEPARATELY,
                outMsg: internal_relaxed({
                    to: testAddr,
                    value: toNano('1000')
                })
            }]});
        // Let's be tricky and send bounced message from trusted address
        let res = await blockchain.sendMessage(internal({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            body: transferBody,
            value: toNano('1'),
            bounced: true
        }));

        expect(res.transactions).not.toHaveTransaction({
            on: testAddr,
            from: highloadWalletV3.address,
            value: toNano('1000')
        });

        // Make sure we failed because of bounced flag

        res = await blockchain.sendMessage(internal({
            from: highloadWalletV3.address,
            to: highloadWalletV3.address,
            body: transferBody,
            value: toNano('1'),
            bounced: false
        }));

        expect(res.transactions).toHaveTransaction({
            on: testAddr,
            from: highloadWalletV3.address,
            value: toNano('1000')
        });
    });
    it('should ignore invalid message in payload', async () => {
        const testAddr     = randomAddress(0);
        const badGenerator = new MsgGenerator(0);
        let queryIter    = new HighloadQueryId();

        for(let badMsg of badGenerator.generateBadMsg()) {
            const res = await highloadWalletV3.sendExternalMessage(
                keyPair.secretKey,
                {
                    mode: SendMode.NONE,
                    message: badMsg,
                    query_id: queryIter,
                    subwalletId: SUBWALLET_ID,
                    createdAt: 1000,
                    timeout: DEFAULT_TIMEOUT
                });
            expect(res.transactions).toHaveTransaction({
                on: highloadWalletV3.address,
                success: true, // Compute phase has to succeed
                outMessagesCount: 0
            });
            // Expect query to be processed
            expect(await highloadWalletV3.getProcessed(queryIter)).toBe(true);
            queryIter = queryIter.getNext();
        }
    });
    it('timeout replay attack', async () => {
        /*
         * Timeout is not part of the external
         * So in theory one could deploy contract with
         * different timeout without thinking too much.
         * This opens up avenue for replay attack.
         * So, at every deploy one should always change key or subwallet id
        */
        const deployer  = await blockchain.treasury('new_deployer');
        const attacker  = await blockchain.treasury('attacker');

        // Same contract different timeout
        const newWallet = blockchain.openContract(
            HighloadWalletV3.createFromConfig(
                {
                    publicKey: keyPair.publicKey,
                    subwalletId: SUBWALLET_ID,
                    timeout: 1234,
                },
                code
            )
        );

        let res = await newWallet.sendDeploy(deployer.getSender(), toNano('1000'));
        expect(res.transactions).toHaveTransaction({
            on: newWallet.address,
            deploy: true,
            success: true
        });

        // So attacker requested legit withdraw on the exchange
        const legitResp = await highloadWalletV3.sendExternalMessage(keyPair.secretKey, {
            createdAt: 1000,
            query_id: new HighloadQueryId(),
            mode: SendMode.PAY_GAS_SEPARATELY,
            subwalletId: SUBWALLET_ID,
            timeout: DEFAULT_TIMEOUT,
            message: internal_relaxed({
                to: attacker.address,
                value: toNano('10')
            })
        });

        const legitTx = findTransactionRequired(legitResp.transactions, {
            on: highloadWalletV3.address,
            outMessagesCount: 1
        });

        expect(legitResp.transactions).toHaveTransaction({
            on: attacker.address,
            value: toNano('10')
        });

        // And now can replay it on contract with different timeout
        const replyExt = legitTx.inMessage!;
        if(replyExt.info.type !== 'external-in') {
            throw TypeError("No way");
        }
        // Replace dest
        replyExt.info = {
            ...replyExt.info,
            dest: newWallet.address
        };
        let fail = false;
        try {
            const reply = await blockchain.sendMessage(replyExt);
        } catch (e) {
            fail = true;
        }

        expect(fail).toBe(true);
    });
    it('should work replay protection, but dont send message', async () => {
        const testResult = await highloadWalletV3.sendExternalMessage(
            keyPair.secretKey,
            {
                createdAt: 1000,
                query_id: new HighloadQueryId(),
                message: beginCell().storeUint(239, 17).endCell(),
                mode: 2,
                subwalletId: SUBWALLET_ID,
                timeout: DEFAULT_TIMEOUT
            }
        );

        expect(testResult.transactions).toHaveTransaction({
            to: highloadWalletV3.address,
            success: true,
            outMessagesCount: 0,
            actionResultCode: 0
        });
    });
});
