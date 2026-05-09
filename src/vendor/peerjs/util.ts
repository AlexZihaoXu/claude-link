import { BinaryPackChunker } from "./dataconnection/BufferedConnection/binaryPackChunker";
import * as BinaryPack from "peerjs-js-binarypack";
import { Supports } from "./supports";
import { validateId } from "./utils/validateId";
import { randomToken } from "./utils/randomToken";

export interface UtilSupportsObj {
	browser: boolean;
	webRTC: boolean;
	audioVideo: boolean;
	data: boolean;
	binaryBlob: boolean;
	reliable: boolean;
}

const DEFAULT_CONFIG = {
	iceServers: [
		{ urls: "stun:stun.l.google.com:19302" },
		{
			urls: [
				"turn:eu-0.turn.peerjs.com:3478",
				"turn:us-0.turn.peerjs.com:3478",
			],
			username: "peerjs",
			credential: "peerjsp",
		},
	],
	sdpSemantics: "unified-plan",
};

export class Util extends BinaryPackChunker {
	noop(): void {}

	readonly CLOUD_HOST = "0.peerjs.com";
	readonly CLOUD_PORT = 443;

	readonly chunkedBrowsers = { Chrome: 1, chrome: 1 };

	readonly defaultConfig = DEFAULT_CONFIG;

	readonly browser = Supports.getBrowser();
	readonly browserVersion = Supports.getVersion();

	pack = (BinaryPack as any).pack;
	unpack = (BinaryPack as any).unpack;

	get supports(): UtilSupportsObj {
		const supported: UtilSupportsObj = {
			browser: Supports.isBrowserSupported(),
			webRTC: Supports.isWebRTCSupported(),
			audioVideo: false,
			data: false,
			binaryBlob: false,
			reliable: false,
		};

		if (!supported.webRTC) return supported;

		let pc: RTCPeerConnection | undefined;

		try {
			pc = new RTCPeerConnection(DEFAULT_CONFIG as any);

			supported.audioVideo = true;

			let dc: RTCDataChannel | undefined;

			try {
				dc = pc.createDataChannel("_PEERJSTEST", { ordered: true });
				supported.data = true;
				supported.reliable = !!dc.ordered;

				try {
					(dc as any).binaryType = "blob";
					supported.binaryBlob = !Supports.isIOS;
				} catch (e) {}
			} catch (e) {
			} finally {
				if (dc) {
					dc.close();
				}
			}
		} catch (e) {
		} finally {
			if (pc) {
				pc.close();
			}
		}

		return supported;
	}

	validateId = validateId;
	randomToken = randomToken;

	blobToArrayBuffer(
		blob: Blob,
		cb: (arg: ArrayBuffer | null) => void,
	): FileReader {
		const fr = new FileReader();

		fr.onload = function (evt) {
			if (evt.target) {
				cb(evt.target.result as ArrayBuffer);
			}
		};

		fr.readAsArrayBuffer(blob);

		return fr;
	}

	binaryStringToArrayBuffer(binary: string): ArrayBuffer | SharedArrayBuffer {
		const byteArray = new Uint8Array(binary.length);

		for (let i = 0; i < binary.length; i++) {
			byteArray[i] = binary.charCodeAt(i) & 0xff;
		}

		return byteArray.buffer;
	}
	isSecure(): boolean {
		return typeof location !== "undefined" && location.protocol === "https:";
	}
}

export const util = new Util();
