import type { Peer } from "./peer";
import type { ServerMessage } from "./servermessage";
import type { ConnectionType } from "./enums";
import { BaseConnectionErrorType } from "./enums";
import {
	EventEmitterWithError,
	type EventsWithError,
	PeerError,
} from "./peerError";
import type { ValidEventTypes } from "eventemitter3";

export interface BaseConnectionEvents<
	ErrorType extends string = BaseConnectionErrorType,
> extends EventsWithError<ErrorType> {
	close: () => void;
	error: (error: PeerError<`${ErrorType}`>) => void;
	iceStateChanged: (state: RTCIceConnectionState) => void;
}

export abstract class BaseConnection<
	SubClassEvents extends ValidEventTypes,
	ErrorType extends string = never,
> extends EventEmitterWithError<
	ErrorType | BaseConnectionErrorType,
	SubClassEvents & BaseConnectionEvents<BaseConnectionErrorType | ErrorType>
> {
	protected _open = false;

	readonly metadata: any;
	connectionId!: string;

	peerConnection!: RTCPeerConnection;
	dataChannel!: RTCDataChannel;

	abstract get type(): ConnectionType;

	label!: string;

	get open() {
		return this._open;
	}

	protected constructor(
		readonly peer: string,
		public provider: Peer | null,
		readonly options: any,
	) {
		super();
		this.metadata = options.metadata;
	}

	abstract close(): void;

	abstract handleMessage(message: ServerMessage): void;

	abstract _initializeDataChannel(dc: RTCDataChannel): void;
}
