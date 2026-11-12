export const getItemAsync = async (k: string) => globalThis.localStorage?.getItem(k) ?? null;
export const setItemAsync = async (k: string, v: string) => globalThis.localStorage?.setItem(k, v);
export const deleteItemAsync = async (k: string) => globalThis.localStorage?.removeItem(k);
