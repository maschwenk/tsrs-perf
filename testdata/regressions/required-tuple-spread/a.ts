declare function append<T extends readonly unknown[]>(tail: T): [prefix?: 0, ...T];
declare const required: [middle: 1, last: 2];
declare const optional: [middle: 1, last?: 2];

const withRequired = append(required);
const withOptional = append(optional);
const withEmpty = append([] as const);

const acceptRequired: [0 | undefined, 1, 2] = withRequired;
const acceptOptional: [0 | undefined, 1, 2?] = withOptional;
const acceptEmpty: [0?] = withEmpty;
const showRequired: never = withRequired;
const showOptional: never = withOptional;
const showEmpty: never = withEmpty;
