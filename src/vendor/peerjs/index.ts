// claude-link's local entrypoint to the vendored PeerJS code.
export { Peer, type PeerOptions, type PeerEvents } from "./peer";
export type { DataConnection } from "./dataconnection/DataConnection";
export type { PeerJSOption, PeerConnectOption } from "./optionInterfaces";
export { LogLevel } from "./logger";
export {
	installNodeDataChannel,
	type InstallNodeDataChannelOptions,
} from "./nodeDataChannel";
export { PeerError } from "./peerError";
