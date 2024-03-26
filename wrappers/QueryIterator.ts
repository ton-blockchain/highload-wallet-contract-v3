export const maxKeyCount   = (1 << 14); //That is max key count not max key value
export const maxShift      = maxKeyCount - 1;
export const maxQueryCount = maxKeyCount * 1023; // Therefore value count
export const maxQueryId    = (maxShift << 10) + 1022;

export class QueryIterator {
    protected shift: number;
    protected bitnumber: number;

    constructor(shift: number = 0, bitnumber: number = 0) {
        this.shift     = shift;
        this.bitnumber = bitnumber;
    }
    // You use this when constructing from sequential counter
    static fromCounter(counter: number) {
        let curShift: number;
        let curBn: number;
        if(counter == 0) {
            curShift = 0;
            curBn    = 0;
        }
        else {
            const base = counter % maxQueryCount;
            curShift   = Math.floor(base / 1023);
            curBn      = base % 1023;
        }
        return new QueryIterator(curShift, curBn);
    }
    // From query id in 24-bit contract format
    static fromQueryId(query_id: number) {
        if(query_id > maxQueryId) {
            throw new TypeError(`${query_id} > ${maxQueryId}`);
        }
        return new QueryIterator(query_id >> 10, query_id & 1023);
    }
    
    valueOf() {
        return (this.shift << 10) + this.bitnumber;
    }
    next() {
        this.bitnumber = (this.bitnumber + 1) % 1023;
        // If bitnumbe overflowed
        if(this.bitnumber == 0) {
            this.shift = (this.shift + 1) % maxKeyCount;
            // Should we throw exception on reaching max?
        }
        return this.valueOf();
    }
    peekNext() {
        let peekShift: number;
        const peekBit = (this.bitnumber + 1) % 1023;
        // If bitnumbe overflowed
        if(peekBit == 0) {
            peekShift = (this.shift + 1) % maxKeyCount;
        }
        else {
            peekShift = this.shift;
        }
        return (peekShift << 10) + peekBit;
    }
}
