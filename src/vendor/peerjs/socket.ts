import { EventEmitter } from "eventemitter3";
import logger from "./logger";
import { ServerMessageType, SocketEventType } from "./enums";
import { version } from "./version";

export class Socket extends EventEmitter {
	private _disconnected: boolean = true;
	private _id?: string;
	private _messagesQueue: Array<object> = [];
	private _socket?: WebSocket;
	private _wsPingTimer?: any;
	private readonly _baseUrl: string;

	constructor(
		secure: any,
		host: string,
		port: number,
		path: string,
		key: string,
		private readonly pingInterval: number = 5000,
	) {
		super();

		const wsProtocol = secure ? "wss://" : "ws://";

		this._baseUrl = wsProtocol + host + ":" + port + path + "peerjs?key=" + key;
	}

	start(id: string, token: string): void {
		this._id = id;

		const wsUrl = `${this._baseUrl}&id=${id}&token=${token}`;

		if (!!this._socket || !this._disconnected) {
			return;
		}

		this._socket = new WebSocket(wsUrl + "&version=" + version);
		this._disconnected = false;

		this._socket.onmessage = (event: any) => {
			let data;

			try {
				data = JSON.parse(event.data);
				logger.log("Server message received:", data);
			} catch (e) {
				logger.log("Invalid server message", event.data);
				return;
			}

			this.emit(SocketEventType.Message, data);
		};

		this._socket.onclose = (event: any) => {
			if (this._disconnected) {
				return;
			}

			logger.log("Socket closed.", event);

			this._cleanup();
			this._disconnected = true;

			this.emit(SocketEventType.Disconnected);
		};

		this._socket.onopen = () => {
			if (this._disconnected) {
				return;
			}

			this._sendQueuedMessages();

			logger.log("Socket open");

			this._scheduleHeartbeat();
		};
	}

	private _scheduleHeartbeat(): void {
		this._wsPingTimer = setTimeout(() => {
			this._sendHeartbeat();
		}, this.pingInterval);
	}

	private _sendHeartbeat(): void {
		if (!this._wsOpen()) {
			logger.log(`Cannot send heartbeat, because socket closed`);
			return;
		}

		const message = JSON.stringify({ type: ServerMessageType.Heartbeat });

		this._socket!.send(message);

		this._scheduleHeartbeat();
	}

	private _wsOpen(): boolean {
		return !!this._socket && this._socket.readyState === 1;
	}

	private _sendQueuedMessages(): void {
		const copiedQueue = [...this._messagesQueue];
		this._messagesQueue = [];

		for (const message of copiedQueue) {
			this.send(message);
		}
	}

	send(data: any): void {
		if (this._disconnected) {
			return;
		}

		if (!this._id) {
			this._messagesQueue.push(data);
			return;
		}

		if (!data.type) {
			this.emit(SocketEventType.Error, "Invalid message");
			return;
		}

		if (!this._wsOpen()) {
			return;
		}

		const message = JSON.stringify(data);

		this._socket!.send(message);
	}

	close(): void {
		if (this._disconnected) {
			return;
		}

		this._cleanup();

		this._disconnected = true;
	}

	private _cleanup(): void {
		if (this._socket) {
			this._socket.onopen =
				this._socket.onmessage =
				this._socket.onclose =
					null;
			this._socket.close();
			this._socket = undefined;
		}

		clearTimeout(this._wsPingTimer!);
	}
}
