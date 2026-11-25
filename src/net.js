// Point unique d'accès au réseau : les tests le remplacent par des services simulés.
let impl = (...a) => globalThis.fetch(...a);
export const net = { fetch: (...a) => impl(...a) };
export const setFetch = (f) => { impl = f; };
export const resetFetch = () => { impl = (...a) => globalThis.fetch(...a); };
