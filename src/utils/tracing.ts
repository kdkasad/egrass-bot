import * as Sentry from "@sentry/bun";

export function traced(op = "function") {
	return function <This, Args extends unknown[], Return>(
		target: (this: This, ...args: Args) => Promise<Return>,
		context: ClassMethodDecoratorContext<This>,
	) {
		return function (this: This, ...args: Args): Promise<Return> {
			const name = `${(this as any).constructor.name}.${String(context.name)}`;
			return Sentry.startSpan({ name, op }, () =>
				Sentry.withScope((scope) => {
					scope.setContext("service", {
						name: (this as any).constructor.name,
						method: String(context.name),
					});
					scope.setAttributes({
						"service.name": (this as any).constructor.name,
						"service.method": String(context.name),
					});
					return target.apply(this, args);
				}),
			);
		};
	};
}
