export function formatMoney(amount: number): string {
	const format = Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		currencyDisplay: "narrowSymbol",
		trailingZeroDisplay: "stripIfInteger",
	});
	return format.format(amount);
}
