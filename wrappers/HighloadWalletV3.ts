import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    OutAction,
    Sender,
    SendMode,
    storeOutList
} from '@ton/core';
// import { hex as CodeHex } from '../build/HighloadWalletV3.compiled.json';
import { sign } from "ton-crypto";
import { QueryIterator } from './QueryIterator';

// export const HighloadWalletV3Code = Cell.fromBoc(Buffer.from(CodeHex, "hex"))[0]

export type HighloadWalletV3Config = {
    publicKey: Buffer,
    subwalletId: number,
    timeout: number
};


export function highloadWalletV3ConfigToCell(config: HighloadWalletV3Config): Cell {
    return beginCell()
          .storeBuffer(config.publicKey)
          .storeUint(config.subwalletId, 32)
          .storeUint(0, 1 + 1 + 40)
          .storeUint(config.timeout, 16)
          .endCell();
}


export class HighloadWalletV3 implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}


    static createFromAddress(address: Address) {
        return new HighloadWalletV3(address);
    }


    static createFromConfig(config: HighloadWalletV3Config, code: Cell, workchain = 0) {
        const data = highloadWalletV3ConfigToCell(config);
        const init = { code, data };
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
            query_id: number | QueryIterator,
            createdAt: number,
            subwalletId: number,
            actions: OutAction[] | Cell
        }
    ){
        let actionsCell: Cell;
        if (opts.actions instanceof Cell) {
            actionsCell = opts.actions
        } else {
            const actionsBuilder = beginCell();
            storeOutList(opts.actions)(actionsBuilder);
            actionsCell = actionsBuilder.endCell();
        }
        const messageInner = beginCell()
                            .storeUint(Number(opts.query_id), 24)
                            .storeUint(opts.createdAt, 40)
                            .storeUint(opts.subwalletId, 32)
                            .storeRef(actionsCell)
                            .endCell();

        await provider.external(
            beginCell()
           .storeBuffer(sign(messageInner.hash(), secretKey))
           .storeRef(messageInner)
           .endCell()
        );
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
