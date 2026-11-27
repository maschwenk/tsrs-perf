// The class mapper resolves parameters at both ends of its list. The method's own U passes through it.
declare class Row<
    A0, A1, A2, A3, A4, A5, A6, A7,
    B0, B1, B2, B3, B4, B5, B6, B7,
    C0, C1, C2, C3, C4, C5, C6, C7,
    D0, D1, D2, D3, D4, D5, D6, D7
> {
    select<U>(u: U): [A0, C0, D7, U, A0];
}

declare const row: Row<
    0, 1, 2, 3, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 28, 29, 30, 31
>;

const selection = row.select("extra" as const);
const expected: [0, 16, 31, "extra", 0] = selection;
const swapped: [0, 31, 16, "extra", 0] = selection;
