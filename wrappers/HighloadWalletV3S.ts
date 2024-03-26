import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider, Message,
    MessageRelaxed,
    OutAction,
    Sender,
    SendMode, storeMessage,
    storeMessageRelaxed,
    storeOutList,
    toNano,
    internal as internal_relaxed,
    OutActionSendMsg
} from '@ton/core';
// import { hex as CodeHex } from '../build/HighloadWalletV3S.compiled.json';
import { sign } from "ton-crypto";
import {OP} from "../tests/imports/const";
import { QueryIterator, maxQueryId } from "./QueryIterator";

// export const HighloadWalletV3SCode = Cell.fromBoc(Buffer.from(CodeHex, "hex"))[0]

export type HighloadWalletV3SConfig = {
    publicKey: Buffer,
    subwalletId: number,
    timeout: number
};


export function highloadWalletV3SConfigToCell(config: HighloadWalletV3SConfig): Cell {
    return beginCell()
          .storeBuffer(config.publicKey)
          .storeUint(config.subwalletId, 32)
          .storeUint(0, 1 + 1 + 40)
          .storeUint(config.timeout, 16)
          .endCell();
}

export class HighloadWalletV3S implements Contract {

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}


    static createFromAddress(address: Address) {
        return new HighloadWalletV3S(address);
    }


    static createFromConfig(config: HighloadWalletV3SConfig, code: Cell, workchain = 0) {
        const data = highloadWalletV3SConfigToCell(config);
        const init = { code, data };
        return new HighloadWalletV3S(contractAddress(workchain, init), init);
    }


    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }


    async sendExternalMessage(
        provider: ContractProvider,
        secretKey: Buffer,
        opts: {
            message: MessageRelaxed | Cell,
            mode: number,
            query_id: number | QueryIterator,
            createdAt: number,
            subwalletId: number,
        }
    ){
        let messageCell: Cell;

        if(Number(opts.query_id) > maxQueryId) {
            throw new TypeError(`Max query id: ${maxQueryId} < ${opts.query_id}`);
        }
        if (opts.message instanceof Cell) {
            messageCell = opts.message
        } else {
            const messageBuilder = beginCell();
            messageBuilder.store(storeMessageRelaxed(opts.message))
            messageCell = messageBuilder.endCell();
        }
        const messageInner = beginCell()
                            .storeRef(messageCell)
                            .storeUint(opts.mode, 8)
                            .storeUint(Number(opts.query_id), 24)
                            .storeUint(opts.createdAt, 40)
                            .storeUint(opts.subwalletId, 32)
                            .endCell();

        await provider.external(
            beginCell()
           .storeBuffer(sign(messageInner.hash(), secretKey))
           .storeRef(messageInner)
           .endCell()
        );
    }
    async sendBatch (provider: ContractProvider, secretKey: Buffer, messages: OutActionSendMsg[], subwallet: number, query_id: QueryIterator, createdAt?: number, value: bigint = 0n) {
        if(createdAt == undefined) {
            createdAt = Math.floor(Date.now() / 1000);
        }
        if(Number(query_id) > maxQueryId) {
            throw new TypeError(`Max query id: ${maxQueryId} < ${query_id}`);
        }
        return await this.sendExternalMessage(provider, secretKey, {
            message: this.packActions(messages, value, query_id),
            mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
            query_id: query_id,
            createdAt: createdAt,
            subwalletId: subwallet
        });
    }

    static createInternalTransferBody(opts: {
        actions: OutAction[] | Cell,
        queryId: number | QueryIterator,
    }) {
        let actionsCell: Cell;
        if (opts.actions instanceof Cell) {
            actionsCell = opts.actions;
        } else {
            if(opts.actions.length > 254) {
                throw TypeError("Max allowed action count is 254. Use packActions instead.");
            }
            const actionsBuilder = beginCell();
            storeOutList(opts.actions)(actionsBuilder);
            actionsCell = actionsBuilder.endCell();
        }
        return beginCell().storeUint(OP.InternalTransfer, 32)
                          .storeUint(Number(opts.queryId), 64)
                          .storeRef(actionsCell)
                          .endCell();


    }
    createInternalTransfer(opts: {
        actions:  OutAction[] | Cell
        queryId: number | QueryIterator,
        value: bigint
    }) {

        return internal_relaxed({
            to: this.address,
            value: opts.value,
            body: HighloadWalletV3S.createInternalTransferBody(opts)
        });
        /*beginCell()
            .storeUint(0x10, 6)
            .storeAddress(this.address)
            .storeCoins(opts.value)
            .storeUint(0, 107)
            .storeSlice(body.asSlice())
            .endCell();
            */
    }
    packActions(messages: OutAction[], value: bigint = toNano('1'), query_id: QueryIterator) {
        let batch: OutAction[];
        if(messages.length > 254) {
            batch = messages.slice(0, 253);
            batch.push({
                type: 'sendMsg',
                mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
                outMsg: this.packActions(messages.slice(253), value, query_id)
            });
        }
        else {
            batch = messages;
        }
        return this.createInternalTransfer({
            actions: batch,
            queryId: query_id,
            value
        });
    }


    async getPublicKey(provider: ContractProvider): Promise<Buffer> {
        const res = (await provider.get('get_public_key', [])).stack;
        const pubKeyU = res.readBigNumber();
        return Buffer.from(pubKeyU.toString(16).padStart(32 * 2, '0'), 'hex');
    }

    async getSubwalletId(provider: ContractProvider): Promise<number> {
        const res = (await provider.get('get_subwallet_id', [])).stack;
        return res.readNumber();
    }

    async getTimeout(provider: ContractProvider): Promise<number> {
        const res = (await provider.get('get_timeout', [])).stack;
        return res.readNumber();
    }

    async getLastCleaned(provider: ContractProvider): Promise<number> {
        const res = (await provider.get('get_last_cleaned', [])).stack;
        return res.readNumber();
    }

    async getProcessed(provider: ContractProvider, queryId: number | QueryIterator): Promise<boolean> {
        const res = (await provider.get('processed?', [{'type': 'int', 'value': BigInt(Number(queryId))}])).stack;
        return res.readBoolean();
    }
}
