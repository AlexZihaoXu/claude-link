import { util } from "./util";
import logger, { LogLevel } from "./logger";
import { Socket } from "./socket";
import { MediaConnection } from "./mediaconnection";
import type { DataConnection } from "./dataconnection/DataConnection";
import {
	ConnectionType,
	PeerErrorType,
	ServerMessageType,
	SocketEventType,
} from "./enums";
import type { ServerMessage } from "./servermessage";
import { API } from "./api";
import type {
	CallOption,
	PeerConnectOption,
	PeerJSOption,
} from "./optionInterfaces";
import { BinaryPack } from "./dataconnection/BufferedConnection/BinaryPack";
import { Raw } from "./dataconnection/BufferedConnection/Raw";
import { Json } from "./dataconnection/BufferedConnection/Json";

import { EventEmitterWithError, PeerError } from "./peerError";

class PeerOptions implements PeerJSOption {
	debug?: LogLevel;
	host?: string;
	port?: number;
	path?: string;
	key?: string;
	token?: string;
	config?: any;
	secure?: boolean;
	pingInterval?: number;
	referrerPolicy?: ReferrerPolicy;
	logFunction?: (logLevel: LogLevel, ...rest: any[]) => void;
	serializers?: SerializerMapping;
}

export { type PeerOptions };

export interface SerializerMapping {
	[key: string]: new (
		peerId: string,
		provider: Peer,
		options: any,
	) => DataConnection;
}

export interface PeerEvents {
	open: (id: string) => void;
	connection: (dataConnection: DataConnection) => void;
	call: (mediaConnection: MediaConnection) => void;
	close: () => void;
	disconnected: (currentId: string) => void;
	error: (error: PeerError<`${PeerErrorType}`>) => void;
}

export class Peer extends EventEmitterWithError<PeerErrorType, PeerEvents> {
	private static readonly DEFAULT_KEY = "peerjs";

	protected readonly _serializers: SerializerMapping = {
		raw: Raw,
		json: Json,
		binary: BinaryPack,
		"binary-utf8": BinaryPack,

		default: BinaryPack,
	};
	private readonly _options: PeerOptions;
	private readonly _api: API;
	private readonly _socket: Socket;

	private _id: string | null = null;
	private _lastServerId: string | null = null;

	private _destroyed = false;
	private _disconnected = false;
	private _open = false;
	private readonly _connections: Map<
		string,
		(DataConnection | MediaConnection)[]
	> = new Map();
	private readonly _lostMessages: Map<string, ServerMessage[]> = new Map();
	get id() {
		return this._id;
	}

	get options() {
		return this._options;
	}

	get open() {
		return this._open;
	}

	get socket() {
		return this._socket;
	}

	get connections(): Object {
		const plainConnections = Object.create(null);

		for (const [k, v] of this._connections) {
			plainConnections[k] = v;
		}

		return plainConnections;
	}

	get destroyed() {
		return this._destroyed;
	}
	get disconnected() {
		return this._disconnected;
	}

	constructor();
	constructor(options: PeerOptions);
	constructor(id: string, options?: PeerOptions);

	constructor(id?: string | PeerOptions, options?: PeerOptions) {
		super();

		let userId: string | undefined;

		if (id && id.constructor == Object) {
			options = id as PeerOptions;
		} else if (id) {
			userId = id.toString();
		}

		options = {
			debug: 0,
			host: util.CLOUD_HOST,
			port: util.CLOUD_PORT,
			path: "/",
			key: Peer.DEFAULT_KEY,
			token: util.randomToken(),
			config: util.defaultConfig,
			referrerPolicy: "strict-origin-when-cross-origin" as ReferrerPolicy,
			serializers: {},
			...options,
		};
		this._options = options;
		this._serializers = { ...this._serializers, ...this.options.serializers };

		if (this._options.host === "/") {
			this._options.host = (globalThis as any).window?.location?.hostname;
		}

		if (this._options.path) {
			if (this._options.path[0] !== "/") {
				this._options.path = "/" + this._options.path;
			}
			if (this._options.path[this._options.path.length - 1] !== "/") {
				this._options.path += "/";
			}
		}

		if (
			this._options.secure === undefined &&
			this._options.host !== util.CLOUD_HOST
		) {
			this._options.secure = util.isSecure();
		} else if (this._options.host == util.CLOUD_HOST) {
			this._options.secure = true;
		}
		if (this._options.logFunction) {
			logger.setLogFunction(this._options.logFunction);
		}

		logger.logLevel = this._options.debug || 0;

		this._api = new API(options);
		this._socket = this._createServerConnection();

		if (!util.supports.audioVideo && !util.supports.data) {
			this._delayedAbort(
				PeerErrorType.BrowserIncompatible,
				"The current browser does not support WebRTC",
			);
			return;
		}

		if (!!userId && !util.validateId(userId)) {
			this._delayedAbort(PeerErrorType.InvalidID, `ID "${userId}" is invalid`);
			return;
		}

		if (userId) {
			this._initialize(userId);
		} else {
			this._api
				.retrieveId()
				.then((id) => this._initialize(id))
				.catch((error) => this._abort(PeerErrorType.ServerError, error));
		}
	}

