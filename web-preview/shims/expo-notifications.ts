// Web preview: push notifications are phone-only, so these are no-ops.
export const setNotificationHandler = () => undefined;
export const setNotificationChannelAsync = async () => null;
export const getPermissionsAsync = async () => ({ status: "denied" });
export const requestPermissionsAsync = async () => ({ status: "denied" });
export const getExpoPushTokenAsync = async () => ({ data: "" });
export const getLastNotificationResponseAsync = async () => null;
export const addNotificationResponseReceivedListener = () => ({ remove: () => undefined });
export const AndroidImportance = { MAX: 5, HIGH: 4, DEFAULT: 3 };
