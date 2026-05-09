import nodeDataChannelPolyfill from "node-datachannel/polyfill";
import { WebSocket as NodeWebSocket } from "ws";

export type InstallNodeDataChannelOptions = {
	force?: boolean;
};

/**
 * Installs node-datachannel's WebRTC polyfill and Node's WebSocket on globalThis
 * for Node.js / Bun usage. Call this once before constructing Peer instances.
 */
export function installNodeDataChannel(
	options: InstallNodeDataChannelOptions = {},
): void {
	const target = globalThis as typeof globalThis & Record<string, unknown>;
	const force = options.force === true;
	const polyfill: any = nodeDataChannelPolyfill;

	installGlobal(target, "RTCPeerConnection", polyfill.RTCPeerConnection, force);
	installGlobal(
		target,
		"RTCSessionDescription",
		polyfill.RTCSessionDescription,
		force,
	);
	installGlobal(target, "RTCIceCandidate", polyfill.RTCIceCandidate, force);
	installGlobal(target, "RTCDataChannel", polyfill.RTCDataChannel, force);
	installGlobal(
		target,
		"RTCDataChannelEvent",
		polyfill.RTCDataChannelEvent,
		force,
	);
	installGlobal(
		target,
		"RTCPeerConnectionIceEvent",
		polyfill.RTCPeerConnectionIceEvent,
		force,
	);

	installGlobal(target, "WebSocket", NodeWebSocket as any, force);
}

function installGlobal(
	target: Record<string, unknown>,
	name: string,
	value: unknown,
	force: boolean,
): void {
	if (force || target[name] === undefined) {
		target[name] = value;
	}
}
