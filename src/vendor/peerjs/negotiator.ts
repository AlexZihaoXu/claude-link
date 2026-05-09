import logger from "./logger";
import type { MediaConnection } from "./mediaconnection";
import type { DataConnection } from "./dataconnection/DataConnection";
import {
	BaseConnectionErrorType,
	ConnectionType,
	PeerErrorType,
	ServerMessageType,
} from "./enums";
import type { BaseConnection, BaseConnectionEvents } from "./baseconnection";
import type { ValidEventTypes } from "eventemitter3";

export class Negotiator<
	Events extends ValidEventTypes,
	ConnectionT extends BaseConnection<Events | BaseConnectionEvents>,
> {
	constructor(readonly connection: ConnectionT) {}

	startConnection(options: any) {
		const peerConnection = this._startPeerConnection();

		this.connection.peerConnection = peerConnection;

		if (this.connection.type === ConnectionType.Media && options._stream) {
			this._addTracksToConnection(options._stream, peerConnection);
		}

		if (options.originator) {
			const dataConnection = this.connection as unknown as DataConnection;

			const config: RTCDataChannelInit = { ordered: !!options.reliable };

			const dataChannel = peerConnection.createDataChannel(
				dataConnection.label,
				config,
			);
			dataConnection._initializeDataChannel(dataChannel);

			void this._makeOffer();
		} else {
			void this.handleSDP("OFFER", options.sdp);
		}
	}

	private _startPeerConnection(): RTCPeerConnection {
		logger.log("Creating RTCPeerConnection.");

		const peerConnection = new RTCPeerConnection(
			(this.connection.provider as any).options.config,
		);

		this._setupListeners(peerConnection);

		return peerConnection;
	}

	private _setupListeners(peerConnection: RTCPeerConnection) {
		const peerId = this.connection.peer;
		const connectionId = this.connection.connectionId;
		const connectionType = this.connection.type;
		const provider = this.connection.provider as any;

		logger.log("Listening for ICE candidates.");

		peerConnection.onicecandidate = (evt) => {
			if (!evt.candidate || !evt.candidate.candidate) return;

			logger.log(`Received ICE candidates for ${peerId}:`, evt.candidate);

			provider.socket.send({
				type: ServerMessageType.Candidate,
				payload: {
					candidate: evt.candidate,
					type: connectionType,
					connectionId: connectionId,
				},
				dst: peerId,
			});
		};

		peerConnection.oniceconnectionstatechange = () => {
			switch (peerConnection.iceConnectionState) {
				case "failed":
					logger.log(
						"iceConnectionState is failed, closing connections to " + peerId,
					);
					(this.connection as any).emitError(
						BaseConnectionErrorType.NegotiationFailed,
						"Negotiation of connection to " + peerId + " failed.",
					);
					this.connection.close();
					break;
				case "closed":
					logger.log(
						"iceConnectionState is closed, closing connections to " + peerId,
					);
					(this.connection as any).emitError(
						BaseConnectionErrorType.ConnectionClosed,
						"Connection to " + peerId + " closed.",
					);
					this.connection.close();
					break;
				case "disconnected":
					logger.log(
						"iceConnectionState changed to disconnected on the connection with " +
							peerId,
					);
					break;
				case "completed":
					peerConnection.onicecandidate = () => {};
					break;
			}

			(this.connection as any).emit(
				"iceStateChanged",
				peerConnection.iceConnectionState,
			);
		};

		logger.log("Listening for data channel");
		peerConnection.ondatachannel = (evt) => {
			logger.log("Received data channel");

			const dataChannel = evt.channel;
			const connection = <DataConnection>(
				provider.getConnection(peerId, connectionId)
			);

			connection._initializeDataChannel(dataChannel);
		};

		logger.log("Listening for remote stream");

		peerConnection.ontrack = (evt) => {
			logger.log("Received remote stream");

			const stream = (evt as any).streams[0];
			const connection = provider.getConnection(peerId, connectionId);

			if (connection.type === ConnectionType.Media) {
				const mediaConnection = <MediaConnection>connection;

				this._addStreamToMediaConnection(stream, mediaConnection);
			}
		};
	}

	cleanup(): void {
		logger.log("Cleaning up PeerConnection to " + this.connection.peer);

		const peerConnection = this.connection.peerConnection;

		if (!peerConnection) {
			return;
		}

		this.connection.peerConnection = null as any;

		peerConnection.onicecandidate =
			peerConnection.oniceconnectionstatechange =
			peerConnection.ondatachannel =
			peerConnection.ontrack =
				() => {};

		const peerConnectionNotClosed = peerConnection.signalingState !== "closed";
		let dataChannelNotClosed = false;

		const dataChannel = this.connection.dataChannel;

		if (dataChannel) {
			dataChannelNotClosed =
				!!dataChannel.readyState && dataChannel.readyState !== "closed";
		}

		if (peerConnectionNotClosed || dataChannelNotClosed) {
			peerConnection.close();
		}
	}

	private async _makeOffer(): Promise<void> {
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider as any;

		try {
			const offer = await peerConnection.createOffer(
				(this.connection as any).options.constraints,
			);

			logger.log("Created offer.");

			if (
				(this.connection as any).options.sdpTransform &&
				typeof (this.connection as any).options.sdpTransform === "function"
			) {
				offer.sdp =
					(this.connection as any).options.sdpTransform(offer.sdp) || offer.sdp;
			}

			try {
				await peerConnection.setLocalDescription(offer);

				logger.log(
					"Set localDescription:",
					offer,
					`for:${this.connection.peer}`,
				);

				let payload: any = {
					sdp: offer,
					type: this.connection.type,
					connectionId: this.connection.connectionId,
					metadata: this.connection.metadata,
				};

				if (this.connection.type === ConnectionType.Data) {
					const dataConnection = <DataConnection>(<unknown>this.connection);

					payload = {
						...payload,
						label: dataConnection.label,
						reliable: dataConnection.reliable,
						serialization: dataConnection.serialization,
					};
				}

				provider.socket.send({
					type: ServerMessageType.Offer,
					payload,
					dst: this.connection.peer,
				});
			} catch (err: any) {
				if (
					err !=
					"OperationError: Failed to set local offer sdp: Called in wrong state: kHaveRemoteOffer"
				) {
					provider.emitError(PeerErrorType.WebRTC, err);
					logger.log("Failed to setLocalDescription, ", err);
				}
			}
		} catch (err_1: any) {
			provider.emitError(PeerErrorType.WebRTC, err_1);
			logger.log("Failed to createOffer, ", err_1);
		}
	}

	private async _makeAnswer(): Promise<void> {
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider as any;

		try {
			const answer = await peerConnection.createAnswer();
			logger.log("Created answer.");

			if (
				(this.connection as any).options.sdpTransform &&
				typeof (this.connection as any).options.sdpTransform === "function"
			) {
				answer.sdp =
					(this.connection as any).options.sdpTransform(answer.sdp) || answer.sdp;
			}

			try {
				await peerConnection.setLocalDescription(answer);

				logger.log(
					`Set localDescription:`,
					answer,
					`for:${this.connection.peer}`,
				);

				provider.socket.send({
					type: ServerMessageType.Answer,
					payload: {
						sdp: answer,
						type: this.connection.type,
						connectionId: this.connection.connectionId,
					},
					dst: this.connection.peer,
				});
			} catch (err: any) {
				provider.emitError(PeerErrorType.WebRTC, err);
				logger.log("Failed to setLocalDescription, ", err);
			}
		} catch (err_1: any) {
			provider.emitError(PeerErrorType.WebRTC, err_1);
			logger.log("Failed to create answer, ", err_1);
		}
	}

	async handleSDP(type: string, sdp: any): Promise<void> {
		sdp = new RTCSessionDescription(sdp);
		const peerConnection = this.connection.peerConnection;
		const provider = this.connection.provider as any;

		logger.log("Setting remote description", sdp);

		const self = this;

		try {
			await peerConnection.setRemoteDescription(sdp);
			logger.log(`Set remoteDescription:${type} for:${this.connection.peer}`);
			if (type === "OFFER") {
				await self._makeAnswer();
			}
		} catch (err: any) {
			provider.emitError(PeerErrorType.WebRTC, err);
			logger.log("Failed to setRemoteDescription, ", err);
		}
	}

	async handleCandidate(ice: RTCIceCandidate) {
		logger.log(`handleCandidate:`, ice);

		try {
			await this.connection.peerConnection.addIceCandidate(ice);
			logger.log(`Added ICE candidate for:${this.connection.peer}`);
		} catch (err: any) {
			((this.connection as any).provider as any).emitError(PeerErrorType.WebRTC, err);
			logger.log("Failed to handleCandidate, ", err);
		}
	}

	private _addTracksToConnection(
		stream: any,
		peerConnection: RTCPeerConnection,
	): void {
		logger.log(`add tracks from stream ${stream.id} to peer connection`);

		if (!peerConnection.addTrack) {
			return logger.error(
				`Your browser does't support RTCPeerConnection#addTrack. Ignored.`,
			);
		}

		stream.getTracks().forEach((track: any) => {
			peerConnection.addTrack(track, stream);
		});
	}

	private _addStreamToMediaConnection(
		stream: any,
		mediaConnection: MediaConnection,
	): void {
		logger.log(
			`add stream ${stream.id} to media connection ${mediaConnection.connectionId}`,
		);

		(mediaConnection as any).addStream(stream);
	}
}
