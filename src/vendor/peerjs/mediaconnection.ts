import { util } from "./util";
import logger from "./logger";
import { Negotiator } from "./negotiator";
import { ConnectionType, ServerMessageType } from "./enums";
import type { Peer } from "./peer";
import { BaseConnection, type BaseConnectionEvents } from "./baseconnection";
import type { ServerMessage } from "./servermessage";
import type { AnswerOption } from "./optionInterfaces";

export interface MediaConnectionEvents extends BaseConnectionEvents<never> {
	stream: (stream: any) => void;
	willCloseOnRemote: () => void;
}

export class MediaConnection extends BaseConnection<MediaConnectionEvents> {
	private static readonly ID_PREFIX = "mc_";

	private _negotiator: Negotiator<MediaConnectionEvents, this> | null;
	private _localStream: any;
	private _remoteStream: any;

	get type() {
		return ConnectionType.Media;
	}

	get localStream(): any {
		return this._localStream;
	}

	get remoteStream(): any {
		return this._remoteStream;
	}

	constructor(peerId: string, provider: Peer, options: any) {
		super(peerId, provider, options);

		this._localStream = this.options._stream;
		this.connectionId =
			this.options.connectionId ||
			MediaConnection.ID_PREFIX + util.randomToken();

		this._negotiator = new Negotiator(this);

		if (this._localStream) {
			this._negotiator.startConnection({
				_stream: this._localStream,
				originator: true,
			});
		}
	}

	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} dc connection success`);
			(this as any).emit("willCloseOnRemote");
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
			this.close();
		};
	}
	addStream(remoteStream: any) {
		logger.log("Receiving stream", remoteStream);
		this._remoteStream = remoteStream;
		(this as any).emit("stream", remoteStream);
	}

	handleMessage(message: ServerMessage): void {
		const type = message.type;
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				void this._negotiator!.handleSDP(type, payload.sdp);
				this._open = true;
				break;
			case ServerMessageType.Candidate:
				void this._negotiator!.handleCandidate(payload.candidate);
				break;
			default:
				logger.warn(`Unrecognized message type:${type} from peer:${this.peer}`);
				break;
		}
	}

	answer(stream?: any, options: AnswerOption = {}): void {
		if (this._localStream) {
			logger.warn(
				"Local stream already exists on this MediaConnection. Are you answering a call twice?",
			);
			return;
		}

		this._localStream = stream;

		if (options && options.sdpTransform) {
			this.options.sdpTransform = options.sdpTransform;
		}

		this._negotiator!.startConnection({
			...this.options._payload,
			_stream: stream,
		});
		const messages = (this.provider as any)._getMessages(this.connectionId);

		for (const message of messages) {
			this.handleMessage(message);
		}

		this._open = true;
	}

	close(): void {
		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		this._localStream = null;
		this._remoteStream = null;

		if (this.provider) {
			(this.provider as any)._removeConnection(this);
			this.provider = null;
		}

		if (this.options && this.options._stream) {
			this.options._stream = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		(this as any).emit("close");
	}
}
