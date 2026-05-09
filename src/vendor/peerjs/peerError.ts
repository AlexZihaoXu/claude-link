import { EventEmitter } from "eventemitter3";
import logger from "./logger";

export interface EventsWithError<ErrorType extends string> {
	error: (error: PeerError<`${ErrorType}`>) => void;
}

export class EventEmitterWithError<
	ErrorType extends string,
	Events extends EventsWithError<ErrorType>,
> extends EventEmitter<Events, never> {
	emitError(type: ErrorType, err: string | Error): void {
		logger.error("Error:", err);
		// @ts-ignore
		this.emit("error", new PeerError<`${ErrorType}`>(`${type}`, err));
	}
}

export class PeerError<T extends string> extends Error {
	constructor(type: T, err: Error | string) {
		if (typeof err === "string") {
			super(err);
		} else {
			super();
			Object.assign(this, err);
		}
		this.type = type;
	}
	public type: T;
}
