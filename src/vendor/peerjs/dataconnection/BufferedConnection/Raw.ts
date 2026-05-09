import { BufferedConnection } from "./BufferedConnection";
import { SerializationType } from "../../enums";

export class Raw extends BufferedConnection {
	readonly serialization = SerializationType.None;

	protected _handleDataMessage({ data }: any) {
		(this as any).emit("data", data);
	}

	override _send(data: any, _chunked: boolean) {
		this._bufferedSend(data);
	}
}
