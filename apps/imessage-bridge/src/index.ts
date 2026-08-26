export { createBridge } from './bridge.js';
export type { Bridge, BridgeOverrides } from './bridge.js';
export { loadBridgeConfig } from './config.js';
export type { BridgeConfig } from './config.js';
export { BridgeError } from './errors.js';
export { normalizeHandle, handlesMatch, isEmailHandle } from './handles.js';
export type { ImsgRunner, ImsgResult } from './imsg.js';
export type { ContactSource, RawContact } from './contacts.js';
export { createBridgeServer } from './server.js';
