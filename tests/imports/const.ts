export const SUBWALLET_ID = 239;

export enum OP {
    InternalTransfer = 0xae42e5a4
}
export abstract class Errors {
    static invalid_signature = 33;
    static invalid_subwallet = 34;
    static invalid_creation_time = 35;
    static already_executed = 36;
}
