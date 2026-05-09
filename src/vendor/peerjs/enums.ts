export enum ConnectionType {
	Data = "data",
	Media = "media",
}

export enum PeerErrorType {
	BrowserIncompatible = "browser-incompatible",
	Disconnected = "disconnected",
	InvalidID = "invalid-id",
	InvalidKey = "invalid-key",
	Network = "network",
	PeerUnavailable = "peer-unavailable",
	SslUnavailable = "ssl-unavailable",
	ServerError = "server-error",
	SocketError = "socket-error",
	SocketClosed = "socket-closed",
	UnavailableID = "unavailable-id",
	WebRTC = "webrtc",
}

export enum BaseConnectionErrorType {
	NegotiationFailed = "negotiation-failed",
	ConnectionClosed = "connection-closed",
}

export enum DataConnectionErrorType {
	NotOpenYet = "not-open-yet",
	MessageToBig = "message-too-big",
}

export enum SerializationType {
	Binary = "binary",
	BinaryUTF8 = "binary-utf8",
	JSON = "json",
	None = "raw",
}

export enum SocketEventType {
	Message = "message",
	Disconnected = "disconnected",
	Error = "error",
	Close = "close",
}

export enum ServerMessageType {
	Heartbeat = "HEARTBEAT",
	Candidate = "CANDIDATE",
	Offer = "OFFER",
	Answer = "ANSWER",
	Open = "OPEN",
	Error = "ERROR",
	IdTaken = "ID-TAKEN",
	InvalidKey = "INVALID-KEY",
	Leave = "LEAVE",
	Expire = "EXPIRE",
}
