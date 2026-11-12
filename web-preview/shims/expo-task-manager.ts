const tasks: Record<string, (b: { data: unknown; error: unknown }) => unknown> = {};
export function defineTask(name: string, fn: (b: { data: unknown; error: unknown }) => unknown) { tasks[name] = fn; }
export const isTaskRegisteredAsync = async () => false;
export const unregisterAllTasksAsync = async () => undefined;
export const __run = (name: string, data: unknown) => tasks[name]?.({ data, error: null });
