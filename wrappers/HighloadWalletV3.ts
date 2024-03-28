import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    internal as internal_relaxed,
    MessageRelaxed,
    OutAction,
    OutActionSendMsg,
    Sender,
    SendMode,
    storeMessageRelaxed,
    storeOutList,
    toNano
} from '@ton/core';
// import { hex as CodeHex } from '../build/HighloadWalletV3.compiled.json';
import {sign} from "ton-crypto";
import {OP} from "../tests/imports/const";
import {HighloadQueryId} from "./HighloadQueryId";

// export const HighloadWalletV3Code = Cell.fromBoc(Buffer.from(CodeHex, "hex"))[0]

export type HighloadWalletV3Config = {
    publicKey: Buffer,
    subwalletId: number,
    timeout: number
};


export const TIMESTAMP_SIZE = 64;
export const TIMEOUT_SIZE = 22;

export function highloadWalletV3ConfigToCell(config: HighloadWalletV3Config): Cell {
    return beginCell()
        .storeBuffer(config.publicKey)
        .storeUint(config.subwalletId, 32)
        .storeUint(0, 1 + 1 + TIMESTAMP_SIZE)
        .storeUint(config.timeout, TIMEOUT_SIZE)
        .endCell();
}

export class HighloadWalletV3 implements Contract {

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {
    }

    static createFromAddress(address: Address) {
        return new HighloadWalletV3(address);
    }

    static createFromConfig(config: HighloadWalletV3Config, code: Cell, workchain = 0) {
        const data = highloadWalletV3ConfigToCell(config);
        const init = {code, data};
        return new HighloadWalletV3(contractAddress(workchain, init), init);
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
            query_id: bigint | HighloadQueryId,
            createdAt: number,
            subwalletId: number,
            timeout: number,
        }
    ) {
        let messageCell: Cell;

        if (opts.message instanceof Cell) {
            messageCell = opts.message
        } else {
            const messageBuilder = beginCell();
            messageBuilder.store(storeMessageRelaxed(opts.message))
            messageCell = messageBuilder.endCell();
        }

        const queryId =  (opts.query_id instanceof HighloadQueryId) ? opts.query_id.getQueryId() : opts.query_id;

        const messageInner = beginCell()
            .storeUint(opts.subwalletId, 32)
            .storeRef(messageCell)
            .storeUint(opts.mode, 8)
            .storeUint(queryId, 23)
            .storeUint(opts.createdAt, TIMESTAMP_SIZE)
            .storeUint(opts.timeout, TIMEOUT_SIZE)
            .endCell();

        await provider.external(
            beginCell()
                .storeBuffer(sign(messageInner.hash(), secretKey))
                .storeRef(messageInner)
                .endCell()
        );
    }

    async sendBatch(provider: ContractProvider, secretKey: Buffer, messages: OutActionSendMsg[], subwallet: number, query_id: HighloadQueryId, timeout: number, createdAt?: number, value: bigint = 0n) {
        if (createdAt == undefined) {
            createdAt = Math.floor(Date.now() / 1000);
        }
        return await this.sendExternalMessage(provider, secretKey, {
            message: this.packActions(messages, value, query_id),
            mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
            query_id: query_id,
            createdAt: createdAt,
            subwalletId: subwallet,
            timeout: timeout
        });
    }

    static createInternalTransferBody(opts: {
        actions: OutAction[] | Cell,
        queryId: HighloadQueryId,
    }) {
        let actionsCell: Cell;
        if (opts.actions instanceof Cell) {
            actionsCell = opts.actions;
        } else {
            if (opts.actions.length > 254) {
                throw TypeError("Max allowed action count is 254. Use packActions instead.");
            }
            const actionsBuilder = beginCell();
            storeOutList(opts.actions)(actionsBuilder);
            actionsCell = actionsBuilder.endCell();
        }
        return beginCell().storeUint(OP.InternalTransfer, 32)
            .storeUint(opts.queryId.getQueryId(), 64)
            .storeRef(actionsCell)
            .endCell();


    }

    createInternalTransfer(opts: {
        actions: OutAction[] | Cell
        queryId: HighloadQueryId,
        value: bigint
    }) {

        return internal_relaxed({
            to: this.address,
            value: opts.value,
            body: HighloadWalletV3.createInternalTransferBody(opts)
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

    packActions(messages: OutAction[], value: bigint = toNano('1'), query_id: HighloadQueryId) {
        let batch: OutAction[];
        if (messages.length > 254) {
            batch = messages.slice(0, 253);
            batch.push({
                type: 'sendMsg',
                mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
                outMsg: this.packActions(messages.slice(253), value, query_id)
            });
        } else {
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
        const res = (await provider.get('get_last_clean_time', [])).stack;
        return res.readNumber();
    }

    async getProcessed(provider: ContractProvider, queryId: HighloadQueryId, needClean = true): Promise<boolean> {
        const res = (await provider.get('processed?', [{'type': 'int', 'value': queryId.getQueryId()}, {
            'type': 'int',
            'value': needClean ? -1n : 0n
        }])).stack;
        return res.readBoolean();
    }
}
