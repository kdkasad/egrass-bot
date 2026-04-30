import type { EnvService } from "../services/env";

export class Service {
	_name: string;

	constructor() {
		this._name = this.constructor.name;
	}
}

export class Feature extends Service {
	protected env: EnvService;
	constructor(env: EnvService) {
		super();
		this.env = env;
	}

	protected isEnabled() {
		return !(
			this.env.vars.DISABLED_FEATURES.has(
				this._name.replace(/(Service|Feature)$/, "").toLowerCase(),
			) || this.env.vars.DISABLED_FEATURES.has(this._name)
		);
	}

	protected static allEnabled(services: Service[]): boolean {
		return services.every((s) => (s instanceof Feature ? s.isEnabled() : true));
	}
}