	private _createServerConnection(): Socket {
		const socket = new Socket(
			this._options.secure,
			this._options.host!,
			this._options.port!,
			this._options.path!,
			this._options.key!,
			this._options.pingInterval,
		);

		socket.on(SocketEventType.Message, (data: ServerMessage) => {
			this._handleMessage(data);
		});

		socket.on(SocketEventType.Error, (error: string) => {
			this._abort(PeerErrorType.SocketError, error);
		});

		socket.on(SocketEventType.Disconnected, () => {
			if (this.disconnected) {
				return;
			}

			this.emitError(PeerErrorType.Network, "Lost connection to server.");
			this.disconnect();
		});

		socket.on(SocketEventType.Close, () => {
			if (this.disconnected) {
				return;
			}

			this._abort(
				PeerErrorType.SocketClosed,
				"Underlying socket is already closed.",
			);
		});

		return socket;
	}

	private _initialize(id: string): void {
		this._id = id;
		this.socket.start(id, this._options.token!);
	}

	private _handleMessage(message: ServerMessage): void {
		const type = message.type;
		const payload = message.payload;
		const peerId = message.src;

		switch (type) {
			case ServerMessageType.Open:
				this._lastServerId = this.id;
				this._open = true;
				(this as any).emit("open", this.id);
				break;
			case ServerMessageType.Error:
				this._abort(PeerErrorType.ServerError, payload.msg);
				break;
			case ServerMessageType.IdTaken:
				this._abort(PeerErrorType.UnavailableID, `ID "${this.id}" is taken`);
				break;
			case ServerMessageType.InvalidKey:
				this._abort(
					PeerErrorType.InvalidKey,
					`API KEY "${this._options.key}" is invalid`,
				);
				break;
			case ServerMessageType.Leave:
				logger.log(`Received leave message from ${peerId}`);
				this._cleanupPeer(peerId);
				this._connections.delete(peerId);
				break;
			case ServerMessageType.Expire:
				this.emitError(
					PeerErrorType.PeerUnavailable,
					`Could not connect to peer ${peerId}`,
				);
				break;
			case ServerMessageType.Offer: {
				const connectionId = payload.connectionId;
				let connection = this.getConnection(peerId, connectionId);

				if (connection) {
					connection.close();
					logger.warn(
						`Offer received for existing Connection ID:${connectionId}`,
					);
				}

				if (payload.type === ConnectionType.Media) {
					const mediaConnection = new MediaConnection(peerId, this, {
						connectionId: connectionId,
						_payload: payload,
						metadata: payload.metadata,
					});
					connection = mediaConnection;
					this._addConnection(peerId, connection);
					(this as any).emit("call", mediaConnection);
				} else if (payload.type === ConnectionType.Data) {
					const dataConnection = new this._serializers[payload.serialization](
						peerId,
						this,
						{
							connectionId: connectionId,
							_payload: payload,
							metadata: payload.metadata,
							label: payload.label,
							serialization: payload.serialization,
							reliable: payload.reliable,
						},
					);
					connection = dataConnection;

					this._addConnection(peerId, connection);
					(this as any).emit("connection", dataConnection);
				} else {
					logger.warn(`Received malformed connection type:${payload.type}`);
					return;
				}

				const messages = this._getMessages(connectionId);
				for (const message of messages) {
					connection.handleMessage(message);
				}

				break;
			}
			default: {
				if (!payload) {
					logger.warn(
						`You received a malformed message from ${peerId} of type ${type}`,
					);
					return;
				}

				const connectionId = payload.connectionId;
				const connection = this.getConnection(peerId, connectionId);

				if (connection && connection.peerConnection) {
					connection.handleMessage(message);
				} else if (connectionId) {
					this._storeMessage(connectionId, message);
				} else {
					logger.warn("You received an unrecognized message:", message);
				}
				break;
			}
		}
	}

	private _storeMessage(connectionId: string, message: ServerMessage): void {
		if (!this._lostMessages.has(connectionId)) {
			this._lostMessages.set(connectionId, []);
		}

		this._lostMessages.get(connectionId)!.push(message);
	}

	public _getMessages(connectionId: string): ServerMessage[] {
		const messages = this._lostMessages.get(connectionId);

		if (messages) {
			this._lostMessages.delete(connectionId);
			return messages;
		}

		return [];
	}

