interface ReadFirst<T> {
    key: "select";
    get select(): T;
    set [readSample.key](value: T | null);
}
declare const readSample: ReadFirst<number>;
declare const readNext: ReadFirst<string>;

interface WriteFirst<T> {
    key: "select";
    set select(value: T | null);
    get [writeSample.key](): T;
}
declare const writeSample: WriteFirst<number>;
declare const writeNext: WriteFirst<string>;
