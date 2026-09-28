/** `{ [key]: value }`, or nothing when there is no value: an optional field spread into an object. */
function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
export { present };