	connect(peer: string, options: PeerConnectOption = {}): DataConnection | undefined {
		options = {
			serialization: "default",
			...options,
		};
		if (this.disconnected) {
			logger.warn(
				"You cannot connect to a new Peer because you called " +
					".disconnect() on this Peer and ended your connection with the " +
					"server. You can create a new Peer to reconnect, or call reconnect " +
					"on this peer if you believe its ID to still be available.",
			);
			this.emitError(
				PeerErrorType.Disconnected,
				"Cannot connect to new Peer after disconnecting from server.",
			);
			return;
		}

		const dataConnection = new this._serializers[options.serialization!](
			peer,
			this,
			options,
		);
		this._addConnection(peer, dataConnection);
		return dataConnection;
	}

	call(
		peer: string,
		stream: any,
		options: CallOption = {},
	): MediaConnection | undefined {
		if (this.disconnected) {
			logger.warn(
				"You cannot connect to a new Peer because you called " +
					".disconnect() on this Peer and ended your connection with the " +
					"server. You can create a new Peer to reconnect.",
			);
			this.emitError(
				PeerErrorType.Disconnected,
				"Cannot connect to new Peer after disconnecting from server.",
			);
			return;
		}

		if (!stream) {
			logger.error(
				"To call a peer, you must provide a stream from your browser's `getUserMedia`.",
			);
			return;
		}

		const mediaConnection = new MediaConnection(peer, this, {
			...options,
			_stream: stream,
		});
		this._addConnection(peer, mediaConnection);
		return mediaConnection;
	}

	private _addConnection(
		peerId: string,
		connection: MediaConnection | DataConnection,
	): void {
		logger.log(
			`add connection ${connection.type}:${connection.connectionId} to peerId:${peerId}`,
		);

		if (!this._connections.has(peerId)) {
			this._connections.set(peerId, []);
		}
		this._connections.get(peerId)!.push(connection);
	}

	_removeConnection(connection: DataConnection | MediaConnection): void {
		const connections = this._connections.get(connection.peer);

		if (connections) {
			const index = connections.indexOf(connection);

			if (index !== -1) {
				connections.splice(index, 1);
			}
		}

		this._lostMessages.delete(connection.connectionId);
	}

	getConnection(
		peerId: string,
		connectionId: string,
	): null | DataConnection | MediaConnection {
		const connections = this._connections.get(peerId);
		if (!connections) {
			return null;
		}

		for (const connection of connections) {
			if (connection.connectionId === connectionId) {
				return connection;
			}
		}

		return null;
	}

	private _delayedAbort(type: PeerErrorType, message: string | Error): void {
		setTimeout(() => {
			this._abort(type, message);
		}, 0);
	}

	private _abort(type: PeerErrorType, message: string | Error): void {
		logger.error("Aborting!");

		this.emitError(type, message);

		if (!this._lastServerId) {
			this.destroy();
		} else {
			this.disconnect();
		}
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}

		logger.log(`Destroy peer with ID:${this.id}`);

		this.disconnect();
		this._cleanup();

		this._destroyed = true;

		(this as any).emit("close");
	}

	private _cleanup(): void {
		for (const peerId of this._connections.keys()) {
			this._cleanupPeer(peerId);
			this._connections.delete(peerId);
		}

		this.socket.removeAllListeners();
	}

	private _cleanupPeer(peerId: string): void {
		const connections = this._connections.get(peerId);

		if (!connections) return;

		for (const connection of connections) {
			connection.close();
		}
	}

	disconnect(): void {
		if (this.disconnected) {
			return;
		}

		const currentId = this.id;

		logger.log(`Disconnect peer with ID:${currentId}`);

		this._disconnected = true;
		this._open = false;

		this.socket.close();

		this._lastServerId = currentId;
		this._id = null;

		(this as any).emit("disconnected", currentId);
	}

	reconnect(): void {
		if (this.disconnected && !this.destroyed) {
			logger.log(
				`Attempting reconnection to server with ID ${this._lastServerId}`,
			);
			this._disconnected = false;
			this._initialize(this._lastServerId!);
		} else if (this.destroyed) {
			throw new Error(
				"This peer cannot reconnect to the server. It has already been destroyed.",
			);
		} else if (!this.disconnected && !this.open) {
			logger.error(
				"In a hurry? We're still trying to make the initial connection!",
			);
		} else {
			throw new Error(
				`Peer ${this.id} cannot reconnect because it is not disconnected from the server!`,
			);
		}
	}

	listAllPeers(cb = (_: any[]) => {}): void {
		this._api
			.listAllPeers()
			.then((peers) => cb(peers))
			.catch((error) => this._abort(PeerErrorType.ServerError, error));
	}
}
