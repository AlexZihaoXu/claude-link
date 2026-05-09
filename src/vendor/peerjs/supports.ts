// claude-link: replaces upstream's webrtc-adapter dependency. We always run
// under Node/Bun with node-datachannel installed, so we hardcode "supported".
export const Supports = new (class {
	readonly isIOS = false;
	readonly supportedBrowsers = ["node"];

	readonly minFirefoxVersion = 0;
	readonly minChromeVersion = 0;
	readonly minSafariVersion = 0;

	isWebRTCSupported(): boolean {
		return typeof RTCPeerConnection !== "undefined";
	}

	isBrowserSupported(): boolean {
		return this.isWebRTCSupported();
	}

	getBrowser(): string {
		return "node";
	}

	getVersion(): number {
		return 0;
	}

	isUnifiedPlanSupported(): boolean {
		return true;
	}

	toString(): string {
		return `Supports:
    browser:${this.getBrowser()}
    version:${this.getVersion()}
    isIOS:${this.isIOS}
    isWebRTCSupported:${this.isWebRTCSupported()}
    isBrowserSupported:${this.isBrowserSupported()}
    isUnifiedPlanSupported:${this.isUnifiedPlanSupported()}`;
	}
})();
